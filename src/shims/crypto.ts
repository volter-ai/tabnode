/**
 * Node.js crypto module shim
 *
 * Digests, HMAC and PBKDF2 are the real algorithms over pure-JS primitives,
 * because a guest calls them synchronously and WebCrypto is async-only.
 * Random values and asymmetric signing use WebCrypto, which does have them.
 */

import SHA from 'sha.js';
import { md5 } from '@noble/hashes/legacy.js';
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
export { constants };

interface DigestState {
  update(data: Uint8Array): DigestState;
  digest(): Uint8Array;
  clone?(): DigestState;
  [field: string]: unknown;
}

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
function cryptoBytes(value: unknown, encoding?: string, allowArrayBuffer = false): HostBytes {
  if (typeof value === 'string') {
    // `buffer` 6.0.3 predates base64url; the alphabet is a superset of base64's.
    if (encoding?.toLowerCase() === 'base64url') return HostBuffer.from(value, 'base64');
    if (encoding !== undefined && !HostBuffer.isEncoding(encoding)) {
      throw new TypeError(`Unknown encoding: ${encoding}`);
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
  const result = signSync(alg, data, keyInfo);
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

  return verifySync(alg, data, keyInfo, signature);
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
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
    this.#data.push(buffer);
    return this;
  }

  sign(privateKey: KeyLike, outputEncoding?: string): Buffer | string {
    const combined = concatBuffers(this.#data);
    const keyInfo = extractKeyInfo(privateKey);
    const signature = signSync(this.#algorithm, combined, keyInfo);

    if (outputEncoding === 'base64') {
      return btoa(String.fromCharCode(...signature));
    }
    if (outputEncoding === 'hex') {
      return Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return signature;
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
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
    this.#data.push(buffer);
    return this;
  }

  verify(publicKey: KeyLike, signature: Buffer | string, signatureEncoding?: string): boolean {
    const combined = concatBuffers(this.#data);
    const keyInfo = extractKeyInfo(publicKey);

    let sig: Buffer;
    if (typeof signature === 'string') {
      if (signatureEncoding === 'base64') {
        sig = Buffer.from(atob(signature));
      } else if (signatureEncoding === 'hex') {
        sig = Buffer.from(signature.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
      } else {
        sig = Buffer.from(signature);
      }
    } else {
      sig = signature;
    }

    return verifySync(this.#algorithm, combined, keyInfo, sig);
  }
}

// ============================================================================
// KeyObject class (for key management)
// ============================================================================

let keyInfoOf: (key: KeyObject) => KeyInfo;
class KeyObject {
  static {
    keyInfoOf = (key) => ({ keyData: key.#_keyData, algorithm: key.#_algorithm, type: key.#_type, format: 'raw' });
  }
  #_keyData: CryptoKey | Uint8Array;
  #_type: 'public' | 'private' | 'secret';
  #_algorithm?: string;

  constructor(type: 'public' | 'private' | 'secret', keyData: CryptoKey | Uint8Array, algorithm?: string) {
    this.#_type = type;
    this.#_keyData = keyData;
    this.#_algorithm = algorithm;
  }

  get type(): string {
    return this.#_type;
  }

  get asymmetricKeyType(): string | undefined {
    if (this.#_type === 'secret') return undefined;
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

  export(options?: { type?: string; format?: string }): Buffer | string {
    // Simplified export - returns the key data
    if (this.#_keyData instanceof Uint8Array) {
      return Buffer.from(this.#_keyData);
    }
    throw new Error('Cannot export CryptoKey synchronously');
  }
}

function createSecretKey(key: BinaryLike | ArrayBufferView, encoding?: string): KeyObject {
  // Node copies the key material, so a caller that reuses or zeroes its array
  // does not change the key this object holds.
  return new KeyObject('secret', Buffer.from(cryptoBytes(key, encoding, true)));
}

function createPublicKey(key: KeyLike): KeyObject {
  const keyInfo = extractKeyInfo(key);
  return new KeyObject('public', keyInfo.keyData as Uint8Array, keyInfo.algorithm);
}

function createPrivateKey(key: KeyLike): KeyObject {
  const keyInfo = extractKeyInfo(key);
  return new KeyObject('private', keyInfo.keyData as Uint8Array, keyInfo.algorithm);
}

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
  return ['aes-128-cbc', 'aes-256-cbc', 'aes-128-gcm', 'aes-256-gcm'];
}

function getHashes(): string[] {
  // What createHash accepts, no more: a name here that createHash rejects
  // sends a guest down a branch that then throws.
  return HASH_ALGORITHMS.slice();
}

// ============================================================================
// Internal helpers
// ============================================================================

type KeyLike = string | Buffer | KeyObject | { key: string | Buffer; passphrase?: string };

interface KeyInfo {
  keyData: Uint8Array | CryptoKey;
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
  if (key instanceof KeyObject) {
    return keyInfoOf(key);
  }

  if (typeof key === 'object' && 'key' in key) {
    return extractKeyInfo(key.key);
  }

  const keyStr = typeof key === 'string' ? key : key.toString();

  // Detect PEM format
  if (keyStr.includes('-----BEGIN')) {
    const isPrivate = keyStr.includes('PRIVATE');
    const isPublic = keyStr.includes('PUBLIC');

    // Extract the base64 content
    const base64 = keyStr
      .replace(/-----BEGIN [^-]+-----/, '')
      .replace(/-----END [^-]+-----/, '')
      .replace(/\s/g, '');

    const keyData = Buffer.from(atob(base64));

    // Try to detect algorithm from key header
    let algorithm: string | undefined;
    if (keyStr.includes('RSA')) algorithm = 'RSA-SHA256';
    else if (keyStr.includes('EC')) algorithm = 'ES256';
    else if (keyStr.includes('ED25519')) algorithm = 'Ed25519';

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
function signSync(_algorithm: string, _data: Uint8Array, _keyInfo: KeyInfo): Buffer {
  return unsupported('Synchronous signing');
}

function verifySync(
  _algorithm: string,
  _data: Uint8Array,
  _keyInfo: KeyInfo,
  _signature: Uint8Array
): boolean {
  return unsupported('Synchronous verification');
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
// Exports
// ============================================================================

return {
  unsupported,
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
};

}
const cryptoModule = createCryptoModule();
export const { randomBytes, randomFillSync, randomFill, randomUUID, randomInt, getRandomValues, unsupported, createHash, createHmac, hash, pbkdf2Sync, pbkdf2, sign, verify, createSign, createVerify, KeyObject, createSecretKey, createPublicKey, createPrivateKey, timingSafeEqual, getCiphers, getHashes } = cryptoModule;
export type KeyObject = InstanceType<typeof KeyObject>;
export default cryptoModule;
