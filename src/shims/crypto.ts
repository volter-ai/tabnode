/**
 * Node.js crypto module shim
 *
 * Digests, HMAC and PBKDF2 are the real algorithms over pure-JS primitives,
 * because a guest calls them synchronously and WebCrypto is async-only.
 * Random values and asymmetric signing use WebCrypto, which does have them.
 */

import SHA from 'sha.js';
import { md5 } from '@noble/hashes/legacy.js';
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt.js';
// The `buffer` package, not the guest polyfill: the byte-level encodings
// (utf16le, latin1, offset views) crypto inputs arrive in are its own.
import { Buffer as HostBuffer } from 'buffer/index.js';
import type { Buffer, BufferConstructor, BufferModule } from '../node-lib/buffer-module';
import type { EventsModule } from '../node-lib/events-module';
import { lazyModule, lazyExport } from '../node-lib/lazy';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_OUT_OF_RANGE,
  validateFunction,
  validateNumber,
} from '../node-internals';
import { cryptoConstants as constants } from './crypto-constants';
import { cipherNames, createCipherClasses } from './crypto-cipher';
import type { NodeCryptoExport, NodeCryptoUnavailable } from './crypto-exports';
import * as asymmetric from './crypto-ec';
import * as rsa from './crypto-rsa';
import type { AsymmetricKey, DsaEncoding, KeyEncodingType } from './crypto-ec';
export { constants };

interface DigestState {
  update(data: Uint8Array): DigestState;
  digest(): Uint8Array;
  clone?(): DigestState;
  [field: string]: unknown;
}

/** `crypto.scrypt`'s options, by both of Node's names for each. */
export interface ScryptOptions { N?: number; cost?: number; r?: number; blockSize?: number; p?: number; parallelization?: number; maxmem?: number }

/** Native crypto allocates guest results and classes in the caller's graph. */
export function createCryptoModule(require?: (name: string) => any) {
  // The host factory runs inside the builtin loader's import cycle. Create
  // lazy references here; even reading another module's lazy-export constant
  // eagerly can hit its TDZ under a different bundle evaluation order.
  const bufferModule: BufferModule = require ? require('buffer') : lazyModule<BufferModule>('buffer');
  const Buffer: BufferConstructor = require ? bufferModule.Buffer : lazyExport<BufferConstructor>('buffer', 'Buffer');
  const EventEmitter: EventsModule['EventEmitter'] = require ? require('events').EventEmitter : lazyExport<EventsModule['EventEmitter']>('events', 'EventEmitter');
// ============================================================================
// Random functions
// ============================================================================

/**
 * Node's `lib/internal/crypto/random.js` bounds. VS Code's extension host calls
 * `crypto.randomBytes(size, cb)` and waits on the callback; the engine ignored
 * the callback, returned the buffer, and the host waited forever. `randomFill`
 * was not here at all. Node decides every error these raise in `assertOffset`
 * and `assertSize`, so both are transcribed rather than approximated.
 */
function kMaxPossibleLengthOf(): number { return Math.min(bufferModule.kMaxLength, 2 ** 31 - 1); }
/** WebCrypto refuses more than this many bytes in one call. */
const kRandomChunk = 65536;

/**
 * Random bytes into any view. WebCrypto has a per-call limit and refuses a
 * view over a SharedArrayBuffer, both of which Node's own `randomFillSync`
 * accepts, so the bytes are drawn into a plain array and copied.
 */
function __fillRandomBytes(target: Uint8Array): void {
  if (target.length === 0) return;
  const chunk = new Uint8Array(Math.min(target.length, kRandomChunk));
  for (let offset = 0; offset < target.length; offset += kRandomChunk) {
    const span = Math.min(kRandomChunk, target.length - offset);
    const source = span === chunk.length ? chunk : chunk.subarray(0, span);
    crypto.getRandomValues(source);
    target.set(source, offset);
  }
}

/** Node: a fill target is an ArrayBuffer, a SharedArrayBuffer or any view. */
function __randomFillTarget(buffer: unknown): Uint8Array {
  if (ArrayBuffer.isView(buffer)) {
    const view = buffer as ArrayBufferView;
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer) {
    return new Uint8Array(buffer as unknown as ArrayBuffer);
  }
  throw new ERR_INVALID_ARG_TYPE('buf', ['ArrayBuffer', 'ArrayBufferView'], buffer);
}

/** lib/internal/crypto/random.js assertOffset, in element units as Node takes it. */
function __assertOffset(offset: unknown, elementSize: number, length: number): number {
  validateNumber(offset, 'offset');
  const bytes = (offset as number) * elementSize;
  const maxLength = Math.min(length, kMaxPossibleLengthOf());
  if (Number.isNaN(bytes) || bytes > maxLength || bytes < 0) {
    throw new ERR_OUT_OF_RANGE('offset', `>= 0 && <= ${maxLength}`, bytes);
  }
  return bytes >>> 0;
}

/** lib/internal/crypto/random.js assertSize. */
function __assertSize(size: unknown, elementSize: number, offset: number, length: number): number {
  validateNumber(size, 'size');
  const bytes = (size as number) * elementSize;
  if (Number.isNaN(bytes) || bytes > kMaxPossibleLengthOf() || bytes < 0) {
    throw new ERR_OUT_OF_RANGE('size', `>= 0 && <= ${kMaxPossibleLengthOf()}`, bytes);
  }
  if (bytes + offset > length) {
    throw new ERR_OUT_OF_RANGE('size + offset', `<= ${length}`, bytes + offset);
  }
  return bytes >>> 0;
}

function randomBytes(size: number): Buffer;
function randomBytes(size: number, callback: (error: Error | null, buffer: Buffer) => void): void;
/**
 * Node: with a callback, `randomBytes` answers through it and returns nothing;
 * without one it returns the buffer. The engine always returned the buffer and
 * dropped the callback, so a program that only waits on the callback hung.
 */
function randomBytes(
  size: number,
  callback?: (error: Error | null, buffer: Buffer) => void
): Buffer | void {
  const length = __assertSize(size, 1, 0, Infinity);
  if (callback !== undefined) validateFunction(callback, 'callback');
  if (callback === undefined) {
    const array = new Uint8Array(length);
    __fillRandomBytes(array);
    return Buffer.from(array);
  }
  queueMicrotask(() => {
    const array = new Uint8Array(length);
    __fillRandomBytes(array);
    callback(null, Buffer.from(array));
  });
}

function randomFillSync<T extends ArrayBufferView | ArrayBufferLike>(
  buffer: T,
  offset?: number,
  size?: number
): T {
  const target = __randomFillTarget(buffer);
  const elementSize = (buffer as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1;
  const start = __assertOffset(offset === undefined ? 0 : offset, elementSize, target.byteLength);
  const length = size === undefined
    ? target.byteLength - start
    : __assertSize(size, elementSize, start, target.byteLength);
  if (length !== 0) __fillRandomBytes(target.subarray(start, start + length));
  return buffer;
}

/**
 * Node's asynchronous fill. The overloads are Node's: `(buf, cb)`,
 * `(buf, offset, cb)`, `(buf, offset, size, cb)`, with the same argument
 * checks `randomFillSync` makes.
 */
function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
  buffer: T,
  callback: (error: Error | null, buffer: T) => void
): void;
function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
  buffer: T,
  offset: number,
  callback: (error: Error | null, buffer: T) => void
): void;
function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
  buffer: T,
  offset: number,
  size: number,
  callback: (error: Error | null, buffer: T) => void
): void;
function randomFill(
  buffer: unknown,
  offsetOrCallback?: unknown,
  sizeOrCallback?: unknown,
  maybeCallback?: unknown
): void {
  const target = __randomFillTarget(buffer);
  const elementSize = (buffer as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1;

  let offset: unknown = offsetOrCallback;
  let size: unknown = sizeOrCallback;
  let callback: unknown = maybeCallback;

  if (typeof offsetOrCallback === 'function') {
    callback = offsetOrCallback;
    offset = 0;
    // Node: a length in elements here, which assertSize turns into bytes. A
    // DataView and a raw ArrayBuffer have no `length`, and the whole byte
    // length is taken instead.
    size = (buffer as { length?: number }).length;
  } else if (typeof sizeOrCallback === 'function') {
    callback = sizeOrCallback;
    size = ((buffer as { length?: number }).length ?? target.byteLength) - (offset as number);
  } else {
    validateFunction(callback, 'callback');
  }

  const start = __assertOffset(offset, elementSize, target.byteLength);
  const length = size === undefined
    ? target.byteLength - start
    : __assertSize(size, elementSize, start, target.byteLength);

  const done = callback as (error: Error | null, buffer: unknown) => void;
  queueMicrotask(() => {
    if (length !== 0) __fillRandomBytes(target.subarray(start, start + length));
    done(null, buffer);
  });
}

function randomUUID(): string {
  return crypto.randomUUID();
}

/** Node's `randomInt` draws from six bytes, so this is its largest range. */
const kRandMax = 281474976710655;

function randomInt(max: number): number;
function randomInt(min: number, max: number): number;
function randomInt(max: number, callback: (error: undefined, value: number) => void): void;
function randomInt(min: number, max: number, callback: (error: undefined, value: number) => void): void;
/**
 * Node's `randomInt`, transcribed: an unbiased draw by rejection, Node's
 * argument checks, and the callback form. The engine had neither the callback
 * form nor the checks, so `randomInt(3, cb)` read the callback as the maximum
 * and answered NaN, and `randomInt(1, 1)` divided by a zero range.
 */
function randomInt(
  min: number,
  max?: number | ((error: undefined, value: number) => void),
  callback?: (error: undefined, value: number) => void
): number | void {
  const minNotSpecified = max === undefined || typeof max === 'function';
  let low = min;
  let high = max as number;
  if (minNotSpecified) {
    callback = max as ((error: undefined, value: number) => void) | undefined;
    high = min;
    low = 0;
  }

  const isSync = callback === undefined;
  if (!isSync) validateFunction(callback, 'callback');
  if (!Number.isSafeInteger(low)) throw new ERR_INVALID_ARG_TYPE('min', 'a safe integer', low);
  if (!Number.isSafeInteger(high)) throw new ERR_INVALID_ARG_TYPE('max', 'a safe integer', high);
  if (high <= low) {
    throw new ERR_OUT_OF_RANGE('max', `greater than the value of "min" (${low})`, high);
  }

  const range = high - low;
  if (!(range <= kRandMax)) {
    throw new ERR_OUT_OF_RANGE(`max${minNotSpecified ? '' : ' - min'}`, `<= ${kRandMax}`, range);
  }

  // For (x % range) to be unbiased, x must come from [0, randLimit).
  const randLimit = kRandMax - (kRandMax % range);
  const bytes = new Uint8Array(6);
  for (;;) {
    __fillRandomBytes(bytes);
    let x = 0;
    for (let index = 0; index < 6; index++) x = x * 256 + bytes[index];
    if (x >= randLimit) continue;
    const value = (x % range) + low;
    if (isSync) return value;
    queueMicrotask(() => (callback as (error: undefined, value: number) => void)(undefined, value));
    return;
  }
}

function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return crypto.getRandomValues(array);
}

// ============================================================================
// Hash, HMAC and PBKDF2
// ============================================================================
//
// These are the real algorithms, computed synchronously in JS. What stood
// here before was `syncHash`, an integer mixer that returned digest-shaped
// bytes which were not the digest, and a `syncHmac` that hashed key||data:
// a config loader keyed its cache by md5 and collided, `ws` computed a
// Sec-WebSocket-Accept no server accepts, and every guest that compares a
// digest to a known constant disagreed with Node. WebCrypto cannot stand in:
// it is async-only, so `createHash(...).digest()` cannot wait for it, and it
// has no MD5 at all. sha.js carries the SHA family and @noble/hashes carries
// MD5; both are pure JS and byte-for-byte Node's.

/** A hash engine: sha.js's Hash, or @noble/hashes' MD5. */


const HASH_ALGORITHMS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];

function cryptoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function finalized(): Error {
  return cryptoError('ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
}

/**
 * Node throws ERR_CRYPTO_UNSUPPORTED_OPERATION rather than returning
 * something that only looks like a result; so does this shim.
 */
function unsupported(operation: string): never {
  throw cryptoError(
    'ERR_CRYPTO_UNSUPPORTED_OPERATION',
    `${operation} is not supported by the browser crypto adapter.`
  );
}

function hashAlgorithm(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Digest algorithm must be a string.');
  // Node accepts OpenSSL's spellings; `sha-256` and `sha256` are one digest.
  const name = value.toLowerCase().replace(/^sha-(1|224|256|384|512)$/, 'sha$1');
  if (!HASH_ALGORITHMS.includes(name)) {
    // A digest OpenSSL has and this engine does not carry is refused as that, not called invalid.
    if (/^(sha512-(224|256)|sha3-(224|256|384|512)|shake(128|256)|blake2[bs]\d+|ripemd(160)?|rmd160|sm3|md4|md5-sha1)$/.test(name)) unsupported(`The digest ${value}`);
    throw cryptoError('ERR_CRYPTO_INVALID_DIGEST', `Unsupported digest: ${value}`);
  }
  return name;
}

function digestEngine(algorithm: string): DigestState {
  // Neither library declares the open field set the copy path below reads.
  return algorithm === 'md5'
    ? (md5.create() as unknown as DigestState)
    : (SHA(algorithm) as unknown as DigestState);
}

type HostBytes = InstanceType<typeof HostBuffer>;

/**
 * Crypto input as bytes, in the `buffer` package's memory: it carries the
 * encodings the guest Buffer polyfill does not (utf16le, latin1) and views a
 * caller's ArrayBuffer at its offset instead of copying the whole store.
 */
const utf8Encoder = new TextEncoder();
function cryptoBytes(value: unknown, encoding?: string, allowArrayBuffer = false): HostBytes {
  if (typeof value === 'string') {
    // `buffer` 6.0.3 predates base64url; the alphabet is a superset of base64's.
    if (encoding?.toLowerCase() === 'base64url') return HostBuffer.from(value, 'base64');
    if (encoding !== undefined && !HostBuffer.isEncoding(encoding)) {
      throw new TypeError(`Unknown encoding: ${encoding}`);
    }
    // UTF-8, the default, by the engine's encoder: `buffer`'s own builds an
    // array of numbers per string, and a Vite session hashing every module it
    // served made hundreds of MB of that garbage in its first seconds in a tab.
    const lower = encoding?.toLowerCase();
    if (lower === undefined || lower === 'utf8' || lower === 'utf-8') {
      const bytes = utf8Encoder.encode(value);
      return HostBuffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    }
    return HostBuffer.from(value, encoding);
  }
  if (ArrayBuffer.isView(value)) {
    // A view over shared memory hashes like any other; only the types of
    // `buffer`'s from() overload stop at ArrayBuffer.
    return HostBuffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  }
  if (allowArrayBuffer && value instanceof ArrayBuffer) return HostBuffer.from(value);
  throw new TypeError('Crypto input must be a string or an ArrayBuffer view.');
}

/** Digests leave as guest Buffers, so a guest's `Buffer.isBuffer` holds. */
function digestResult(value: Uint8Array, encoding?: string): Buffer | string {
  if (!encoding || encoding === 'buffer') return Buffer.from(value);
  const name = encoding.toLowerCase();
  if (name === 'base64url') {
    return HostBuffer.from(value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
  if (!HostBuffer.isEncoding(name)) throw new TypeError(`Unknown encoding: ${encoding}`);
  return HostBuffer.from(value).toString(name);
}

class Hash {
  #state: DigestState;
  #done = false;
  readonly algorithm: string;

  constructor(algorithm: string) {
    this.algorithm = algorithm;
    this.#state = digestEngine(algorithm);
  }

  update(data: unknown, inputEncoding?: string): this {
    if (this.#done) throw finalized();
    // Consume the bytes now: Node's update copies, and a caller may reuse
    // the array it handed us before digest().
    this.#state.update(cryptoBytes(data, inputEncoding));
    return this;
  }

  digest(outputEncoding?: string): Buffer | string {
    if (this.#done) throw finalized();
    this.#done = true;
    return digestResult(this.#state.digest(), outputEncoding);
  }

  async digestAsync(outputEncoding?: string): Promise<Buffer | string> {
    return this.digest(outputEncoding);
  }

  copy(): Hash {
    if (this.#done) throw finalized();
    const copy = new Hash(this.algorithm);
    if (this.#state.clone) {
      copy.#state = this.#state.clone();
      return copy;
    }
    // sha.js 2.4.12 keeps its chaining words, length and current block in own
    // fields and offers no clone. Copy buffers and scratch arrays by value;
    // everything else is a number.
    for (const [field, value] of Object.entries(this.#state)) {
      copy.#state[field] = ArrayBuffer.isView(value)
        ? HostBuffer.from(cryptoBytes(value))
        : Array.isArray(value)
          ? value.slice()
          : value;
    }
    return copy;
  }
}

class Hmac {
  #inner: DigestState;
  #outer: DigestState;
  #done = false;

  constructor(algorithm: string, key: HostBytes) {
    const blockSize = algorithm === 'sha384' || algorithm === 'sha512' ? 128 : 64;
    // RFC 2104: a key longer than the block is hashed first, a shorter one
    // is zero-padded to the block.
    const material = key.length > blockSize ? digestEngine(algorithm).update(key).digest() : key;
    const innerPad = HostBuffer.alloc(blockSize);
    const outerPad = HostBuffer.alloc(blockSize);
    for (let index = 0; index < blockSize; index++) {
      const byte = index < material.length ? material[index] : 0;
      innerPad[index] = byte ^ 0x36;
      outerPad[index] = byte ^ 0x5c;
    }
    this.#inner = digestEngine(algorithm).update(innerPad);
    this.#outer = digestEngine(algorithm).update(outerPad);
    innerPad.fill(0);
    outerPad.fill(0);
  }

  update(data: unknown, inputEncoding?: string): this {
    if (this.#done) throw finalized();
    this.#inner.update(cryptoBytes(data, inputEncoding));
    return this;
  }

  digest(outputEncoding?: string): Buffer | string {
    // Node's Hmac yields an empty result from a second digest(), not an error.
    if (this.#done) return digestResult(HostBuffer.alloc(0), outputEncoding);
    this.#done = true;
    return digestResult(this.#outer.update(this.#inner.digest()).digest(), outputEncoding);
  }

  async digestAsync(outputEncoding?: string): Promise<Buffer | string> {
    return this.digest(outputEncoding);
  }
}

function createHash(algorithm: string, options?: { outputLength?: number }): Hash {
  if (options?.outputLength !== undefined) unsupported('Variable-length digests');
  return new Hash(hashAlgorithm(algorithm));
}

function createHmac(
  algorithm: string,
  key: unknown,
  options?: { encoding?: string }
): Hmac {
  const name = hashAlgorithm(algorithm);
  let material = key;
  if (material !== null && typeof material === 'object' && 'type' in material && 'export' in material) {
    const secret = material as { type: unknown; export?: unknown };
    if (secret.type !== 'secret' || typeof secret.export !== 'function') {
      throw new TypeError('HMAC requires a secret key.');
    }
    material = (secret.export as () => unknown)();
  }
  return new Hmac(name, cryptoBytes(material, options?.encoding, true));
}

/** The one-shot digest, `crypto.hash`, added in Node 21. */
function hash(algorithm: string, data: unknown, outputEncoding = 'hex'): Buffer | string {
  return createHash(algorithm).update(data).digest(outputEncoding);
}

// ============================================================================
// PBKDF2 (Password-Based Key Derivation Function 2)
// ============================================================================

type BinaryLike = string | Buffer | Uint8Array;

interface Pbkdf2Parameters {
  algorithm: string;
  password: HostBytes;
  salt: HostBytes;
  iterations: number;
  keylen: number;
}

function pbkdf2Parameters(
  password: unknown,
  salt: unknown,
  iterations: number,
  keylen: number,
  digest: string
): Pbkdf2Parameters {
  const algorithm = hashAlgorithm(digest);
  for (const [name, value] of [['iterations', iterations], ['keylen', keylen]] as const) {
    if (typeof value !== 'number') throw new TypeError(`${name} must be a number.`);
    if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) {
      throw new RangeError(`${name} is out of range.`);
    }
  }
  // Copy before the callback form yields: a caller that reuses its password
  // array must not change the key we derive.
  return {
    algorithm,
    password: HostBuffer.from(cryptoBytes(password, undefined, true)),
    salt: HostBuffer.from(cryptoBytes(salt, undefined, true)),
    iterations,
    keylen,
  };
}

function derive(parameters: Pbkdf2Parameters): Buffer {
  const { algorithm, password, salt, iterations, keylen } = parameters;
  const length = { md5: 16, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64 }[algorithm]!;
  const derived = HostBuffer.alloc(keylen);
  const suffix = HostBuffer.alloc(4);
  try {
    for (let block = 1, offset = 0; offset < keylen; block++, offset += length) {
      suffix[0] = block >>> 24;
      suffix[1] = block >>> 16;
      suffix[2] = block >>> 8;
      suffix[3] = block;
      let u = new Hmac(algorithm, password).update(salt).update(suffix).digest() as Buffer;
      const accumulated = HostBuffer.from(u);
      for (let round = 1; round < iterations; round++) {
        const next = new Hmac(algorithm, password).update(u).digest() as Buffer;
        u.fill(0);
        u = next;
        for (let index = 0; index < length; index++) accumulated[index] ^= u[index];
      }
      derived.set(accumulated.subarray(0, Math.min(length, keylen - offset)), offset);
      u.fill(0);
      accumulated.fill(0);
    }
    return Buffer.from(derived);
  } finally {
    password.fill(0);
    salt.fill(0);
    derived.fill(0);
  }
}

function pbkdf2Sync(
  password: BinaryLike,
  salt: BinaryLike,
  iterations: number,
  keylen: number,
  digest: string
): Buffer {
  return derive(pbkdf2Parameters(password, salt, iterations, keylen, digest));
}

function pbkdf2(
  password: BinaryLike,
  salt: BinaryLike,
  iterations: number,
  keylen: number,
  digest: string,
  callback: (err: Error | null, derivedKey?: Buffer) => void
): void {
  if (typeof callback !== 'function') throw new TypeError('PBKDF2 callback must be a function.');
  // Node validates its arguments synchronously and calls back later.
  const parameters = pbkdf2Parameters(password, salt, iterations, keylen, digest);
  setTimeout(() => {
    let key: Buffer;
    try {
      key = derive(parameters);
    } catch (error) {
      callback(error as Error);
      return;
    }
    callback(null, key);
  }, 0);
}


// ============================================================================
// HKDF (RFC 5869) and scrypt (RFC 7914)
// ============================================================================

const DIGEST_BYTES: Record<string, number> = { md5: 16, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64 };

interface HkdfParameters { algorithm: string; key: HostBytes; salt: HostBytes; info: HostBytes; length: number }

/** Node's `validateParameters` (lib/internal/crypto/hkdf.js): the same refusals, by the same codes. */
function hkdfParameters(digest: unknown, ikm: unknown, salt: unknown, info: unknown, length: unknown): HkdfParameters {
  if (typeof digest !== 'string') throw new ERR_INVALID_ARG_TYPE('digest', 'string', digest);
  const name = digest.toLowerCase().replace(/^sha-(1|224|256|384|512)$/, 'sha$1');
  if (!HASH_ALGORITHMS.includes(name)) throw Object.assign(new TypeError(`Invalid digest: ${digest}`), { code: 'ERR_CRYPTO_INVALID_DIGEST' });
  let key: HostBytes;
  if (ikm instanceof KeyObject) {
    const held = keyInfoOf(ikm);
    if (held.type !== 'secret' || !(held.keyData instanceof Uint8Array)) {
      throw Object.assign(new TypeError(`Invalid key object type ${held.type}, expected secret.`), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' });
    }
    key = HostBuffer.from(held.keyData);
  } else if (typeof ikm === 'string' || ArrayBuffer.isView(ikm) || ikm instanceof ArrayBuffer) {
    key = HostBuffer.from(cryptoBytes(ikm, undefined, true));
  } else throw new ERR_INVALID_ARG_TYPE('ikm', ['string', 'SecretKeyObject', 'ArrayBuffer', 'TypedArray', 'DataView', 'Buffer'], ikm);
  const bytes = (label: string, value: unknown): HostBytes => {
    if (typeof value === 'string' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return HostBuffer.from(cryptoBytes(value, undefined, true));
    throw new ERR_INVALID_ARG_TYPE(label, ['string', 'ArrayBuffer', 'TypedArray', 'DataView', 'Buffer'], value);
  };
  const saltBytes = bytes('salt', salt), infoBytes = bytes('info', info);
  if (typeof length !== 'number') throw new ERR_INVALID_ARG_TYPE('length', 'number', length);
  if (!Number.isInteger(length)) throw new ERR_OUT_OF_RANGE('length', 'an integer', length);
  if (length < 0 || length > Number.MAX_SAFE_INTEGER) throw new ERR_OUT_OF_RANGE('length', `>= 0 && <= ${Number.MAX_SAFE_INTEGER}`, length);
  if (infoBytes.byteLength > 1024) throw new ERR_OUT_OF_RANGE('info', 'must not contain more than 1024 bytes', infoBytes.byteLength);
  // RFC 5869 2.3: the output is at most 255 blocks of the digest.
  if (length > 255 * DIGEST_BYTES[name]!) throw Object.assign(new RangeError('Invalid key length'), { code: 'ERR_CRYPTO_INVALID_KEYLEN' });
  return { algorithm: name, key, salt: saltBytes, info: infoBytes, length };
}

function hkdfDerive({ algorithm, key, salt, info, length }: HkdfParameters): ArrayBuffer {
  // Node 24.21.0 answers a length of zero with this error, where its job has no bits to derive.
  if (length === 0) throw new Error('Deriving bits failed');
  const size = DIGEST_BYTES[algorithm]!;
  // Extract: PRK = HMAC(salt, IKM), the salt absent being a block of zeros, which an empty HMAC key is.
  const prk = HostBuffer.from(new Hmac(algorithm, salt).update(key).digest() as unknown as Uint8Array);
  // Expand: T(n) = HMAC(PRK, T(n-1) | info | n).
  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  const counter = new Uint8Array(1);
  for (let block = 1, offset = 0; offset < length; block += 1, offset += size) {
    counter[0] = block;
    previous = new Hmac(algorithm, prk).update(previous).update(info).update(counter).digest() as unknown as Uint8Array;
    out.set(previous.subarray(0, Math.min(size, length - offset)), offset);
  }
  prk.fill(0);
  key.fill(0);
  return out.buffer as ArrayBuffer;
}

function hkdfSync(digest: string, ikm: unknown, salt: unknown, info: unknown, length: number): ArrayBuffer {
  return hkdfDerive(hkdfParameters(digest, ikm, salt, info, length));
}

function hkdf(digest: string, ikm: unknown, salt: unknown, info: unknown, length: number, callback: (error: Error | null, derived?: ArrayBuffer) => void): void {
  // Node validates its arguments synchronously and calls back later.
  const parameters = hkdfParameters(digest, ikm, salt, info, length);
  validateFunction(callback, 'callback');
  setTimeout(() => {
    let derived: ArrayBuffer;
    try { derived = hkdfDerive(parameters); } catch (error) { callback(error as Error); return; }
    callback(null, derived);
  }, 0);
}

/** Node's defaults and option names (lib/internal/crypto/scrypt.js): N 16384, r 8, p 1, maxmem 32 MiB. */
function scryptParameters(password: unknown, salt: unknown, keylen: unknown, options: ScryptOptions = {}): { password: HostBytes; salt: HostBytes; keylen: number; N: number; r: number; p: number; maxmem: number } {
  // In Node's order (lib/internal/crypto/scrypt.js `check`): the password, the salt, then the length, each refused
  // by its own name. The length was checked first, so `scrypt()` with no arguments named "keylen" where Node names
  // "password" (Node's own test-crypto-scrypt, its `badargs`).
  const bytesOf = (value: unknown, name: string): HostBytes => {
    if (typeof value !== 'string' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      throw new ERR_INVALID_ARG_TYPE(name, ['string', 'ArrayBuffer', 'Buffer', 'TypedArray', 'DataView'], value);
    }
    return HostBuffer.from(cryptoBytes(value instanceof ArrayBuffer || ArrayBuffer.isView(value) || typeof value === 'string' ? value : new Uint8Array(value as SharedArrayBuffer), undefined, true));
  };
  const passwordBytes = bytesOf(password, 'password'), saltBytes = bytesOf(salt, 'salt');
  if (typeof keylen !== 'number') throw new ERR_INVALID_ARG_TYPE('keylen', 'number', keylen);
  if (!Number.isInteger(keylen) || keylen < 0 || keylen > 0x7fffffff) throw new ERR_OUT_OF_RANGE('keylen', '>= 0 && <= 2147483647', keylen);
  // Then the options, which are an object where given (`validateObject`): `null` is refused by name, not read.
  if (options === null || typeof options !== 'object') throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
  // The options as Node reads them (the same file): each name looked at for `undefined` and then read once more,
  // that second reading being the one checked and used; the short and long names of one parameter together refused;
  // a zero meaning the default. A value of the wrong type is ERR_INVALID_ARG_TYPE, one out of range ERR_OUT_OF_RANGE.
  const uint32 = (value: unknown, name: string): number => {
    if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new ERR_OUT_OF_RANGE(name, '>= 0 && <= 4294967295', value);
    return value;
  };
  const either = (short: 'N' | 'r' | 'p', long: 'cost' | 'blockSize' | 'parallelization', initial: number): number => {
    let chosen = initial;
    const hasShort = options[short] !== undefined;
    if (hasShort) chosen = uint32(options[short], short);
    if (options[long] !== undefined) {
      if (hasShort) throw Object.assign(new TypeError(`Option "${short}" cannot be used in combination with option "${long}"`), { code: 'ERR_INCOMPATIBLE_OPTION_PAIR' });
      chosen = uint32(options[long], long);
    }
    return chosen === 0 ? initial : chosen;
  };
  const N = either('N', 'cost', 16384), r = either('r', 'blockSize', 8), p = either('p', 'parallelization', 1);
  let maxmem = 32 * 1024 * 1024;
  if (options.maxmem !== undefined) {
    const given: unknown = options.maxmem;
    if (typeof given !== 'number') throw new ERR_INVALID_ARG_TYPE('maxmem', 'number', given);
    if (!Number.isInteger(given) || given < 0 || given > Number.MAX_SAFE_INTEGER) throw new ERR_OUT_OF_RANGE('maxmem', `>= 0 && <= ${Number.MAX_SAFE_INTEGER}`, given);
    if (given !== 0) maxmem = given;
  }
  // OpenSSL's own bounds (crypto/kdf/scrypt.c, and RFC 7914's): N a power of two above 1 and below 2^(16r); p at most
  // (2^30 - 1) / r; and the memory it needs, p*128*r for B and 128*r*(N+2) for V and the block, within maxmem. The last
  // was written 128*N*r, which let through N = 1024, r = 8 under maxmem 2^20, and the first two were missing: Node's own
  // test (test-crypto-scrypt.js, the `toobig` vectors) found "Missing expected exception" in the measure run.
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1
    || (16 * r < 53 && N >= 2 ** (16 * r)) || p > Math.floor((2 ** 30 - 1) / r) || p * 128 * r + 128 * r * (N + 2) > maxmem) {
    throw Object.assign(new RangeError('Invalid scrypt params: memory limit exceeded'), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });
  }
  return { password: passwordBytes, salt: saltBytes, keylen, N, r, p, maxmem };
}

function scryptDerive(parameters: ReturnType<typeof scryptParameters>): Buffer {
  const { password, salt, keylen, N, r, p, maxmem } = parameters;
  if (keylen === 0) return Buffer.from(new Uint8Array(0));
  return Buffer.from(nobleScrypt(password, salt, { N, r, p, dkLen: keylen, maxmem: maxmem + 1024 }));
}

function scryptSync(password: unknown, salt: unknown, keylen: number, options?: ScryptOptions): Buffer {
  return scryptDerive(scryptParameters(password, salt, keylen, options));
}

function scrypt(password: unknown, salt: unknown, keylen: number, options: ScryptOptions | ((error: Error | null, derived?: Buffer) => void), callback?: (error: Error | null, derived?: Buffer) => void): void {
  const done = typeof options === 'function' ? options : callback;
  const parameters = scryptParameters(password, salt, keylen, typeof options === 'function' ? undefined : options);
  validateFunction(done, 'callback');
  setTimeout(() => {
    let derived: Buffer;
    try { derived = scryptDerive(parameters); } catch (error) { done!(error as Error); return; }
    done!(null, derived);
  }, 0);
}

/** No FIPS provider is carried: Node built without one answers 0. */
function getFips(): number { return 0; }

/** No secure heap is carried: what Node 24.21.0 answers when started with none. */
function secureHeapUsed(): { total: number; used: number; utilization: number; min: number } {
  return { total: 0, used: 0, utilization: Number.NaN, min: 2 };
}

/**
 * An export Node has and this module does not carry (crypto-exports.ts): a function that throws Node's
 * ERR_FEATURE_UNAVAILABLE_ON_PLATFORM naming itself when called or constructed, so a program learns which call it
 * was at the call, not as "is not a function".
 */
function unavailable<Name extends NodeCryptoUnavailable>(name: Name): (...args: unknown[]) => never {
  const refuse = function (): never {
    throw Object.assign(new TypeError(`The feature node:crypto.${name} is unavailable on the current platform, which is being used to run Node.js`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  };
  Object.defineProperty(refuse, 'name', { value: name });
  return refuse;
}

// ============================================================================
// Sign and Verify (main functions jose uses)
// ============================================================================

/**
 * Calculates and returns a signature for data using the given private key
 * This is the one-shot API that jose uses
 */
function sign(
  algorithm: string | null | undefined,
  data: Buffer | Uint8Array,
  key: KeyLike,
  callback?: (error: Error | null, signature: Buffer) => void
): Buffer | void {
  // Get the actual key material and algorithm
  const keyInfo = extractKeyInfo(key);
  // An EC or Ed25519 key signs here and now; the callback form answers later, as Node's does.
  if (keyInfo.asymmetric) {
    const bytes = cryptoBytes(data, undefined, true);
    if (!callback) return signAsymmetric(algorithm, bytes, keyInfo.asymmetric, dsaEncodingOf(key));
    let made: Buffer;
    try { made = signAsymmetric(algorithm, bytes, keyInfo.asymmetric, dsaEncodingOf(key)); }
    catch (error) { setTimeout(() => callback(error as Error, null as unknown as Buffer), 0); return; }
    setTimeout(() => callback(null, made), 0);
    return;
  }
  const alg = algorithm || keyInfo.algorithm;

  if (!alg) {
    const error = new Error('Algorithm must be specified');
    if (callback) {
      callback(error, null as unknown as Buffer);
      return;
    }
    throw error;
  }

  // For async operation with callback
  if (callback) {
    signAsync(alg, data, keyInfo)
      .then(sig => callback(null, sig))
      .catch(err => callback(err, null as unknown as Buffer));
    return;
  }

  // Synchronous operation - we need to use a workaround
  // Store the promise result for later retrieval
  const result = signSync(alg, data, keyInfo, key);
  return result;
}

/**
 * Verifies the given signature for data using the given key
 */
function verify(
  algorithm: string | null | undefined,
  data: Buffer | Uint8Array,
  key: KeyLike,
  signature: Buffer | Uint8Array,
  callback?: (error: Error | null, result: boolean) => void
): boolean | void {
  const keyInfo = extractKeyInfo(key);
  if (keyInfo.asymmetric) {
    const answer = verifyAsymmetric(algorithm, cryptoBytes(data, undefined, true), keyInfo.asymmetric, cryptoBytes(signature, undefined, true), dsaEncodingOf(key));
    if (!callback) return answer;
    setTimeout(() => callback(null, answer), 0);
    return;
  }
  const alg = algorithm || keyInfo.algorithm;

  if (!alg) {
    const error = new Error('Algorithm must be specified');
    if (callback) {
      callback(error, false);
      return;
    }
    throw error;
  }

  if (callback) {
    verifyAsync(alg, data, keyInfo, signature)
      .then(result => callback(null, result))
      .catch(err => callback(err, false));
    return;
  }

  return verifySync(alg, data, keyInfo, signature, key);
}

// ============================================================================
// createSign / createVerify (streaming API)
// ============================================================================

function createSign(algorithm: string): Sign {
  return new Sign(algorithm);
}

function createVerify(algorithm: string): Verify {
  return new Verify(algorithm);
}

class Sign extends EventEmitter {
  #algorithm: string;
  #data: Uint8Array[] = [];

  constructor(algorithm: string) {
    super();
    this.#algorithm = algorithm;
  }

  update(data: string | Buffer | Uint8Array, encoding?: string): this {
    // A string's bytes by the encoding named, as Node reads it (`update(hex, 'hex')`); it was read as UTF-8 whatever was named.
    const buffer = typeof data === 'string' ? Buffer.from(cryptoBytes(data, encoding ?? 'utf8')) : data;
    this.#data.push(buffer);
    return this;
  }

  // NODE'S SIGN AND VERIFY ARE WRITABLE STREAMS (`class Sign extends stream.Writable`): a caller may write its data
  // and end the stream before it asks for the result, and code written against Node does (`signer.update(input);
  // signer.end(); signer.sign(key)`, a JWT's RS256 in a World's twin). With neither method the call threw "signer.end
  // is not a function" and the twin issued no key. `write` is `update`; `end` takes a last chunk and says 'finish'.
  write(chunk: string | Buffer | Uint8Array, encoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    this.update(chunk, typeof encoding === 'string' ? encoding : undefined);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(() => done(null));
    return true;
  }

  end(chunk?: string | Buffer | Uint8Array | (() => void), encoding?: string | (() => void), callback?: () => void): this {
    if (chunk !== undefined && typeof chunk !== 'function') this.update(chunk, typeof encoding === 'string' ? encoding : undefined);
    const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
    queueMicrotask(() => { this.emit('finish'); done?.(); });
    return this;
  }

  sign(privateKey: KeyLike, outputEncoding?: string): Buffer | string {
    const combined = concatBuffers(this.#data);
    const keyInfo = extractKeyInfo(privateKey);
    const signature = keyInfo.asymmetric
      ? signAsymmetric(this.#algorithm, combined, keyInfo.asymmetric, dsaEncodingOf(privateKey))
      : signSync(this.#algorithm, combined, keyInfo, privateKey);

    return outputEncoding ? digestResult(signature, outputEncoding) : signature;
  }
}

class Verify extends EventEmitter {
  #algorithm: string;
  #data: Uint8Array[] = [];

  constructor(algorithm: string) {
    super();
    this.#algorithm = algorithm;
  }

  update(data: string | Buffer | Uint8Array, encoding?: string): this {
    // A string's bytes by the encoding named, as Node reads it (`update(hex, 'hex')`); it was read as UTF-8 whatever was named.
    const buffer = typeof data === 'string' ? Buffer.from(cryptoBytes(data, encoding ?? 'utf8')) : data;
    this.#data.push(buffer);
    return this;
  }

  // NODE'S SIGN AND VERIFY ARE WRITABLE STREAMS (`class Sign extends stream.Writable`): a caller may write its data
  // and end the stream before it asks for the result, and code written against Node does (`signer.update(input);
  // signer.end(); signer.sign(key)`, a JWT's RS256 in a World's twin). With neither method the call threw "signer.end
  // is not a function" and the twin issued no key. `write` is `update`; `end` takes a last chunk and says 'finish'.
  write(chunk: string | Buffer | Uint8Array, encoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    this.update(chunk, typeof encoding === 'string' ? encoding : undefined);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(() => done(null));
    return true;
  }

  end(chunk?: string | Buffer | Uint8Array | (() => void), encoding?: string | (() => void), callback?: () => void): this {
    if (chunk !== undefined && typeof chunk !== 'function') this.update(chunk, typeof encoding === 'string' ? encoding : undefined);
    const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
    queueMicrotask(() => { this.emit('finish'); done?.(); });
    return this;
  }

  verify(publicKey: KeyLike, signature: Buffer | string, signatureEncoding?: string): boolean {
    const combined = concatBuffers(this.#data);
    const keyInfo = extractKeyInfo(publicKey);

    // The signature's bytes by the encoding named: `atob` into `Buffer.from(string)` re-encoded every byte above
    // 0x7f as two, so no base64 signature (what jsonwebtoken's jwa passes) could verify.
    const sig = typeof signature === 'string' ? Buffer.from(cryptoBytes(signature, signatureEncoding ?? 'utf8')) : signature;

    if (keyInfo.asymmetric) return verifyAsymmetric(this.#algorithm, combined, keyInfo.asymmetric, sig, dsaEncodingOf(publicKey));
    return verifySync(this.#algorithm, combined, keyInfo, sig, publicKey);
  }
}

// ============================================================================
// KeyObject class (for key management)
// ============================================================================

let keyInfoOf: (key: KeyObject) => KeyInfo;
class KeyObject {
  static {
    keyInfoOf = (key) => ({ keyData: key.#_keyData, algorithm: key.#_algorithm, type: key.#_type, format: key.#_asymmetric ? 'pem' : 'raw', ...(key.#_asymmetric ? { asymmetric: key.#_asymmetric } : {}) });
  }
  #_asymmetric?: AsymmetricKey;
  #_keyData: CryptoKey | Uint8Array;
  #_type: 'public' | 'private' | 'secret';
  #_algorithm?: string;

  constructor(type: 'public' | 'private' | 'secret', keyData: CryptoKey | Uint8Array, algorithm?: string, asymmetricKey?: AsymmetricKey) {
    this.#_type = type;
    this.#_keyData = keyData;
    this.#_algorithm = algorithm;
    this.#_asymmetric = asymmetricKey;
  }

  get type(): string {
    return this.#_type;
  }

  get asymmetricKeyType(): string | undefined {
    if (this.#_type === 'secret') return undefined;
    if (this.#_asymmetric) return this.#_asymmetric.kind;
    // Infer from algorithm
    if (this.#_algorithm?.includes('RSA')) return 'rsa';
    if (this.#_algorithm?.includes('EC') || this.#_algorithm?.includes('ES')) return 'ec';
    if (this.#_algorithm?.includes('Ed')) return 'ed25519';
    return undefined;
  }

  get symmetricKeySize(): number | undefined {
    if (this.#_type !== 'secret') return undefined;
    if (this.#_keyData instanceof Uint8Array) {
      return this.#_keyData.length * 8;
    }
    return undefined;
  }

  get asymmetricKeyDetails(): Record<string, unknown> | undefined {
    if (this.#_type === 'secret') return undefined;
    const held = this.#_asymmetric;
    return held?.kind === 'ec' ? { namedCurve: asymmetric.nodeCurveName(held.curve) } : {};
  }

  equals(other: unknown): boolean {
    if (!(other instanceof KeyObject) || other.#_type !== this.#_type) return false;
    const mine = this.#_asymmetric, theirs = other.#_asymmetric;
    if (mine && theirs) return mine.kind === theirs.kind && timingSafeEqual(mine.point, theirs.point);
    return this.#_keyData instanceof Uint8Array && other.#_keyData instanceof Uint8Array && timingSafeEqual(this.#_keyData, other.#_keyData);
  }

  export(options?: KeyEncoding): Buffer | string | Record<string, string> {
    if (this.#_asymmetric) return exportAsymmetric(this.#_asymmetric, this.#_type === 'private' ? 'private' : 'public', options);
    if (this.#_type === 'secret') {
      // A secret key: its bytes, or the `oct` JWK; any other format is Node's argument error.
      const format = options?.format;
      if (!(this.#_keyData instanceof Uint8Array)) throw new Error('Cannot export CryptoKey synchronously');
      if (format === undefined || format === 'buffer') return Buffer.from(this.#_keyData);
      if (format === 'jwk') return { kty: 'oct', k: Buffer.from(this.#_keyData).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
      throw Object.assign(new TypeError(`The property 'options.format' is invalid. Received '${String(format)}'`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    // Any other key (RSA) is held as the DER it was read from and nothing is known of its numbers: that DER can be
    // given back, and nothing else. Every other request is refused by name; it used to be answered with the same
    // bytes whatever was asked, a PEM or an encrypted key among them.
    if (options === undefined || options === null || typeof options !== 'object') throw new ERR_INVALID_ARG_TYPE('options', 'object', options);
    if (this.#_type === 'private') refuseKeyEncryption(options);
    if (!(this.#_keyData instanceof Uint8Array)) throw new Error('Cannot export CryptoKey synchronously');
    // An RSA key's numbers are read from its DER (crypto-rsa.ts), so it is written in any of its encodings.
    if (this.#_algorithm === 'RSA-SHA256') return exportRsa(this.#_keyData, this.#_type === 'private' ? 'private' : 'public', options);
    if (options.format !== 'der') unsupported(`Exporting this ${this.asymmetricKeyType ?? 'asymmetric'} key as ${String(options.format)}`);
    return Buffer.from(this.#_keyData);
  }
}

function createSecretKey(key: BinaryLike | ArrayBufferView, encoding?: string): KeyObject {
  // Node copies the key material, so a caller that reuses or zeroes its array
  // does not change the key this object holds.
  return new KeyObject('secret', Buffer.from(cryptoBytes(key, encoding, true)));
}

function createPublicKey(key: KeyLike): KeyObject {
  const keyInfo = extractKeyInfo(key);
  // A private key gives its public key, as Node's does.
  if (keyInfo.asymmetric) return keyObjectOf(asymmetric.publicOf(keyInfo.asymmetric), 'public');
  notAKey(key, keyInfo);
  // An RSA private key gives its public key too: its two public numbers as SPKI. It used to be handed back whole
  // under the name "public", so exporting that "public key" gave out the private key's own bytes.
  if (keyInfo.type === 'private' && keyInfo.algorithm === 'RSA-SHA256' && keyInfo.keyData instanceof Uint8Array) {
    try { return new KeyObject('public', rsa.rsaSpkiOf(rsa.rsaPrivateKeyFromDer(keyInfo.keyData)), keyInfo.algorithm); }
    catch (cause) {
      if (cause instanceof rsa.RsaKeyRefused) throw Object.assign(new Error(`error:1E08010C:DECODER routines::unsupported (${cause.message})`), { code: 'ERR_OSSL_UNSUPPORTED' });
      throw cause;
    }
  }
  if (keyInfo.type === 'private') return unsupported('Making a public key from a private key that is not RSA, EC or Ed25519');
  return new KeyObject('public', keyInfo.keyData as Uint8Array, keyInfo.algorithm);
}

function createPrivateKey(key: KeyLike): KeyObject {
  const keyInfo = extractKeyInfo(key);
  if (keyInfo.asymmetric) {
    if (!keyInfo.asymmetric.secret) throw Object.assign(new TypeError('The key is a public key; a private key is required.'), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' });
    return keyObjectOf(keyInfo.asymmetric, 'private');
  }
  notAKey(key, keyInfo);
  return new KeyObject('private', keyInfo.keyData as Uint8Array, keyInfo.algorithm);
}

/**
 * Bytes or text that are no key at all are refused, with OpenSSL's decoder error as Node passes it on. A caller
 * that tries a key as asymmetric first and as a secret on the refusal depends on it: jsonwebtoken does, and an
 * HS256 secret answered here as a "private key" was then refused as "must be a symmetric key".
 */
function notAKey(key: KeyLike, keyInfo: KeyInfo): void {
  if (key instanceof KeyObject || keyInfo.format !== 'raw') return;
  throw Object.assign(new Error('error:1E08010C:DECODER routines::unsupported'), { code: 'ERR_OSSL_UNSUPPORTED' });
}

/**
 * An RSA key written as asked: a private key as PKCS#8 or PKCS#1, a public key as SPKI or PKCS#1, each as DER or PEM,
 * or either as a JWK. `der` is the key as it is held (any of those four DER encodings).
 */
function exportRsa(der: Uint8Array, kind: 'public' | 'private', options: KeyEncoding | undefined): Buffer | string | Record<string, string> {
  if (options === null || typeof options !== 'object') throw new ERR_INVALID_ARG_TYPE('options', 'object', options);
  if (kind === 'private') refuseKeyEncryption(options);
  try {
    const key = kind === 'private' ? rsa.rsaPrivateKeyFromDer(der) : rsa.rsaPublicKeyFromDer(der);
    if (options.format === 'jwk') return rsa.rsaJwkOf(key, kind === 'private');
    const type = options.type as string | undefined;
    if (type === 'sec1') throw Object.assign(new Error('The selected key encoding sec1 can only be used for EC keys.'), { code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS' });
    const allowed = kind === 'private' ? ['pkcs1', 'pkcs8'] : ['pkcs1', 'spki'];
    if (type === undefined || !allowed.includes(type)) throw Object.assign(new TypeError(`The property 'options.type' is invalid. Received ${type === undefined ? 'undefined' : `'${type}'`}`), { code: 'ERR_INVALID_ARG_VALUE' });
    const bytes = kind === 'private'
      ? (type === 'pkcs1' ? rsa.rsaPkcs1Of(key as rsa.RsaPrivateKey) : rsa.rsaPkcs8Of(key as rsa.RsaPrivateKey))
      : (type === 'pkcs1' ? rsa.rsaPublicPkcs1Of(key) : rsa.rsaSpkiOf(key));
    if (options.format === 'der') return Buffer.from(bytes);
    if (options.format !== 'pem') throw Object.assign(new TypeError(`The property 'options.format' is invalid. Received ${options.format === undefined ? 'undefined' : `'${String(options.format)}'`}`), { code: 'ERR_INVALID_ARG_VALUE' });
    const label = type === 'pkcs1' ? (kind === 'private' ? 'RSA PRIVATE KEY' : 'RSA PUBLIC KEY') : kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
    return `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;
  } catch (cause) {
    if (cause instanceof rsa.RsaKeyRefused) throw Object.assign(new Error(`error:1E08010C:DECODER routines::unsupported (${cause.message})`), { code: 'ERR_OSSL_UNSUPPORTED' });
    throw cause;
  }
}

/** The JOSE name of the signature an EC or Ed25519 key makes: what this module's WebCrypto paths key their algorithm on. */
function asymmetricAlgorithm(key: AsymmetricKey): string {
  return key.kind === 'ed25519' ? 'Ed25519' : key.curve === 'P-256' ? 'ES256' : key.curve === 'P-384' ? 'ES384' : 'ES512';
}
function keyObjectOf(key: AsymmetricKey, kind: 'public' | 'private'): KeyObject {
  const held = kind === 'public' ? asymmetric.publicOf(key) : key;
  return new KeyObject(kind, asymmetric.derOf(held, kind === 'public' ? 'spki' : 'pkcs8'), asymmetricAlgorithm(key), held);
}
/**
 * What a private key's encoding says of encryption, read before anything is written. Node encrypts the key with
 * `cipher` under `passphrase` (lib/internal/crypto/keys.js parsePrivateKeyEncoding); this engine encrypts no key, so
 * the pair is refused by name. It is never dropped: a caller that asked for an encrypted key and was handed the
 * clear one would store or send its key in clear and could not know. One without the other, and either with JWK,
 * are Node's own argument errors.
 */
function refuseKeyEncryption(options: { format?: unknown; cipher?: unknown; passphrase?: unknown }): void {
  const cipher = options.cipher, passphrase = options.passphrase;
  if ((cipher === undefined || cipher === null) && passphrase === undefined) return;
  if (cipher === undefined || cipher === null) {
    throw Object.assign(new TypeError(`The property 'options.cipher' is invalid. Received ${cipher === null ? 'null' : 'undefined'}`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  if (typeof cipher !== 'string') throw new ERR_INVALID_ARG_TYPE('options.cipher', 'string', cipher);
  if (options.format === 'jwk') {
    throw Object.assign(new Error('The selected key encoding jwk does not support encryption.'), { code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS' });
  }
  if (passphrase === undefined) {
    throw Object.assign(new TypeError("The property 'options.passphrase' is invalid. Received undefined"), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  unsupported('Encrypting an exported private key (options.cipher with options.passphrase)');
}
/** `KeyObject.export` and a key pair's encodings: Node's choices and its refusals (lib/internal/crypto/keys.js). */
function exportAsymmetric(key: AsymmetricKey, kind: 'public' | 'private', options: KeyEncoding | undefined): Buffer | string | Record<string, string> {
  if (options === null || typeof options !== 'object') throw new ERR_INVALID_ARG_TYPE('options', 'object', options);
  // A public key's encoding has no encryption members in Node either: it reads `type` and `format` and no more.
  if (kind === 'private') refuseKeyEncryption(options);
  if (options.format === 'jwk') return asymmetric.jwkOf(key, kind === 'private');
  if (kind === 'private' && options.type === 'sec1' && key.kind !== 'ec') {
    throw Object.assign(new Error('The selected key encoding sec1 can only be used for EC keys.'), { code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS' });
  }
  if (options.type === 'pkcs1') {
    throw Object.assign(new Error('The selected key encoding pkcs1 can only be used for RSA keys.'), { code: 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS' });
  }
  const allowed: KeyEncodingType[] = kind === 'public' ? ['spki'] : key.kind === 'ec' ? ['pkcs8', 'sec1'] : ['pkcs8'];
  if (!allowed.includes(options.type as KeyEncodingType)) {
    throw Object.assign(new TypeError(`The property 'options.type' is invalid. Received ${options.type === undefined ? 'undefined' : `'${options.type}'`}`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  const der = asymmetric.derOf(key, options.type as KeyEncodingType);
  if (options.format === 'der') return Buffer.from(der);
  if (options.format !== 'pem') {
    throw Object.assign(new TypeError(`The property 'options.format' is invalid. Received ${options.format === undefined ? 'undefined' : `'${options.format}'`}`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  return asymmetric.pemOf(der, options.type as KeyEncodingType);
}

// ============================================================================
// generateKeyPair: Node's asynchronous key generation, done by WebCrypto.
// A browser has no synchronous key generation, so generateKeyPairSync stays
// absent; the callback form and its promisified form (which resolves
// { publicKey, privateKey }, as Node's custom promisify does) are complete for
// the types WebCrypto generates. jose's Node build promisifies this function
// when it loads, so its absence failed any module that imported jose.
// ============================================================================

type KeyEncoding = { type?: string; format?: string; cipher?: unknown; passphrase?: unknown };
type KeyPairOptions = { modulusLength?: number; publicExponent?: number; namedCurve?: string; paramEncoding?: unknown; publicKeyEncoding?: KeyEncoding; privateKeyEncoding?: KeyEncoding };

const NAMED_CURVES: Record<string, string> = {
  'prime256v1': 'P-256', 'p-256': 'P-256', 'secp256r1': 'P-256',
  'secp384r1': 'P-384', 'p-384': 'P-384',
  'secp521r1': 'P-521', 'p-521': 'P-521',
};

function keyPairAlgorithm(type: string, options: KeyPairOptions): { generate: AlgorithmIdentifier & Record<string, unknown>; usages: KeyUsage[]; name: string } {
  const exponent = (value: number | undefined): Uint8Array => {
    let rest = value ?? 0x10001;
    const bytes: number[] = [];
    while (rest > 0) { bytes.unshift(rest & 0xff); rest = Math.floor(rest / 256); }
    return new Uint8Array(bytes);
  };
  switch (type) {
    case 'rsa':
    case 'rsa-pss': {
      if (!Number.isInteger(options.modulusLength)) throw Object.assign(new TypeError('The "options.modulusLength" property must be of type number.'), { code: 'ERR_INVALID_ARG_TYPE' });
      const name = type === 'rsa' ? 'RSASSA-PKCS1-v1_5' : 'RSA-PSS';
      return { generate: { name, modulusLength: options.modulusLength, publicExponent: exponent(options.publicExponent), hash: 'SHA-256' }, usages: ['sign', 'verify'], name: type === 'rsa' ? 'RSA-SHA256' : 'RSA-PSS' };
    }
    case 'ec': {
      const curve = NAMED_CURVES[String(options.namedCurve ?? '').toLowerCase()];
      if (!curve) throw Object.assign(new TypeError(`Invalid EC curve name ${String(options.namedCurve)}`), { code: 'ERR_CRYPTO_INVALID_CURVE' });
      return { generate: { name: 'ECDSA', namedCurve: curve }, usages: ['sign', 'verify'], name: curve === 'P-256' ? 'ES256' : curve === 'P-384' ? 'ES384' : 'ES512' };
    }
    case 'ed25519':
      return { generate: { name: 'Ed25519' }, usages: ['sign', 'verify'], name: 'Ed25519' };
    case 'x25519':
      return { generate: { name: 'X25519' }, usages: ['deriveBits'], name: 'X25519' };
    default:
      throw Object.assign(new TypeError(`The argument 'type' must be a supported key type. Received '${type}'`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
}

function encodedKey(der: ArrayBuffer, encoding: KeyEncoding, kind: 'public' | 'private'): string | Buffer {
  if (kind === 'private') refuseKeyEncryption(encoding);
  const expected = kind === 'public' ? 'spki' : 'pkcs8';
  if (encoding.type !== undefined && encoding.type !== expected) {
    unsupported(`Encoding a ${kind} key as ${encoding.type}`);
  }
  const bytes = Buffer.from(der);
  if (encoding.format === 'der') return bytes;
  if (encoding.format !== 'pem') unsupported(`Encoding a key in the ${String(encoding.format)} format`);
  const label = kind === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY';
  const body = bytes.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

async function generateKeyPairAsync(type: string, options: KeyPairOptions): Promise<{ publicKey: KeyObject | string | Buffer; privateKey: KeyObject | string | Buffer }> {
  const algorithm = keyPairAlgorithm(type, options);
  const pair = await crypto.subtle.generateKey(algorithm.generate as AlgorithmIdentifier, true, algorithm.usages) as CryptoKeyPair;
  const publicKey = options.publicKeyEncoding
    ? encodedKey(await crypto.subtle.exportKey('spki', pair.publicKey), options.publicKeyEncoding, 'public')
    : new KeyObject('public', pair.publicKey, algorithm.name);
  const privateKey = options.privateKeyEncoding
    ? encodedKey(await crypto.subtle.exportKey('pkcs8', pair.privateKey), options.privateKeyEncoding, 'private')
    : new KeyObject('private', pair.privateKey, algorithm.name);
  return { publicKey, privateKey };
}

/**
 * A key pair made here and now, for the types whose arithmetic the engine carries (crypto-ec.ts): 'ec' over P-256,
 * P-384 and P-521, and 'ed25519'. Undefined for a type it does not carry, which stays WebCrypto's and asynchronous.
 */
function keyPairNow(type: string, options: KeyPairOptions): { publicKey: KeyObject | string | Buffer | Record<string, string>; privateKey: KeyObject | string | Buffer | Record<string, string> } | undefined {
  // RSA, made here in BigInt (crypto-rsa.ts): a caller that makes its key in a synchronous function cannot wait for
  // WebCrypto's promise, and "Synchronous generation of a rsa key pair" was refused whole (a World that mints its
  // signing key at start did not start). About a third of a second for 2048 bits where it was measured.
  if (type === 'rsa') {
    if (typeof options.modulusLength !== 'number') throw new ERR_INVALID_ARG_TYPE('options.modulusLength', 'number', options.modulusLength);
    const exponent = options.publicExponent ?? 0x10001;
    if (typeof exponent !== 'number' || !Number.isSafeInteger(exponent)) throw new ERR_INVALID_ARG_TYPE('options.publicExponent', 'number', exponent);
    let key: rsa.RsaPrivateKey;
    try { key = rsa.rsaGenerate(options.modulusLength, BigInt(exponent), (bytes) => new Uint8Array(randomBytes(bytes))); }
    catch (cause) {
      if (cause instanceof rsa.RsaKeyRefused) return unsupported(`Making this RSA key: ${cause.message}`);
      throw cause;
    }
    const secret = rsa.rsaPkcs8Of(key), open = rsa.rsaSpkiOf(key);
    return {
      publicKey: options.publicKeyEncoding ? exportRsa(open, 'public', options.publicKeyEncoding) : new KeyObject('public', open, 'RSA-SHA256'),
      privateKey: options.privateKeyEncoding ? exportRsa(secret, 'private', options.privateKeyEncoding) : new KeyObject('private', secret, 'RSA-SHA256'),
    };
  }
  let made: AsymmetricKey;
  if (type === 'ec') {
    if (typeof options.namedCurve !== 'string') throw new ERR_INVALID_ARG_TYPE('options.namedCurve', 'string', options.namedCurve);
    const curve = asymmetric.curveNamed(options.namedCurve);
    // A curve OpenSSL has and this engine does not carry is not an invalid name: it is refused as not carried.
    if (!curve && /^(secp\d+[kr]\d|sect\d+[kr]\d|prime\d+v\d|brainpoolP\d+[rt]1|c2[pt]nb\d+[vw]\d|wap-wsg-.*|Oakley-.*|SM2)$/i.test(options.namedCurve)) unsupported(`The curve ${options.namedCurve}`);
    if (!curve) throw Object.assign(new TypeError('Invalid EC curve name'), { code: 'ERR_CRYPTO_INVALID_CURVE' });
    // `paramEncoding`: 'named' is what is written; 'explicit' writes the curve's whole parameters, which is not.
    if (options.paramEncoding !== undefined && options.paramEncoding !== 'named') {
      if (options.paramEncoding === 'explicit') unsupported("Encoding an EC key's curve explicitly (paramEncoding 'explicit')");
      throw Object.assign(new TypeError(`The property 'options.paramEncoding' is invalid. Received '${String(options.paramEncoding)}'`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    made = asymmetric.generateKey('ec', curve);
  } else if (type === 'ed25519') made = asymmetric.generateKey('ed25519');
  else return undefined;
  return {
    publicKey: options.publicKeyEncoding ? exportAsymmetric(asymmetric.publicOf(made), 'public', options.publicKeyEncoding) : keyObjectOf(made, 'public'),
    privateKey: options.privateKeyEncoding ? exportAsymmetric(made, 'private', options.privateKeyEncoding) : keyObjectOf(made, 'private'),
  };
}

function generateKeyPairSync(type: string, options: KeyPairOptions = {}): { publicKey: unknown; privateKey: unknown } {
  const pair = keyPairNow(type, options);
  if (pair) return pair;
  // Argument errors are Node's; a type that is valid and not carried is refused by name.
  keyPairAlgorithm(type, options);
  return unsupported(`Synchronous generation of a ${type} key pair`);
}

function generateKeyPair(type: string, options: KeyPairOptions | ((error: Error | null, publicKey?: unknown, privateKey?: unknown) => void), callback?: (error: Error | null, publicKey?: unknown, privateKey?: unknown) => void): void {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof callback !== 'function') throw Object.assign(new TypeError('The "callback" argument must be of type function.'), { code: 'ERR_INVALID_ARG_TYPE' });
  const done = callback;
  // Argument errors throw synchronously, as Node's do. A type made here gives KeyObjects that export synchronously.
  // RSA asked for with a callback stays WebCrypto's: it is made off this thread, where making it here would hold it.
  const now = type === 'rsa' ? undefined : keyPairNow(type, options ?? {});
  if (now) { setTimeout(() => done(null, now.publicKey, now.privateKey), 0); return; }
  keyPairAlgorithm(type, options ?? {});
  generateKeyPairAsync(type, options ?? {}).then(
    ({ publicKey, privateKey }) => done(null, publicKey, privateKey),
    (error) => done(error instanceof Error ? error : new Error(String(error))),
  );
}
Object.defineProperty(generateKeyPair, Symbol.for('nodejs.util.promisify.custom'), {
  value: async (type: string, options?: KeyPairOptions) => (type === 'rsa' ? undefined : keyPairNow(type, options ?? {})) ?? generateKeyPairAsync(type, options ?? {}),
});

// ============================================================================
// Utility functions
// ============================================================================

function timingSafeEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

function getCiphers(): string[] {
  // What createCipheriv accepts, no more, as getHashes is createHash's.
  return cipherNames();
}

function getHashes(): string[] {
  // What createHash accepts, no more: a name here that createHash rejects
  // sends a guest down a branch that then throws.
  return HASH_ALGORITHMS.slice();
}

// ============================================================================
// Internal helpers
// ============================================================================

type KeyLike = string | Buffer | KeyObject | { key: string | Buffer | KeyObject | Record<string, unknown>; passphrase?: string; format?: string; type?: string; dsaEncoding?: string };

interface KeyInfo {
  keyData: Uint8Array | CryptoKey;
  /** An EC or Ed25519 key as its own numbers (crypto-ec.ts): what every synchronous operation on it uses. */
  asymmetric?: AsymmetricKey;
  algorithm?: string;
  type: 'public' | 'private' | 'secret';
  format: 'pem' | 'der' | 'jwk' | 'raw';
}

function getWebCryptoAlgorithm(nodeAlgorithm: string): { name: string; hash?: string } {
  const alg = nodeAlgorithm.toUpperCase().replace(/[^A-Z0-9]/g, '');

  // RSA algorithms
  if (alg.includes('RSA')) {
    if (alg.includes('PSS')) {
      const hash = alg.match(/SHA(\d+)/)?.[0] || 'SHA-256';
      return { name: 'RSA-PSS', hash: `SHA-${hash.replace('SHA', '')}` };
    }
    const hash = alg.match(/SHA(\d+)/)?.[0] || 'SHA-256';
    return { name: 'RSASSA-PKCS1-v1_5', hash: `SHA-${hash.replace('SHA', '')}` };
  }

  // ECDSA algorithms (ES256, ES384, ES512)
  if (alg.startsWith('ES') || alg.includes('ECDSA')) {
    const bits = alg.match(/\d+/)?.[0] || '256';
    const hash = bits === '512' ? 'SHA-512' : bits === '384' ? 'SHA-384' : 'SHA-256';
    return { name: 'ECDSA', hash };
  }

  // EdDSA (Ed25519)
  if (alg.includes('ED25519') || alg === 'EDDSA') {
    return { name: 'Ed25519' };
  }

  // HMAC
  if (alg.includes('HS') || alg.includes('HMAC')) {
    const bits = alg.match(/\d+/)?.[0] || '256';
    return { name: 'HMAC', hash: `SHA-${bits}` };
  }

  // Default to RSA with SHA-256
  return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
}

function extractKeyInfo(key: KeyLike): KeyInfo {
  try { return readKeyInfo(key); }
  catch (cause) {
    if (!(cause instanceof asymmetric.KeyRefused)) throw cause;
    // An encrypted key: Node asks for its passphrase, and with one decrypts it. This engine decrypts no key.
    if (cause.reason === 'encrypted') {
      const given = typeof key === 'object' && key !== null && !ArrayBuffer.isView(key) && !(key instanceof KeyObject) && (key as { passphrase?: unknown }).passphrase !== undefined;
      if (!given) throw Object.assign(new TypeError('Passphrase required for encrypted key'), { code: 'ERR_MISSING_PASSPHRASE' });
      return unsupported('Reading an encrypted private key (the key is encrypted and a passphrase was given)');
    }
    if (cause.reason === 'jwk') throw Object.assign(new TypeError('Invalid JWK data'), { code: 'ERR_CRYPTO_INVALID_JWK' });
    if (cause.reason === 'curve') {
      if (cause.message === 'Invalid JWK EC key') throw Object.assign(new TypeError('Invalid JWK EC key'), { code: 'ERR_CRYPTO_INVALID_CURVE' });
      return unsupported(`Reading this key: ${cause.message}`);
    }
    // OpenSSL's decoder error, as Node passes it on, with what was wrong with the key.
    throw Object.assign(new Error(`error:1E08010C:DECODER routines::unsupported (${cause.message})`), { code: 'ERR_OSSL_UNSUPPORTED' });
  }
}
function readKeyInfo(key: KeyLike): KeyInfo {
  if (key instanceof KeyObject) {
    return keyInfoOf(key);
  }

  if (typeof key === 'object' && key !== null && !ArrayBuffer.isView(key) && 'key' in key) {
    const inner = key.key;
    if (inner instanceof KeyObject) return keyInfoOf(inner);
    // A JWK, or DER whose encoding the caller names.
    if (key.format === 'jwk') {
      if (!inner || typeof inner !== 'object' || ArrayBuffer.isView(inner)) throw new ERR_INVALID_ARG_TYPE('key.key', 'object', inner);
      const fromJwk = asymmetric.keyFromJwk(inner as Record<string, unknown>);
      if (fromJwk) return keyInfoOfAsymmetric(fromJwk);
      throw Object.assign(new TypeError('Invalid JWK data'), { code: 'ERR_CRYPTO_INVALID_JWK' });
    }
    if (key.format === 'der') {
      // DER names its encoding (`type`), and a string of it names how it is written (`encoding`), as Node reads them.
      if (key.type === undefined) throw Object.assign(new TypeError("The property 'options.type' is invalid. Received undefined"), { code: 'ERR_INVALID_ARG_VALUE' });
      const bytes = typeof inner === 'string' ? Buffer.from(inner, ((key as { encoding?: string }).encoding ?? 'utf8') as BufferEncoding)
        : ArrayBuffer.isView(inner) ? inner as ArrayBufferView : undefined;
      if (bytes) {
        const fromDer = asymmetric.keyFromDer(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), key.type as KeyEncodingType | undefined);
        if (fromDer) return keyInfoOfAsymmetric(fromDer);
        if (typeof inner === 'string') return readKeyInfo(bytes as unknown as Buffer);
      }
    }
    return readKeyInfo(inner as string | Buffer);
  }

  const keyStr = typeof key === 'string' ? key : key.toString();
  // An EC or Ed25519 key is read into its own numbers; every other key keeps the bytes, as before.
  if (keyStr.includes('-----BEGIN')) {
    const fromPem = asymmetric.keyFromPem(keyStr);
    if (fromPem) return keyInfoOfAsymmetric(fromPem);
  }

  // Detect PEM format
  if (keyStr.includes('-----BEGIN')) {
    const isPrivate = keyStr.includes('PRIVATE');
    const isPublic = keyStr.includes('PUBLIC');

    // Extract the base64 content
    const base64 = keyStr
      .replace(/-----BEGIN [^-]+-----/, '')
      .replace(/-----END [^-]+-----/, '')
      .replace(/\s/g, '');

    // The key's own bytes: `atob` into `Buffer.from(string)` wrote every byte above 0x7f as two, so no key read here was its DER.
    const keyData = Buffer.from(base64, 'base64');

    // WHAT KIND OF KEY THIS IS, read from the key, never from its letters. The kind used to be guessed from the
    // PEM's text: "RSA" anywhere in it, else "EC" anywhere. A PKCS#8 or SPKI key's label names no algorithm
    // ("BEGIN PRIVATE KEY"), so the guess read the base64 body, where "EC" turns up by chance in about a third of
    // RSA keys of 2048 bits and "RSA" in almost none: `createPrivateKey(pem).asymmetricKeyType` answered "ec" for
    // an RSA key, and a signer that checks its key's kind before RS256 refused it (the OpenAI twin issued no
    // OPENAI_API_KEY, and LibreChat had no endpoint to draw its composer for). An EC or Ed25519 key never reaches
    // here (keyFromPem above), so what is left is RSA, by PKCS#1's own label or by the algorithm PKCS#8 and SPKI
    // carry (rsaEncryption 1.2.840.113549.1.1.1, or RSASSA-PSS ...1.10), or a key of a kind this engine does not
    // name, which stays unnamed.
    let algorithm: string | undefined;
    const label = /-----BEGIN ([^-]+)-----/.exec(keyStr)?.[1] ?? '';
    if (label === 'RSA PRIVATE KEY' || label === 'RSA PUBLIC KEY') algorithm = 'RSA-SHA256';
    else {
      const der = Buffer.from(base64, 'base64'), head = der.subarray(0, Math.min(der.byteLength, 48));
      const rsaFamily = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01]);
      const at = head.indexOf(rsaFamily);
      const member = at >= 0 ? head[at + rsaFamily.byteLength] : undefined;
      if (member === 0x01 || member === 0x0a) algorithm = 'RSA-SHA256';
    }

    return {
      keyData,
      algorithm,
      type: isPrivate ? 'private' : isPublic ? 'public' : 'secret',
      format: 'pem',
    };
  }

  // Raw key data
  const keyData = typeof key === 'string' ? Buffer.from(key) : key;
  return {
    keyData,
    type: 'secret',
    format: 'raw',
  };
}

function keyInfoOfAsymmetric(key: AsymmetricKey): KeyInfo {
  const kind = key.secret ? 'private' : 'public';
  return { keyData: asymmetric.derOf(key, kind === 'public' ? 'spki' : 'pkcs8'), asymmetric: key, algorithm: asymmetricAlgorithm(key), type: kind, format: 'pem' };
}

/**
 * The digest a signature algorithm's name asks for: the digest's own name in any case, with or without its hyphen,
 * or an alias that names one (`RSA-SHA256`, `ecdsa-with-SHA384`). The WHOLE name: `sha512-256` is its own digest
 * (SHA-512/256), not SHA-512 with something after it, which is how it was read. A digest OpenSSL has and this
 * engine does not carry is refused as that; a name that is no digest is Node's ERR_CRYPTO_INVALID_DIGEST.
 */
function signatureDigest(algorithm: string | null | undefined): string | undefined {
  if (algorithm === null || algorithm === undefined) return undefined;
  const name = String(algorithm).toLowerCase().replace(/^(rsa-|ecdsa-with-|id-rsassa-pkcs1-v1_5-with-)/, '').replace(/^sha-(\d)/, 'sha$1');
  if (HASH_ALGORITHMS.includes(name)) return name;
  if (/^(sha512-(224|256)|sha3-(224|256|384|512)|shake(128|256)|blake2[bs]\d+|ripemd(160)?|rmd160|sm3|md4|md5-sha1)$/.test(name)) return unsupported(`Signing or verifying with the digest ${String(algorithm)}`);
  throw Object.assign(new TypeError(`Invalid digest: ${String(algorithm)}`), { code: 'ERR_CRYPTO_INVALID_DIGEST' });
}
function dsaEncodingOf(key: unknown): DsaEncoding {
  const named = key && typeof key === 'object' && !ArrayBuffer.isView(key) ? (key as { dsaEncoding?: unknown }).dsaEncoding : undefined;
  if (named === undefined || named === 'der') return 'der';
  if (named === 'ieee-p1363') return 'ieee-p1363';
  throw Object.assign(new TypeError(`The property 'options.dsaEncoding' is invalid. Received '${String(named)}'`), { code: 'ERR_INVALID_ARG_VALUE' });
}
/** What a signature over an EC key hashes with: the digest named, or SHA-256 where none is, as OpenSSL's default is. */
function asymmetricDigest(key: AsymmetricKey, algorithm: string | null | undefined, data: Uint8Array): Uint8Array | undefined {
  const named = signatureDigest(algorithm);
  if (key.kind === 'ed25519') {
    // Ed25519 signs the message itself: OpenSSL refuses a digest, and Node passes its error on.
    if (named !== undefined) throw Object.assign(new Error('error:1C80007A:Provider routines::invalid digest'), { code: 'ERR_OSSL_INVALID_DIGEST' });
    return undefined;
  }
  return digestEngine(named ?? 'sha256').update(HostBuffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)).digest();
}
function signAsymmetric(algorithm: string | null | undefined, data: Uint8Array, key: AsymmetricKey, encoding: DsaEncoding): Buffer {
  if (!key.secret) throw Object.assign(new TypeError('Invalid key object type public, expected private.'), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' });
  return Buffer.from(asymmetric.signWith(key, data, asymmetricDigest(key, algorithm, data), encoding));
}
function verifyAsymmetric(algorithm: string | null | undefined, data: Uint8Array, key: AsymmetricKey, signature: Uint8Array, encoding: DsaEncoding): boolean {
  return asymmetric.verifyWith(key, data, asymmetricDigest(key, algorithm, data), signature, encoding);
}

function concatBuffers(buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

// Async implementations using WebCrypto
async function signAsync(algorithm: string, data: Uint8Array, keyInfo: KeyInfo): Promise<Buffer> {
  const webCryptoAlg = getWebCryptoAlgorithm(algorithm);

  // WebCrypto's own failure is the answer and reaches the caller's callback.
  // This used to be caught and answered with a hash of key||data called a
  // signature: every real verifier rejected it and no caller could tell it
  // from a signature that had been produced.
  const cryptoKey = await importKey(keyInfo, webCryptoAlg, ['sign']);

  // Sign the data - convert to ArrayBuffer for WebCrypto compatibility
  const signatureAlg = webCryptoAlg.hash
    ? { name: webCryptoAlg.name, hash: webCryptoAlg.hash }
    : { name: webCryptoAlg.name };

  const dataBuffer = new Uint8Array(data).buffer as ArrayBuffer;
  const signature = await crypto.subtle.sign(signatureAlg, cryptoKey, dataBuffer);
  return Buffer.from(signature);
}

async function verifyAsync(
  algorithm: string,
  data: Uint8Array,
  keyInfo: KeyInfo,
  signature: Uint8Array
): Promise<boolean> {
  const webCryptoAlg = getWebCryptoAlgorithm(algorithm);

  // As in signAsync: a failure to verify is reported, never answered with a
  // comparison against a fabricated signature.
  const cryptoKey = await importKey(keyInfo, webCryptoAlg, ['verify']);

  const verifyAlg = webCryptoAlg.hash
    ? { name: webCryptoAlg.name, hash: webCryptoAlg.hash }
    : { name: webCryptoAlg.name };

  // Convert to ArrayBuffer for WebCrypto compatibility
  const sigBuffer = new Uint8Array(signature).buffer as ArrayBuffer;
  const dataBuffer = new Uint8Array(data).buffer as ArrayBuffer;
  return await crypto.subtle.verify(verifyAlg, cryptoKey, sigBuffer, dataBuffer);
}

// Synchronous asymmetric signing has no browser primitive: WebCrypto's
// subtle.sign is async and there is no other. Node throws
// ERR_CRYPTO_UNSUPPORTED_OPERATION for an operation it cannot do, and so does
// this; what stood here returned syncHash(key || data) as a "signature".
/**
 * A signature made now, on the caller's thread, with a key that is not EC or Ed25519: an RSA key's, as
 * RSASSA-PKCS1-v1_5 (crypto-rsa.ts). It used to be refused whole ("Synchronous signing"), so `createSign('RSA-SHA256')`
 * and a JWT's RS256 could not be made here at all. `given` is the key as the caller passed it: a padding it names
 * other than PKCS#1's is refused by name, never signed as PKCS#1.
 */
function rsaPaddingOf(given: unknown): void {
  const padding = given && typeof given === 'object' && !ArrayBuffer.isView(given) ? (given as { padding?: unknown }).padding : undefined;
  if (padding !== undefined && padding !== 1) unsupported(`An RSA signature with padding ${String(padding)} (only RSA_PKCS1_PADDING is made on the caller's thread)`);
}
function rsaKeyBytes(keyInfo: KeyInfo, what: string): Uint8Array {
  if (keyInfo.algorithm !== 'RSA-SHA256' || !(keyInfo.keyData instanceof Uint8Array)) return unsupported(`${what} with a key that is not RSA, EC or Ed25519`);
  return keyInfo.keyData;
}
function signSync(algorithm: string, data: Uint8Array, keyInfo: KeyInfo, given?: unknown): Buffer {
  const der = rsaKeyBytes(keyInfo, 'Synchronous signing');
  rsaPaddingOf(given);
  const digest = signatureDigest(algorithm) ?? 'sha256';
  if (!rsa.rsaSignsWith(digest)) return unsupported(`An RSA signature with the digest ${digest}`);
  try {
    if (keyInfo.type !== 'private') throw Object.assign(new TypeError('The key is a public key; a private key is required.'), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' });
    return Buffer.from(rsa.rsaSign(digest, createHash(digest).update(data).digest() as Buffer, rsa.rsaPrivateKeyFromDer(der)));
  } catch (cause) {
    if (cause instanceof rsa.RsaKeyRefused) throw Object.assign(new Error(`error:1E08010C:DECODER routines::unsupported (${cause.message})`), { code: 'ERR_OSSL_UNSUPPORTED' });
    throw cause;
  }
}

function verifySync(
  algorithm: string,
  data: Uint8Array,
  keyInfo: KeyInfo,
  signature: Uint8Array,
  given?: unknown
): boolean {
  const der = rsaKeyBytes(keyInfo, 'Synchronous verification');
  rsaPaddingOf(given);
  const digest = signatureDigest(algorithm) ?? 'sha256';
  if (!rsa.rsaSignsWith(digest)) return unsupported(`An RSA signature with the digest ${digest}`);
  try {
    const key = keyInfo.type === 'private' ? rsa.rsaPrivateKeyFromDer(der) : rsa.rsaPublicKeyFromDer(der);
    return rsa.rsaVerify(digest, createHash(digest).update(data).digest() as Buffer, key, signature);
  } catch (cause) {
    if (cause instanceof rsa.RsaKeyRefused) throw Object.assign(new Error(`error:1E08010C:DECODER routines::unsupported (${cause.message})`), { code: 'ERR_OSSL_UNSUPPORTED' });
    throw cause;
  }
}

async function importKey(
  keyInfo: KeyInfo,
  algorithm: { name: string; hash?: string },
  usages: KeyUsage[]
): Promise<CryptoKey> {
  if (keyInfo.keyData instanceof CryptoKey) {
    return keyInfo.keyData;
  }

  const keyData = keyInfo.keyData;
  // Convert Uint8Array to ArrayBuffer for WebCrypto compatibility
  const keyBuffer = new Uint8Array(keyData).buffer as ArrayBuffer;

  // Determine import format
  if (keyInfo.format === 'pem') {
    // For PEM, we need to use SPKI (public) or PKCS8 (private)
    const format = keyInfo.type === 'private' ? 'pkcs8' : 'spki';

    const importAlg: RsaHashedImportParams | EcKeyImportParams | Algorithm =
      algorithm.name === 'ECDSA'
        ? { name: 'ECDSA', namedCurve: 'P-256' }
        : algorithm.name === 'Ed25519'
          ? { name: 'Ed25519' }
          : { name: algorithm.name, hash: algorithm.hash || 'SHA-256' };

    return await crypto.subtle.importKey(
      format,
      keyBuffer,
      importAlg,
      true,
      usages
    );
  }

  // For raw/secret keys, use raw import
  if (keyInfo.type === 'secret') {
    return await crypto.subtle.importKey(
      'raw',
      keyBuffer,
      { name: algorithm.name, hash: algorithm.hash },
      true,
      usages
    );
  }

  throw new Error(`Unsupported key format: ${keyInfo.format}`);
}

// ============================================================================
// Ciphers
// ============================================================================

const { Cipheriv, Decipheriv, createCipheriv, createDecipheriv } = createCipherClasses({
  toBuffer: (bytes) => Buffer.from(bytes),
  bytesOf: (value, encoding) => cryptoBytes(value, encoding, true),
  secretKeyBytes: (value) => {
    if (!(value instanceof KeyObject)) return undefined;
    const info = keyInfoOf(value);
    if (info.type !== 'secret' || !(info.keyData instanceof Uint8Array)) {
      throw Object.assign(new TypeError(`Invalid key object type ${info.type}, expected secret.`), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' });
    }
    return info.keyData;
  },
  encode: (bytes, encoding) => digestResult(bytes, encoding),
  error: cryptoError,
});

// ============================================================================
// Exports
// ============================================================================

// Every export of Node's `node:crypto` is here or this does not compile (crypto-exports.ts).
const nodeExports = {
  Certificate: unavailable('Certificate'),
  DiffieHellman: unavailable('DiffieHellman'),
  DiffieHellmanGroup: unavailable('DiffieHellmanGroup'),
  ECDH: unavailable('ECDH'),
  X509Certificate: unavailable('X509Certificate'),
  argon2: unavailable('argon2'),
  argon2Sync: unavailable('argon2Sync'),
  checkPrime: unavailable('checkPrime'),
  checkPrimeSync: unavailable('checkPrimeSync'),
  createDiffieHellman: unavailable('createDiffieHellman'),
  createDiffieHellmanGroup: unavailable('createDiffieHellmanGroup'),
  createECDH: unavailable('createECDH'),
  decapsulate: unavailable('decapsulate'),
  diffieHellman: unavailable('diffieHellman'),
  encapsulate: unavailable('encapsulate'),
  generateKey: unavailable('generateKey'),
  generateKeyPairSync,
  generateKeySync: unavailable('generateKeySync'),
  generatePrime: unavailable('generatePrime'),
  generatePrimeSync: unavailable('generatePrimeSync'),
  getCipherInfo: unavailable('getCipherInfo'),
  getCurves: unavailable('getCurves'),
  getDiffieHellman: unavailable('getDiffieHellman'),
  privateDecrypt: unavailable('privateDecrypt'),
  privateEncrypt: unavailable('privateEncrypt'),
  publicDecrypt: unavailable('publicDecrypt'),
  publicEncrypt: unavailable('publicEncrypt'),
  randomUUIDv7: unavailable('randomUUIDv7'),
  setEngine: unavailable('setEngine'),
  setFips: unavailable('setFips'),
  Hash,
  Hmac,
  Sign,
  Verify,
  hkdf,
  hkdfSync,
  scrypt,
  scryptSync,
  getFips,
  secureHeapUsed,
  Cipheriv,
  Decipheriv,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomFill,
  randomFillSync,
  randomUUID,
  randomInt,
  getRandomValues,
  hash,
  createHash,
  createHmac,
  createSign,
  createVerify,
  sign,
  verify,
  pbkdf2,
  pbkdf2Sync,
  timingSafeEqual,
  getCiphers,
  getHashes,
  constants,
  KeyObject,
  createSecretKey,
  createPublicKey,
  createPrivateKey,
  generateKeyPair,
  // Node's Web Crypto: the same object globalThis.crypto is in Node, and its SubtleCrypto
  webcrypto: crypto,
  subtle: crypto.subtle,
} satisfies Record<NodeCryptoExport, unknown>;
// `unsupported` is this engine's own, beside Node's names: what an implemented export throws for an algorithm it lacks.
const module = { ...nodeExports, unsupported };
// Node's four legacy names, as Node has them: not enumerable (so not among its 70 keys), three of them accessors that
// answer randomBytes, and `fips` an accessor over getFips and setFips. uid2 and tmp still call
// pseudoRandomBytes.
Object.defineProperties(module, {
  pseudoRandomBytes: { get: () => randomBytes, set: (value: unknown) => { Object.defineProperty(module, 'pseudoRandomBytes', { value, enumerable: false, configurable: true, writable: true }); }, enumerable: false, configurable: true },
  prng: { get: () => randomBytes, set: (value: unknown) => { Object.defineProperty(module, 'prng', { value, enumerable: false, configurable: true, writable: true }); }, enumerable: false, configurable: true },
  rng: { get: () => randomBytes, set: (value: unknown) => { Object.defineProperty(module, 'rng', { value, enumerable: false, configurable: true, writable: true }); }, enumerable: false, configurable: true },
  fips: { get: getFips, set: (value: unknown) => { nodeExports.setFips(value); }, enumerable: false, configurable: true },
});
return module as typeof module & { pseudoRandomBytes: typeof randomBytes; prng: typeof randomBytes; rng: typeof randomBytes; fips: number };

}
const cryptoModule = createCryptoModule();
export const webcrypto = cryptoModule.webcrypto;
export const subtle = cryptoModule.subtle;
export const { Cipheriv, Decipheriv, createCipheriv, createDecipheriv, randomBytes, randomFillSync, randomFill, randomUUID, randomInt, getRandomValues, unsupported, createHash, createHmac, hash, pbkdf2Sync, pbkdf2, sign, verify, createSign, createVerify, KeyObject, createSecretKey, createPublicKey, createPrivateKey, generateKeyPair, timingSafeEqual, getCiphers, getHashes } = cryptoModule;
export const { Certificate, DiffieHellman, DiffieHellmanGroup, ECDH, X509Certificate, argon2, argon2Sync, checkPrime, checkPrimeSync, createDiffieHellman, createDiffieHellmanGroup, createECDH, decapsulate, diffieHellman, encapsulate, generateKey, generateKeyPairSync, generateKeySync, generatePrime, generatePrimeSync, getCipherInfo, getCurves, getDiffieHellman, privateDecrypt, privateEncrypt, publicDecrypt, publicEncrypt, randomUUIDv7, setEngine, setFips, Hash, Hmac, Sign, Verify, hkdf, hkdfSync, scrypt, scryptSync, getFips, secureHeapUsed } = cryptoModule;
export type KeyObject = InstanceType<typeof KeyObject>;
export default cryptoModule;
