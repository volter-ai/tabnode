/**
 * THE HMACS OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_hmac.cc`
 * (Hmac, HmacJob), over its OpenSSL half (native/node/crypto_hmac.cc) and the engine device.
 *
 * Routing (ADR-0018 §5): an HMAC over a digest WebCrypto defines (SHA-1, SHA-256, SHA-384, SHA-512) of more than
 * 4 KiB of input is the device's (`importKey` of the key as an HMAC key once, then `sign`, or `verify` for a job's
 * verification); every other HMAC and every input of 4 KiB or less is OpenSSL's. An Hmac learns its input's length
 * only at `digest`, so an Hmac of a WebCrypto digest keeps its input until then. The device takes at most 1 MiB a call.
 */
import { Buffer } from '../buffer-module';
import { address } from './program';
import { withBytes } from './openssl';
import { engineCallAsync, engineCallSync, type EngineKey } from './engine_device';
import {
  answer, checked, CryptoJob, decodeInput, deviceAnswersDigest, encodeBytes, glue, isAnyBufferSource, rethrow,
  toArrayBuffer, webCryptoDigest, bufferSource,
} from './crypto_util';
import { handleOf, isKeyObjectHandle, type KeyObjectHandle } from './crypto_keys';

const hmacs = new FinalizationRegistry<number>((hmac) => glue().tabnode_hmac_free(hmac));

/** SignConfiguration::Mode (crypto_sig.h). */
const kSignJobModeSign = 0;

/** ByteSource::FromSecretKeyBytes (crypto_util.cc:497-506): a string's UTF-8, a buffer's bytes, a secret handle's. */
function secretKeyBytes(value: unknown): Uint8Array {
  if (typeof value === 'string' || isAnyBufferSource(value)) return decodeInput(value);
  const handle = handleOf(value);
  return new Uint8Array(handle.export() as Buffer);
}

/** Hmac (crypto_hmac.cc:28-150). */
export class Hmac {
  private hmac = address(glue().tabnode_hmac_new());
  private webcrypto: string | undefined;
  private key: Uint8Array = new Uint8Array(0);
  private kept: Uint8Array[] | null = null;
  private keptLength = 0;
  private finished = false;

  constructor() { hmacs.register(this, this.hmac); }

  /** HmacInit (66-96). */
  init(hashType: string, key: unknown): void {
    const exports = glue();
    const bytes = secretKeyBytes(key);
    const name = String(hashType);
    withBytes(name, (nameAt) => withBytes(bytes, (keyAt, keyLength) =>
      exports.tabnode_hmac_init(this.hmac, nameAt, keyAt, keyLength)));
    rethrow();
    this.webcrypto = webCryptoDigest(name);
    if (this.webcrypto) { this.key = bytes.slice(); this.kept = []; }
  }

  /** HmacUpdate (98-118). */
  update(data: unknown, encoding?: unknown): boolean {
    const bytes = decodeInput(data, encoding);
    if (this.kept) { this.kept.push(bytes.slice()); this.keptLength += bytes.byteLength; return true; }
    return this.feed(bytes);
  }

  private feed(bytes: Uint8Array): boolean {
    const exports = glue();
    return checked(withBytes(bytes, (at, length) => exports.tabnode_hmac_update(this.hmac, at, length))) === 1;
  }

  /** HmacDigest (120-150): by the device where it answers the input, else by OpenSSL; empty once finalized. */
  digest(encoding?: unknown): Buffer | string {
    const target = encoding === undefined ? 'buffer' : encoding;
    if (this.kept && !this.finished && deviceAnswersDigest(this.webcrypto!, this.keptLength)) {
      this.finished = true;
      const input = Buffer.concat(this.kept);
      this.kept = null;
      const algorithm = { name: 'HMAC', hash: this.webcrypto };
      const key = engineCallSync('importKey', ['raw', this.key, algorithm, false, ['sign']]) as EngineKey;
      // HmacDigest resets its context, so a second digest is empty: OpenSSL's context is finalized and let go.
      const exports = glue();
      answer((lengthAt) => exports.tabnode_hmac_digest(this.hmac, lengthAt));
      return encodeBytes(new Uint8Array(engineCallSync('sign', [algorithm, key, input]) as ArrayBuffer), target);
    }
    if (this.kept) {
      const kept = this.kept;
      this.kept = null;
      for (const chunk of kept) this.feed(chunk);
    }
    const exports = glue();
    return encodeBytes(answer((lengthAt) => exports.tabnode_hmac_digest(this.hmac, lengthAt)), target);
  }
}

/** HmacJob (HmacTraits, 152-257): a WebCrypto HMAC above the bound is the device's `sign` or `verify`. */
export class HmacJob extends CryptoJob {
  private readonly signMode: number;
  private readonly handle: KeyObjectHandle;
  private readonly data: Uint8Array;
  private readonly signature: Uint8Array | undefined;
  private readonly webcrypto: string | undefined;
  constructor(mode: number, signMode: number, digest: string, key: unknown, data: unknown, signature?: unknown) {
    super(mode);
    if (!isKeyObjectHandle(key)) throw new TypeError('Invalid key object handle');
    this.signMode = signMode;
    this.handle = key;
    this.data = bufferSource(data);
    this.signature = signature === undefined ? undefined : bufferSource(signature);
    this.webcrypto = deviceAnswersDigest(digest, this.data.byteLength) ? webCryptoDigest(digest) : undefined;
    const exports = glue();
    const opensslKey = key.opensslKey();
    this.adopt(withBytes(String(digest), (nameAt) => withBytes(this.data, (at, size) => (this.signature === undefined
      ? exports.tabnode_hmac_job_new(mode, signMode, nameAt, opensslKey, at, size, 0, 0)
      : withBytes(this.signature, (sigAt, sigSize) =>
        exports.tabnode_hmac_job_new(mode, signMode, nameAt, opensslKey, at, size, sigAt, sigSize))))));
  }
  protected device() {
    if (!this.webcrypto) return undefined;
    const algorithm = { name: 'HMAC', hash: this.webcrypto };
    const signing = this.signMode === kSignJobModeSign;
    const usages = [signing ? 'sign' : 'verify'];
    const call = (key: EngineKey, sync: boolean) => {
      const args = signing ? [algorithm, key, this.data] : [algorithm, key, this.signature, this.data];
      return sync ? engineCallSync(signing ? 'sign' : 'verify', args) : engineCallAsync(signing ? 'sign' : 'verify', args);
    };
    return {
      call: (sync: boolean) => (sync ? call(this.handle.deviceKey(algorithm, usages, true), true)
        : this.handle.deviceKey(algorithm, usages, false).then((key) => call(key, false))),
      result: (value: unknown) => value,
    };
  }
  /** EncodeOutput (240-257). */
  protected encode(): unknown {
    if (this.signMode === kSignJobModeSign) return toArrayBuffer(this.out());
    return glue().tabnode_hmac_job_verified(this.job) === 1;
  }
}

export const hmacBinding = { Hmac, HmacJob };
