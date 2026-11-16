/**
 * WHAT THE crypto BINDING'S V8 HALF SHARES (ADR-0018 §5, item 7): the engine's side of Node v24.21.0's
 * `src/crypto/crypto_util.h` and `crypto_util.cc`, over the glue's shapes (native/node/crypto_util.h):
 * - a thrown error: the glue records what Node's C++ throws (THROW_ERR_*, ThrowCryptoError) and this half makes the
 *   Error, as node_errors.h and ThrowCryptoError make it in V8 (`rethrow`);
 * - a value whose kind Node's C++ decides on, written as a TnValue (`Values`);
 * - an answer of several members, a TnFields, set on the object Node's C++ fills (`setFields`);
 * - a CryptoJob: its mode, its `run` (synchronous in the caller's thread, asynchronous on libuv's threadpool, or a
 *   WebCrypto promise), its `ondone`, and its completion through the `crypto_job_done` import (`CryptoJob`).
 *
 * ROUTING (ADR-0018 §5). Each call of the binding is answered by the engine device (`engine_device.ts`, the
 * browser's WebCrypto on the machine's thread) where WebCrypto defines the operation and the call is above the
 * measured bound, and by OpenSSL in libnode.so otherwise; the choice is each binding class's, per call. The bound is
 * browser-substrate ADR-0236 hole 12's reading, one for every call it applies to (a digest's or an HMAC's input, a
 * cipher update's whole blocks) above 4 KiB (the device 39.1 µs at 4 KiB against SHA-256 compiled to WebAssembly 35.9 µs; at 64 KiB 117 µs against 769 µs).
 */
import { Buffer } from '../buffer-module';
import { createMessagingBinding } from './messaging';
import { address, CRecord, libnode } from './libnode';
import { copyOut, cString, errorDetail, mallocAnswer, openssl, type OpensslExports } from './openssl';

/** CryptoJobMode (crypto_util.h:262). */
export const kCryptoJobAsync = 0;
export const kCryptoJobSync = 1;
export const kCryptoJobWebCrypto = 2;

/**
 * The measured bound above which a call is the device's (ADR-0236 hole 12): a digest's or an HMAC's input, and a
 * CipherBase update's whole blocks (crypto_cipher.ts); at or below it the process answers, by OpenSSL.
 */
export const DEVICE_BOUND = 4096;

/** WebCrypto's digests (WebCrypto §30, `SHA-1`, `SHA-256`, `SHA-384`, `SHA-512`) by OpenSSL's names for them. */
const WEBCRYPTO_DIGESTS: Record<string, string> = {
  sha1: 'SHA-1', 'sha-1': 'SHA-1', sha256: 'SHA-256', 'sha-256': 'SHA-256', sha384: 'SHA-384', 'sha-384': 'SHA-384',
  sha512: 'SHA-512', 'sha-512': 'SHA-512',
};
/** WebCrypto's name of a digest Node names (`sha256`, `SHA-256`, `RSA-SHA256` is not one), or none. */
export function webCryptoDigest(name: string): string | undefined {
  return WEBCRYPTO_DIGESTS[name.toLowerCase()];
}

/** The device answers a digest or an HMAC of `length` input bytes when WebCrypto defines it and it is above the bound. */
export function deviceAnswersDigest(name: string, length: number): boolean {
  return webCryptoDigest(name) !== undefined && length > DEVICE_BOUND;
}

/** The program's crypto exports, with OpenSSL started. */
export function glue(): OpensslExports { return openssl(); }

/**
 * node_errors.h's classes and default messages (44-236) for the codes the crypto glue throws: an Error of the class
 * with the message, and `code` set, as Node's C++ makes it.
 */
const CPP_ERRORS: Record<string, [ErrorConstructor, string?]> = {
  ERR_BUFFER_TOO_LARGE: [Error],
  ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED: [Error],
  ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS: [Error, 'The selected key encoding is incompatible with the key type'],
  ERR_CRYPTO_INITIALIZATION_FAILED: [Error, 'Initialization failed'],
  ERR_CRYPTO_INVALID_AUTH_TAG: [TypeError, 'Invalid authentication tag'],
  ERR_CRYPTO_INVALID_COUNTER: [TypeError, 'Invalid counter'],
  ERR_CRYPTO_INVALID_CURVE: [TypeError, 'Invalid EC curve name'],
  ERR_CRYPTO_INVALID_DIGEST: [TypeError, 'Invalid digest'],
  ERR_CRYPTO_INVALID_IV: [TypeError, 'Invalid initialization vector'],
  ERR_CRYPTO_INVALID_JWK: [TypeError, 'Invalid JWK format'],
  ERR_CRYPTO_INVALID_KEYLEN: [RangeError, 'Invalid key length'],
  ERR_CRYPTO_INVALID_KEYPAIR: [RangeError, 'Invalid key pair'],
  ERR_CRYPTO_INVALID_KEYTYPE: [RangeError, 'Invalid key type'],
  ERR_CRYPTO_INVALID_MESSAGELEN: [RangeError, 'Invalid message length'],
  ERR_CRYPTO_INVALID_SCRYPT_PARAMS: [RangeError, 'Invalid scrypt params'],
  ERR_CRYPTO_INVALID_STATE: [Error, 'Invalid state'],
  ERR_CRYPTO_INVALID_TAG_LENGTH: [RangeError, 'Invalid taglength'],
  ERR_CRYPTO_JOB_INIT_FAILED: [Error, 'Failed to initialize crypto job config'],
  ERR_CRYPTO_JWK_UNSUPPORTED_CURVE: [Error],
  ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE: [Error, 'Unsupported JWK Key Type.'],
  ERR_CRYPTO_OPERATION_FAILED: [Error, 'Operation failed'],
  ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH: [RangeError, 'Input buffers must have the same byte length'],
  ERR_CRYPTO_UNKNOWN_CIPHER: [Error, 'Unknown cipher'],
  ERR_CRYPTO_UNKNOWN_DH_GROUP: [Error, 'Unknown DH group'],
  ERR_CRYPTO_UNSUPPORTED_OPERATION: [Error, 'Unsupported crypto operation'],
  ERR_ILLEGAL_CONSTRUCTOR: [Error, 'Illegal constructor'],
  ERR_INVALID_ARG_TYPE: [TypeError],
  ERR_INVALID_ARG_VALUE: [TypeError],
  ERR_INVALID_THIS: [TypeError],
  ERR_MEMORY_ALLOCATION_FAILED: [RangeError, 'Failed to allocate memory'],
  ERR_MISSING_PASSPHRASE: [TypeError],
  ERR_OPERATION_FAILED: [TypeError],
  ERR_OUT_OF_RANGE: [RangeError],
  ERR_STRING_TOO_LONG: [Error],
};

/** An error as Node's C++ `THROW_ERR_<code>` makes it (node_errors.h): its class, its message, its `code`. */
export function cppError(code: string, message?: string): Error {
  const [Kind, fallback] = CPP_ERRORS[code] ?? [Error];
  const error = new Kind(message ?? fallback ?? '') as Error & { code?: string };
  error.code = code;
  return error;
}

/** The libraries `error::Decorate` names (crypto_util.cc:583-627), by `ERR_LIB_*` number. */
const ERROR_LIBRARIES: Record<number, string> = {
  2: 'SYS', 3: 'BN', 4: 'RSA', 5: 'DH', 6: 'EVP', 7: 'BUF', 8: 'OBJ', 9: 'PEM', 10: 'DSA', 11: 'X509', 13: 'ASN1',
  14: 'CONF', 15: 'CRYPTO', 16: 'EC', 20: 'SSL', 32: 'BIO', 33: 'PKCS7', 34: 'X509V3', 35: 'PKCS12', 36: 'RAND',
  37: 'DSO', 38: 'ENGINE', 39: 'OCSP', 40: 'UI', 41: 'COMP', 42: 'ECDSA', 43: 'ECDH', 44: 'OSSL_STORE', 45: 'FIPS',
  46: 'CMS', 47: 'TS', 48: 'HMAC', 50: 'CT', 51: 'ASYNC', 52: 'KDF', 53: 'SM2', 128: 'USER',
};

/** error::Decorate (crypto_util.cc:535-650): `library`, `reason` and `code` of the OpenSSL error `code`. */
export function decorate(error: Error & Record<string, unknown>, code: number): void {
  if (!code) return;
  const { library, reason, reasonCode } = errorDetail(code);
  if (library) error.library = library;
  if (reason) {
    error.reason = reason;
    const name = ERROR_LIBRARIES[glue().tabnode_err_lib(code)];
    const lib = name ? `${name}_` : '';
    const prefix = lib === 'SSL_' ? '' : 'OSSL_';
    error.code = `ERR_${prefix}${lib}${reasonCode}`;
  }
}

/** The error the glue recorded, made as Node's C++ makes it in V8, and the record cleared; none where none is. */
export function takeThrown(): Error | undefined {
  const exports = glue();
  if (!exports.tabnode_thrown()) return undefined;
  const code = cString(exports.tabnode_thrown_code()) ?? '';
  const messageAt = address(exports.tabnode_thrown_message());
  const message = messageAt ? cString(messageAt) ?? '' : undefined;
  let error: Error & Record<string, unknown>;
  if (code) {
    error = cppError(code, message) as Error & Record<string, unknown>;
  } else {
    // ThrowCryptoError: the message, the rest of the queue as opensslErrorStack, and Decorate.
    error = new Error(message ?? '') as Error & Record<string, unknown>;
    const count = exports.tabnode_thrown_stack_count() >>> 0;
    if (count > 0) {
      const stack: string[] = [];
      for (let index = 0; index < count; index++) stack.push(cString(exports.tabnode_thrown_stack(index)) ?? '');
      error.opensslErrorStack = stack;
    }
    decorate(error, exports.tabnode_thrown_err() >>> 0);
  }
  exports.tabnode_thrown_clear();
  return error;
}

/** Throws what the glue recorded, if anything: called after every export that may throw. */
export function rethrow(): void {
  const error = takeThrown();
  if (error) throw error;
}

/** `value` after a call of the glue, or the error it recorded. */
export function checked<T>(value: T): T {
  rethrow();
  return value;
}

/** A malloc'd answer (`(…, size_t* length) => char*`) or the error the glue recorded for its null. */
export function answer(call: (lengthAt: number) => number): Uint8Array {
  const bytes = mallocAnswer(call);
  rethrow();
  if (bytes === null) throw cppError('ERR_CRYPTO_OPERATION_FAILED');
  return bytes;
}

/** A Buffer of the bytes (Buffer::Copy). */
export function toBuffer(bytes: Uint8Array): Buffer { return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
/** An ArrayBuffer of the bytes, its own (ByteSource::ToArrayBuffer). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

/** The bytes of a buffer source (ArrayBufferOrViewContents), a view of them. */
export function bufferSource(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
    return new Uint8Array(value as ArrayBuffer);
  }
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('The argument must be an ArrayBuffer or an ArrayBufferView');
}
export function isAnyBufferSource(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
}

/** Node's StringBytes::Encode of `bytes` in `encoding` ('buffer' or none: a Buffer). */
export function encodeBytes(bytes: Uint8Array, encoding: unknown): Buffer | string {
  const buffer = toBuffer(bytes);
  if (encoding === undefined || encoding === 'buffer' || typeof encoding !== 'string') return buffer;
  return buffer.toString(encoding as BufferEncoding);
}

/** Node's StringBytes decode of a string argument in `encoding` (utf8 where none), or a buffer source's bytes. */
export function decodeInput(value: unknown, encoding?: unknown): Uint8Array {
  if (typeof value === 'string') {
    const name = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
    return Buffer.from(value, name as BufferEncoding);
  }
  return bufferSource(value);
}

// ---- TnValue (crypto_util.h) -----------------------------------------------------------------------------------

const TN_VALUE = 32, TN_PROPERTY = 40;
const encoder = new TextEncoder();

/** The handle data a KeyObjectHandle's value is written with (crypto_keys.ts registers how it is read). */
let keyDataOf: ((value: unknown) => number | undefined) | undefined;
export function setKeyDataReader(reader: (value: unknown) => number | undefined): void { keyDataOf = reader; }

/**
 * JavaScript values laid out as the glue's TnValue array (crypto_util.h), as V8 answers each one's kind: a string's
 * UTF-8 (and, for an object's member, its base64 bytes), a buffer source's bytes, a KeyObjectHandle's data, an
 * object's own enumerable members. The record is written once (`commit`) and freed after the call (`free`).
 */
export class Values {
  private readonly record: CRecord;
  constructor(private readonly values: readonly unknown[]) {
    this.record = new CRecord(values.length * TN_VALUE);
    values.forEach((value, index) => this.write(index * TN_VALUE, value, false));
  }

  private write(slot: number, value: unknown, member: boolean): void {
    const record = this.record;
    const kind = (k: number) => record.int32(slot, k);
    if (value === undefined) return kind(0);
    if (value === null) return kind(1);
    if (typeof value === 'number') {
      kind(Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && !Object.is(value, -0) ? 2 : 3);
      record.float64(slot + 8, value);
      return;
    }
    if (typeof value === 'boolean') {
      kind(4);
      record.float64(slot + 8, value ? 1 : 0);
      return;
    }
    if (typeof value === 'string') {
      kind(5);
      const bytes = encoder.encode(value);
      record.pointer(slot + 16, record.data(bytes));
      record.uint32(slot + 20, bytes.byteLength);
      if (member) {
        const decoded = Buffer.from(value, 'base64');
        record.pointer(slot + 24, record.data(decoded));
        record.uint32(slot + 28, decoded.byteLength);
      }
      return;
    }
    if (isAnyBufferSource(value)) {
      kind(6);
      const bytes = bufferSource(value);
      record.pointer(slot + 16, record.data(bytes));
      record.uint32(slot + 20, bytes.byteLength);
      return;
    }
    const key = keyDataOf?.(value);
    if (key !== undefined) {
      kind(7);
      record.uint32(slot + 16, key);
      return;
    }
    if (typeof value === 'object' || typeof value === 'function') {
      kind(8);
      const names = Object.keys(value as object);
      const members = record.room(names.length * TN_PROPERTY, 8);
      names.forEach((name, index) => {
        const at = members + index * TN_PROPERTY;
        record.pointer(at, record.string(name));
        this.write(at + 8, (value as Record<string, unknown>)[name], true);
      });
      record.pointer(slot + 16, members);
      record.uint32(slot + 20, names.length);
      return;
    }
    kind(0);
  }

  /** `use` with the array's address and its length, the record freed after. */
  call<T>(use: (at: number, length: number) => T): T {
    const at = this.record.commit();
    try { return use(at, this.values.length); } finally { this.record.free(); }
  }
}

// ---- TnFields (crypto_util.h) ----------------------------------------------------------------------------------

/** A TnFields answer's members set on `target`, as Node's C++ sets them (target->Set), in order. */
export function setFields(target: Record<string, unknown>, bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  for (let at = 0; at < bytes.byteLength;) {
    const kind = view.getUint8(at);
    const nameLength = view.getUint32(at + 1, true);
    const name = decoder.decode(bytes.subarray(at + 5, at + 5 + nameLength));
    const valueAt = at + 5 + nameLength;
    const valueLength = view.getUint32(valueAt, true);
    const value = bytes.subarray(valueAt + 4, valueAt + 4 + valueLength);
    at = valueAt + 4 + valueLength;
    switch (kind) {
      case 1: target[name] = decoder.decode(value); break;
      case 2: target[name] = Buffer.from(value).toString('base64url'); break;
      case 3: target[name] = new DataView(value.buffer, value.byteOffset, 8).getFloat64(0, true); break;
      case 4: target[name] = value.slice().buffer; break;
      case 5: target[name] = value[0] !== 0; break;
      case 6: target[name] = Buffer.from(value); break;
      default: throw new Error(`crypto: a field of kind ${kind}`);
    }
  }
  return target;
}

// ---- CryptoJob (crypto_util.h:271-480) -------------------------------------------------------------------------

/** The jobs scheduled on libuv's threadpool, by their address, until `crypto_job_done`. */
const scheduled = new Map<number, CryptoJob>();
/** A synchronous job's C state, freed with its object (Node's MakeWeak). */
const owned = new FinalizationRegistry<number>((job) => glue().tabnode_job_free(job));

/** CreateWebCryptoJobError (crypto_util.cc:743-773): an OperationError whose cause is the job's error. */
function webCryptoJobError(cause: unknown): Error {
  const DOMExceptionClass = (createMessagingBinding() as unknown as {
    DOMException: new (message: string, options: { name: string; cause: unknown }) => Error;
  }).DOMException;
  return new DOMExceptionClass('The operation failed for an operation-specific reason', { name: 'OperationError', cause });
}

/** ToWebCryptoJobResult (775-787): an ArrayBuffer as it is, a Buffer's ArrayBuffer, a boolean or an object. */
function webCryptoJobResult(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return value;
  if (Buffer.isBuffer(value)) return (value as Buffer).buffer.slice((value as Buffer).byteOffset,
    (value as Buffer).byteOffset + (value as Buffer).byteLength);
  return value;
}

/**
 * The V8 half of a CryptoJob: a job of `mode` whose work is the glue's (`job`, a CryptoJob* made by the subclass's
 * constructor through an export, AdditionalConfig there), or the device's (`device`: the job's call to the engine
 * device, ADR-0018 §5, which the subclass names where the device answers the call). `toResult` is the job's ToResult:
 * its `[err, result]`.
 */
export abstract class CryptoJob {
  ondone?: (error: unknown, result?: unknown) => void;
  protected job = 0;
  private settle?: { resolve(value: unknown): void; reject(error: unknown): void };

  constructor(readonly mode: number) {
    if (mode !== kCryptoJobAsync && mode !== kCryptoJobSync && mode !== kCryptoJobWebCrypto) {
      throw new Error('crypto: a job mode out of range');
    }
  }

  /** The job's C state, made by an export, owned by this object until scheduled. */
  protected adopt(job: number): void {
    rethrow();
    this.job = address(job);
    if (!this.job) throw cppError('ERR_CRYPTO_JOB_INIT_FAILED');
    owned.register(this, this.job, this);
  }

  /** The device's answer of this job (the binding's routing: ADR-0018 §5), or undefined where OpenSSL answers it. */
  protected device(): { call(sync: boolean): unknown; result(answer: unknown): unknown } | undefined { return undefined; }

  /** EncodeOutput of a successful job (ToResult's result). */
  protected abstract encode(): unknown;

  /** The job's [err, result] (DeriveBitsJob::ToResult, crypto_util.h:533-561, and its kin). */
  protected toResult(): [unknown, unknown] {
    const exports = glue();
    if (exports.tabnode_job_success(this.job)) return [undefined, this.encode()];
    const count = exports.tabnode_job_error_count(this.job) >>> 0;
    const errors: string[] = [];
    for (let index = 0; index < count; index++) errors.push(cString(exports.tabnode_job_error(this.job, index)) ?? '');
    // CryptoErrorStore::ToException: the last the message ("Ok" for none), the rest opensslErrorStack.
    const message = errors.length ? errors.pop()! : 'Ok';
    const error = new Error(message) as Error & { opensslErrorStack?: string[] };
    if (errors.length) error.opensslErrorStack = errors;
    return [error, undefined];
  }

  /** The job's bytes (its out_), copied out. */
  protected out(): Uint8Array {
    const exports = glue();
    return libnodeOut((lengthAt) => exports.tabnode_job_out(this.job, lengthAt));
  }

  /** CryptoJob::Run (crypto_util.h:380-407). */
  run(): unknown {
    const device = this.device();
    if (device) return this.runOnDevice(device);
    const exports = glue();
    if (this.mode === kCryptoJobWebCrypto) {
      const promise = new Promise((resolve, reject) => { this.settle = { resolve, reject }; });
      this.schedule();
      return promise;
    }
    if (this.mode === kCryptoJobAsync) { this.schedule(); return undefined; }
    exports.tabnode_job_run(this.job);
    return this.toResult();
  }

  /** ThreadPoolWork::ScheduleWork: the C state is the loop's now, and freed by it after `done`. */
  private schedule(): void {
    owned.unregister(this);
    const err = glue().tabnode_job_schedule(this.job);
    if (err !== 0) throw new Error(`crypto: uv_queue_work failed (${err})`);
    scheduled.set(this.job, this);
  }

  /** AfterThreadPoolWork (crypto_util.h:301-363): answers whether a callback was made. */
  done(status: number): boolean {
    scheduled.delete(this.job);
    const canceled = status !== 0;
    if (this.mode === kCryptoJobWebCrypto) {
      if (canceled) { this.reject(new Error('The operation was canceled')); return true; }
      let result: [unknown, unknown];
      try { result = this.toResult(); } catch (error) { this.reject(error); return true; }
      if (result[0] !== undefined) this.reject(result[0]); else this.resolve(result[1]);
      return true;
    }
    if (canceled) return false;
    let args: unknown[];
    try { args = this.toResult(); } catch (error) { args = [error]; }
    this.ondone?.(...(args as [unknown, unknown]));
    return true;
  }

  /** ResolveWebCrypto (crypto_util.h:443-514): resolved with the result, a thenable's own `then` hidden meanwhile. */
  private resolve(value: unknown): void {
    let result: unknown;
    try { result = webCryptoJobResult(value); } catch (error) { this.reject(error); return; }
    let deleteThen = false;
    if (result !== null && typeof result === 'object' && !Object.prototype.hasOwnProperty.call(result, 'then')) {
      Object.defineProperty(result, 'then', { value: undefined, enumerable: false, configurable: true, writable: true });
      deleteThen = true;
    }
    this.settle!.resolve(result);
    if (deleteThen) delete (result as { then?: unknown }).then;
  }

  /** RejectWebCrypto (516-528). */
  private reject(cause: unknown): void { this.settle!.reject(webCryptoJobError(cause)); }

  /** The device's answer in the job's mode: blocking (sync), or in the poll phase (async, WebCrypto). */
  private runOnDevice(device: { call(sync: boolean): unknown; result(answer: unknown): unknown }): unknown {
    if (this.mode === kCryptoJobSync) {
      try { return [undefined, device.result(device.call(true))]; } catch (error) { return [error, undefined]; }
    }
    const answered = (device.call(false) as Promise<unknown>).then((value) => device.result(value));
    if (this.mode === kCryptoJobWebCrypto) {
      return answered.then((value) => webCryptoJobResult(value), (error) => { throw webCryptoJobError(error); });
    }
    answered.then((result) => this.ondone?.(undefined, result), (error) => this.ondone?.(error));
    return undefined;
  }
}

/** A borrowed answer (`(…, size_t* length) => const void*`) copied out. */
function libnodeOut(call: (lengthAt: number) => number): Uint8Array {
  const program = libnode();
  const lengthAt = address(program.exports.tabnode_malloc(4));
  try {
    const at = address(call(lengthAt));
    const lengthBytes = program.read(lengthAt, 4);
    const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, true);
    return at && length ? copyOut(at, length) : new Uint8Array(0);
  } finally { program.exports.tabnode_free(lengthAt); }
}

/** The `crypto_job_done` import (native/node engine.h): the job's completion; nonzero where a callback was made. */
export function cryptoJobDone(job: number, status: number): number {
  const target = scheduled.get(address(job));
  if (!target) throw new Error(`node: libuv completed a crypto job no binding holds (${address(job)})`);
  return target.done(status) ? 1 : 0;
}
