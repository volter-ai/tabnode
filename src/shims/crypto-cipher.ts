/**
 * Node's `createCipheriv` and `createDecipheriv` for AES in GCM, CBC, CTR and
 * ECB modes. A guest calls them synchronously and WebCrypto is async-only, so
 * the modes are built here over one synchronous AES block (`@noble/ciphers`,
 * pinned exactly: its single-block helpers are the library's unsafe surface)
 * and GCM's GHASH. Every mode streams as OpenSSL does: `update` answers the
 * bytes it can, `final` the rest, so a caller that reads `update` alone for a
 * stream mode gets its ciphertext (jose's GCM encrypt: `const ciphertext =
 * cipher.update(plaintext); cipher.final();`, which is how NextAuth seals its
 * session cookie).
 *
 * Not here: the ciphers are not `stream.Transform`s (only `update`/`final`),
 * and no mode but these four, nor ChaCha20-Poly1305, is offered.
 */
import { unsafe } from '@noble/ciphers/aes.js';
import { GHASH } from '@noble/ciphers/_polyval.js';

type Mode = 'gcm' | 'cbc' | 'ctr' | 'ecb';
type Bytes = Uint8Array;

export interface CipherDeps {
  /** stream.Transform: a cipher is one, as Node's is (lib/internal/crypto/cipher.js). */
  Transform: typeof import('node:stream').Transform;
  /** The guest's Buffer.from over bytes. */
  toBuffer(bytes: Bytes): Uint8Array;
  /** Bytes of a string (in its encoding) or a view, as the rest of crypto reads them. */
  bytesOf(value: unknown, encoding?: string): Bytes;
  /** A secret KeyObject's bytes, or undefined when the value is not a KeyObject. */
  secretKeyBytes(value: unknown): Bytes | undefined;
  /** Bytes in an output encoding, as `digest` answers them. */
  encode(bytes: Bytes, encoding?: string): unknown;
  error(code: string, message: string): Error;
}

const CIPHERS = /^aes-(128|192|256)-(gcm|cbc|ctr|ecb)$/u;

/** The ciphers `createCipheriv` accepts, as `getCiphers` lists them. */
export function cipherNames(): string[] {
  const names: string[] = [];
  for (const bits of [128, 192, 256]) for (const mode of ['cbc', 'ctr', 'ecb', 'gcm']) names.push(`aes-${bits}-${mode}`);
  return names;
}

const GCM_TAG_LENGTHS = new Set([4, 8, 12, 13, 14, 15, 16]);

export function createCipherClasses(deps: CipherDeps) {
  const { error } = deps;

  function parse(algorithm: unknown): { keyLength: number; mode: Mode } {
    if (typeof algorithm !== 'string') throw Object.assign(new TypeError('The "cipher" argument must be of type string.'), { code: 'ERR_INVALID_ARG_TYPE' });
    const match = CIPHERS.exec(algorithm.toLowerCase());
    if (!match) throw error('ERR_CRYPTO_UNKNOWN_CIPHER', 'Unknown cipher');
    return { keyLength: Number(match[1]) / 8, mode: match[2] as Mode };
  }

  function keyOf(key: unknown, keyLength: number): Bytes {
    const bytes = deps.secretKeyBytes(key) ?? deps.bytesOf(key);
    if (bytes.length !== keyLength) throw Object.assign(new RangeError('Invalid key length'), { code: 'ERR_CRYPTO_INVALID_KEYLEN' });
    return new Uint8Array(bytes);
  }

  function ivOf(iv: unknown, mode: Mode): Bytes | undefined {
    if (mode === 'ecb') {
      if (iv === null || iv === undefined) return undefined;
      const bytes = deps.bytesOf(iv);
      if (bytes.length !== 0) throw Object.assign(new TypeError('Invalid initialization vector'), { code: 'ERR_CRYPTO_INVALID_IV' });
      return undefined;
    }
    if (iv === null || iv === undefined) throw Object.assign(new TypeError('Invalid initialization vector'), { code: 'ERR_CRYPTO_INVALID_IV' });
    const bytes = new Uint8Array(deps.bytesOf(iv));
    if (mode === 'gcm' ? bytes.length === 0 : bytes.length !== 16) throw Object.assign(new TypeError('Invalid initialization vector'), { code: 'ERR_CRYPTO_INVALID_IV' });
    return bytes;
  }

  /** One AES block, encrypted in place in a fresh aligned array. */
  function encryptBlock(xk: Uint32Array, block: Bytes): Bytes {
    const out = new Uint8Array(16);
    out.set(block);
    return unsafe.encryptBlock(xk, out) as Bytes;
  }

  function decryptBlock(xk: Uint32Array, block: Bytes): Bytes {
    const out = new Uint8Array(16);
    out.set(block);
    return unsafe.decryptBlock(xk, out) as Bytes;
  }

  function concat(a: Bytes, b: Bytes): Bytes {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  /** A 128-bit big-endian counter, or its low 32 bits alone (GCM's inc32). */
  function increment(counter: Bytes, from: number): void {
    for (let i = 15; i >= from; i--) {
      counter[i] = (counter[i]! + 1) & 0xff;
      if (counter[i] !== 0) return;
    }
  }

  // The subclasses' doors to the tag, which the base keeps private (as KeyObject's keyInfoOf reads its key).
  let authTagOf: (cipher: CipherBase) => Bytes;
  let expectTagOf: (cipher: CipherBase, tag: unknown, encoding?: string) => void;

  class CipherBase extends deps.Transform {
    static {
      authTagOf = (cipher) => cipher.#getTag();
      expectTagOf = (cipher, tag, encoding) => cipher.#setTag(tag, encoding);
    }
    readonly #decrypt: boolean;
    readonly #mode: Mode;
    readonly #xk: Uint32Array;
    readonly #xkDec: Uint32Array | undefined;
    #padding = true;
    #finished = false;
    #started = false;
    /** CBC/ECB: bytes not yet a whole block (and, decrypting with padding, the last whole block). */
    #pending: Bytes = new Uint8Array(0);
    /** CBC's chaining block. */
    #chain: Bytes | undefined;
    /** CTR/GCM: the next counter block and what is left of the current keystream block. */
    #counter: Bytes | undefined;
    #keystream: Bytes = new Uint8Array(0);
    /** GCM. */
    #ghash: GHASH | undefined;
    #tagMask: Bytes | undefined;
    #ghashPending: Bytes = new Uint8Array(0);
    #aadLength = 0;
    #dataLength = 0;
    #authTagLength: number | undefined;
    #authTag: Bytes | undefined;

    constructor(decrypt: boolean, algorithm: unknown, key: unknown, iv: unknown, options?: { authTagLength?: number }) {
      super();
      const { keyLength, mode } = parse(algorithm);
      this.#decrypt = decrypt;
      this.#mode = mode;
      const keyBytes = keyOf(key, keyLength);
      const ivBytes = ivOf(iv, mode);
      this.#xk = unsafe.expandKeyLE(keyBytes) as Uint32Array;
      this.#xkDec = decrypt && (mode === 'cbc' || mode === 'ecb') ? unsafe.expandKeyDecLE(keyBytes) as Uint32Array : undefined;
      const tagLength = options?.authTagLength;
      if (tagLength !== undefined) {
        if (mode !== 'gcm') throw Object.assign(new TypeError(`Invalid authentication tag length: ${tagLength}`), { code: 'ERR_CRYPTO_INVALID_AUTH_TAG' });
        if (!GCM_TAG_LENGTHS.has(tagLength)) throw Object.assign(new TypeError(`Invalid authentication tag length: ${tagLength}`), { code: 'ERR_CRYPTO_INVALID_AUTH_TAG' });
        this.#authTagLength = tagLength;
      }
      if (mode === 'cbc') this.#chain = ivBytes;
      if (mode === 'ctr') this.#counter = new Uint8Array(ivBytes!);
      if (mode === 'gcm') {
        // NIST SP 800-38D: H = E_K(0), J0 from a 96-bit IV or GHASH of any other, the tag mask E_K(J0), and the
        // payload counted from inc32(J0).
        const h = encryptBlock(this.#xk, new Uint8Array(16));
        let j0: Bytes;
        if (ivBytes!.length === 12) {
          j0 = new Uint8Array(16);
          j0.set(ivBytes!);
          j0[15] = 1;
        } else {
          const lengths = new Uint8Array(16);
          new DataView(lengths.buffer).setBigUint64(8, BigInt(ivBytes!.length * 8), false);
          const g = new GHASH(h);
          g.update(ivBytes!).update(lengths);
          j0 = g.digest() as Bytes;
        }
        this.#tagMask = encryptBlock(this.#xk, j0);
        this.#counter = new Uint8Array(j0);
        increment(this.#counter, 12);
        this.#ghash = new GHASH(h);
      }
    }

    setAutoPadding(autoPadding = true): this {
      if (this.#finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for operation setAutoPadding');
      this.#padding = Boolean(autoPadding);
      return this;
    }

    setAAD(buffer: unknown, _options?: { plaintextLength?: number }): this {
      if (this.#mode !== 'gcm' || this.#started || this.#finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for operation setAAD');
      const aad = deps.bytesOf(buffer);
      // GHASH pads each update to a block; AAD is padded once, as GCM pads it, whatever its length.
      this.#ghash!.update(aad);
      this.#aadLength += aad.length;
      return this;
    }

    #getTag(): Bytes {
      if (this.#mode !== 'gcm' || this.#decrypt || !this.#finished || !this.#authTag) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for operation getAuthTag');
      return this.#authTag;
    }

    #setTag(tag: unknown, encoding?: string): void {
      if (this.#mode !== 'gcm' || !this.#decrypt || this.#finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for operation setAuthTag');
      const bytes = new Uint8Array(typeof tag === 'string' ? deps.bytesOf(tag, encoding) : deps.bytesOf(tag));
      const allowed = this.#authTagLength === undefined ? GCM_TAG_LENGTHS.has(bytes.length) : bytes.length === this.#authTagLength;
      if (!allowed) throw Object.assign(new TypeError(`Invalid authentication tag length: ${bytes.length}`), { code: 'ERR_CRYPTO_INVALID_AUTH_TAG' });
      this.#authTag = bytes;
    }

    update(data: unknown, inputEncoding?: string, outputEncoding?: string): unknown {
      if (this.#finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Invalid state for operation update');
      this.#started = true;
      const input = typeof data === 'string' ? deps.bytesOf(data, inputEncoding) : deps.bytesOf(data);
      return deps.encode(this.#process(new Uint8Array(input)), outputEncoding);
    }

    final(outputEncoding?: string): unknown {
      if (this.#finished) throw error('ERR_CRYPTO_INVALID_STATE', 'Unsupported state');
      this.#finished = true;
      return deps.encode(this.#finish(), outputEncoding);
    }

    // As a stream: each chunk written is enciphered and read out, and final()'s bytes are the last chunk.
    override _transform(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
      try { this.push(this.update(chunk) as Uint8Array); } catch (cause) { callback(cause as Error); return; }
      callback();
    }

    override _flush(callback: (error?: Error | null) => void): void {
      try { this.push(this.final() as Uint8Array); } catch (cause) { callback(cause as Error); return; }
      callback();
    }

    #process(input: Bytes): Bytes {
      switch (this.#mode) {
        case 'ctr': return this.#stream(input);
        case 'gcm': {
          if (this.#decrypt) this.#absorb(input);
          const out = this.#stream(input);
          if (!this.#decrypt) this.#absorb(out);
          this.#dataLength += input.length;
          return out;
        }
        default: return this.#blocks(input);
      }
    }

    /** XOR with the counter's keystream, carrying a partial block across calls. */
    #stream(input: Bytes): Bytes {
      const out = new Uint8Array(input.length);
      let at = 0;
      while (at < input.length) {
        if (this.#keystream.length === 0) {
          this.#keystream = encryptBlock(this.#xk, this.#counter!);
          increment(this.#counter!, this.#mode === 'gcm' ? 12 : 0);
        }
        const take = Math.min(this.#keystream.length, input.length - at);
        for (let i = 0; i < take; i++) out[at + i] = input[at + i]! ^ this.#keystream[i]!;
        this.#keystream = this.#keystream.subarray(take);
        at += take;
      }
      return out;
    }

    /** GHASH over the ciphertext, in whole blocks: GHASH pads each update, so a partial block waits for the next. */
    #absorb(ciphertext: Bytes): void {
      const all = concat(this.#ghashPending, ciphertext);
      const whole = all.length - (all.length % 16);
      if (whole > 0) this.#ghash!.update(all.subarray(0, whole));
      this.#ghashPending = all.slice(whole);
    }

    /** CBC and ECB: every whole block now; decrypting with padding, the last whole block waits for `final`. */
    #blocks(input: Bytes): Bytes {
      const all = concat(this.#pending, input);
      let whole = all.length - (all.length % 16);
      if (this.#decrypt && this.#padding && whole === all.length && whole > 0) whole -= 16;
      const out = new Uint8Array(whole);
      for (let at = 0; at < whole; at += 16) out.set(this.#block(all.subarray(at, at + 16)), at);
      this.#pending = all.slice(whole);
      return out;
    }

    #block(block: Bytes): Bytes {
      if (this.#mode === 'ecb') return this.#decrypt ? decryptBlock(this.#xkDec!, block) : encryptBlock(this.#xk, block);
      if (this.#decrypt) {
        const plain = decryptBlock(this.#xkDec!, block);
        for (let i = 0; i < 16; i++) plain[i] = plain[i]! ^ this.#chain![i]!;
        this.#chain = new Uint8Array(block);
        return plain;
      }
      const mixed = new Uint8Array(16);
      for (let i = 0; i < 16; i++) mixed[i] = block[i]! ^ this.#chain![i]!;
      const cipher = encryptBlock(this.#xk, mixed);
      this.#chain = cipher;
      return cipher;
    }

    #finish(): Bytes {
      if (this.#mode === 'ctr') return new Uint8Array(0);
      if (this.#mode === 'gcm') return this.#finishGcm();
      const rest = this.#pending;
      this.#pending = new Uint8Array(0);
      if (!this.#decrypt) {
        if (!this.#padding) {
          if (rest.length !== 0) throw error('ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH', 'error:1C80006B:Provider routines::wrong final block length');
          return rest;
        }
        const pad = 16 - rest.length;
        const block = new Uint8Array(16);
        block.set(rest);
        block.fill(pad, rest.length);
        return this.#block(block);
      }
      if (!this.#padding) {
        if (rest.length !== 0) throw error('ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH', 'error:1C80006B:Provider routines::wrong final block length');
        return rest;
      }
      if (rest.length !== 16) throw error('ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH', 'error:1C80006B:Provider routines::wrong final block length');
      const plain = this.#block(rest);
      const pad = plain[15]!;
      let valid = pad >= 1 && pad <= 16;
      for (let i = 16 - pad; valid && i < 16; i++) valid = plain[i] === pad;
      if (!valid) throw error('ERR_OSSL_BAD_DECRYPT', 'error:1C800064:Provider routines::bad decrypt');
      return plain.slice(0, 16 - pad);
    }

    #finishGcm(): Bytes {
      if (this.#ghashPending.length) this.#ghash!.update(this.#ghashPending);
      const lengths = new Uint8Array(16);
      const view = new DataView(lengths.buffer);
      view.setBigUint64(0, BigInt(this.#aadLength * 8), false);
      view.setBigUint64(8, BigInt(this.#dataLength * 8), false);
      const full = this.#ghash!.update(lengths).digest() as Bytes;
      for (let i = 0; i < 16; i++) full[i] = full[i]! ^ this.#tagMask![i]!;
      if (!this.#decrypt) {
        this.#authTag = full.slice(0, this.#authTagLength ?? 16);
        return new Uint8Array(0);
      }
      const expected = this.#authTag;
      let same = expected !== undefined;
      if (expected) for (let i = 0; i < expected.length; i++) same = same && full[i] === expected[i];
      if (!same) throw new Error('Unsupported state or unable to authenticate data');
      return new Uint8Array(0);
    }
  }

  class Cipheriv extends CipherBase {
    constructor(algorithm: unknown, key: unknown, iv: unknown, options?: { authTagLength?: number }) {
      super(false, algorithm, key, iv, options);
    }
    getAuthTag(): Uint8Array {
      return deps.toBuffer(authTagOf(this));
    }
  }

  class Decipheriv extends CipherBase {
    constructor(algorithm: unknown, key: unknown, iv: unknown, options?: { authTagLength?: number }) {
      super(true, algorithm, key, iv, options);
    }
    setAuthTag(tag: unknown, encoding?: string): this {
      expectTagOf(this, tag, encoding);
      return this;
    }
  }

  return {
    Cipheriv,
    Decipheriv,
    createCipheriv: (algorithm: unknown, key: unknown, iv: unknown, options?: { authTagLength?: number }) => new Cipheriv(algorithm, key, iv, options),
    createDecipheriv: (algorithm: unknown, key: unknown, iv: unknown, options?: { authTagLength?: number }) => new Decipheriv(algorithm, key, iv, options),
  };
}
