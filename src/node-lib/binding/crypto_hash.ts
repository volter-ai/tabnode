/**
 * THE HASHES OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_hash.cc`
 * (Hash, HashJob, CShakeJob, oneShotDigest, getHashes, getCachedAliases), over its OpenSSL half
 * (native/node/crypto_hash.cc) and the engine device.
 *
 * Routing (ADR-0018 §5): a digest WebCrypto defines (SHA-1, SHA-256, SHA-384, SHA-512) of more than 4 KiB of input is
 * the device's `digest`, a synchronous call blocking on its descriptor and HashJob's asynchronous one in the poll
 * phase; every other digest (MD5, SHA-224, SHA-512/256, SHA-3, SHAKE, BLAKE2, RIPEMD-160, an XOF length, cSHAKE) and
 * every input of 4 KiB or less is OpenSSL's. A Hash learns its input's length only at `digest`, so a Hash of a
 * WebCrypto digest keeps its input until then and gives it to the side that answers it; a copy keeps a copy. The
 * device takes at most 1 MiB a call: a larger input is refused by the device's bound (engine_device.ts), by name.
 */
import { Buffer } from '../buffer-module';
import { address } from './libnode';
import { withBytes, withScratch, word } from './openssl';
import { engineCallAsync, engineCallSync } from './engine_device';
import {
  answer, checked, cppError, CryptoJob, decodeInput, deviceAnswersDigest, encodeBytes, glue, kCryptoJobWebCrypto, rethrow,
  toArrayBuffer, webCryptoDigest, bufferSource,
} from './crypto_util';

const hashes = new FinalizationRegistry<number>((hash) => glue().tabnode_hash_free(hash));

/** `use` with `text`'s UTF-8 (a NUL-terminated string) in the process's memory. */
function withName<T>(text: string, use: (at: number) => T): T { return withBytes(String(text), (at) => use(at)); }

/** GetDigestImplementation's cache write (crypto_hash.cc:205-216): the V8 half sets the id on the JS cache. */
function cacheId(cache: Record<string, number>, algorithm: string, id: number): void {
  if (id !== -1) cache[algorithm] = id;
}

/** Hash (crypto_hash.cc:326-450). */
export class Hash {
  private hash = 0;
  /** A WebCrypto digest's input, kept for `digest`'s routing; null where OpenSSL has every byte already. */
  private kept: Uint8Array[] | null = null;
  private keptLength = 0;
  private webcrypto: string | undefined;
  private digested: Buffer | undefined;

  /** Hash::New (343-372): a copy of `algorithm` where it is a Hash, else the digest it names. */
  constructor(algorithm: unknown, xofLen: unknown, algorithmId: number, cache: Record<string, number>) {
    const exports = glue();
    const orig = algorithm instanceof Hash ? algorithm : undefined;
    const hasXof = xofLen !== undefined;
    const name = orig ? '' : String(algorithm);
    const made = withScratch(4, (idAt) => withName(name, (nameAt) => {
      const at = address(exports.tabnode_hash_new(orig?.hash ?? 0, nameAt, orig ? -1 : algorithmId, idAt,
        hasXof ? 1 : 0, hasXof ? Number(xofLen) >>> 0 : 0));
      if (!orig) cacheId(cache, name, word(idAt) | 0);
      return at;
    }));
    rethrow();
    this.hash = made;
    hashes.register(this, made);
    this.webcrypto = orig ? orig.webcrypto : hasXof ? undefined : webCryptoDigest(name);
    if (this.webcrypto) {
      this.kept = orig?.kept ? orig.kept.map((chunk) => chunk.slice()) : [];
      this.keptLength = orig?.keptLength ?? 0;
    }
  }

  /** HashUpdate (398-421): the decoded input to OpenSSL's context, or kept for the routing. */
  update(data: unknown, encoding?: unknown): boolean {
    const bytes = decodeInput(data, encoding);
    if (bytes.byteLength > 0x7fffffff) throw cppError('ERR_OUT_OF_RANGE', 'data is too long');
    if (this.kept) {
      this.kept.push(bytes.slice());
      this.keptLength += bytes.byteLength;
      return true;
    }
    return this.feed(bytes);
  }

  private feed(bytes: Uint8Array): boolean {
    const exports = glue();
    return checked(withBytes(bytes, (at, length) => exports.tabnode_hash_update(this.hash, at, length))) === 1;
  }

  /** HashDigest (423-450): made once, by the device where it answers the input, else by OpenSSL. */
  digest(encoding?: unknown): Buffer | string {
    if (!this.digested) {
      if (this.kept && deviceAnswersDigest(this.webcrypto!, this.keptLength)) {
        const input = Buffer.concat(this.kept);
        this.kept = [];
        this.digested = Buffer.from(engineCallSync('digest', [this.webcrypto, input]) as ArrayBuffer);
      } else {
        if (this.kept) {
          const kept = this.kept;
          this.kept = null;
          for (const chunk of kept) this.feed(chunk);
        }
        const exports = glue();
        this.digested = Buffer.from(answer((lengthAt) => exports.tabnode_hash_digest(this.hash, lengthAt)));
      }
    }
    // StringBytes::Encode copies: each digest() answers a Buffer of its own.
    return encodeBytes(Buffer.from(this.digested), encoding === undefined ? 'buffer' : encoding);
  }
}

/** HashJob (HashTraits, 452-517): a WebCrypto digest above the bound is the device's `digest`. */
export class HashJob extends CryptoJob {
  private readonly input: Uint8Array;
  private readonly webcrypto: string | undefined;
  constructor(mode: number, algorithm: string, data: unknown, length?: number) {
    super(mode);
    this.input = bufferSource(data);
    const exports = glue();
    this.webcrypto = length === undefined && deviceAnswersDigest(algorithm, this.input.byteLength)
      ? webCryptoDigest(algorithm) : undefined;
    this.adopt(withName(algorithm, (nameAt) => withBytes(this.input, (at, size) =>
      exports.tabnode_hash_job_new(mode, nameAt, at, size, typeof length === 'number' && length >= 0 ? BigInt(length) : -1n))));
  }
  protected device() {
    if (!this.webcrypto) return undefined;
    const args = [this.webcrypto, this.input];
    return {
      call: (sync: boolean) => (sync ? engineCallSync('digest', args) : engineCallAsync('digest', args)),
      result: (value: unknown) => value,
    };
  }
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** CShakeJob (CShakeTraits, 778-874): OpenSSL's, WebCrypto having no cSHAKE. */
export class CShakeJob extends CryptoJob {
  constructor(mode: number, algorithm: string, data: unknown, functionName: unknown, customization: unknown,
    length: number) {
    super(mode);
    const exports = glue();
    const optional = (value: unknown, use: (at: number, size: number) => number): number =>
      (value === undefined ? use(0, 0) : withBytes(bufferSource(value), use));
    this.adopt(withName(algorithm, (nameAt) => withBytes(bufferSource(data), (at, size) =>
      optional(functionName, (fnAt, fnSize) => optional(customization, (cAt, cSize) =>
        exports.tabnode_cshake_job_new(mode, nameAt, at, size, fnAt, fnSize, cAt, cSize, length >>> 0))))));
  }
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** Hash::OneShotDigest (238-325): a WebCrypto digest above the bound is the device's. */
function oneShotDigest(algorithm: string, algorithmId: number, cache: Record<string, number>, input: unknown,
  outputEncoding: string, _outputEncodingId: unknown, outputLength: number | undefined): Buffer | string {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : bufferSource(input);
  const encoding = outputEncoding === 'buffer' ? 'buffer' : outputEncoding;
  if (outputLength === undefined && deviceAnswersDigest(algorithm, bytes.byteLength)) {
    const digest = new Uint8Array(engineCallSync('digest', [webCryptoDigest(algorithm), bytes]) as ArrayBuffer);
    return encodeBytes(digest, encoding);
  }
  const exports = glue();
  const digest = withScratch(4, (idAt) => withName(algorithm, (nameAt) => withBytes(bytes, (at, size) => {
    const out = answer((lengthAt) => exports.tabnode_hash_one_shot(nameAt, algorithmId, idAt, at, size,
      outputLength === undefined ? -1n : BigInt(outputLength >>> 0), lengthAt));
    cacheId(cache, algorithm, word(idAt) | 0);
    return out;
  })));
  return encodeBytes(digest, encoding);
}

/** NUL-separated names, as the glue answers a list. */
function names(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split('\0').slice(0, -1);
}

/** Hash::GetHashes (152-160). */
function getHashes(): string[] { return names(answer((at) => glue().tabnode_hash_get_hashes(at))); }

/** Hash::GetCachedAliases (162-190): a null-prototype object of each alias's id. */
function getCachedAliases(): Record<string, number> {
  const parts = names(answer((at) => glue().tabnode_hash_cached_aliases(at)));
  const result: Record<string, number> = Object.create(null);
  for (let index = 0; index + 1 < parts.length; index += 2) result[parts[index]!] = Number(parts[index + 1]);
  return result;
}

export const hashBinding = { Hash, HashJob, CShakeJob, oneShotDigest, getHashes, getCachedAliases };
export { kCryptoJobWebCrypto };
