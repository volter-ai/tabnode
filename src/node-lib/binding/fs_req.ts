/**
 * THE fs REQUEST OVER libuv (ADR-0018 §3, item 6): Node v24.21.0's FSReqBase, FSReqCallback and FSReqPromise
 * (src/node_file.h, src/node_file-inl.h), GetReqWrap, AsyncCall, SyncCall and FSReqAfterScope, as the V8 half of a
 * request whose uv_fs_t is native/node's (fs.h) in the process's memory. A synchronous call is uv_fs_* with no callback
 * and blocks in Linux; an asynchronous one runs on libuv's threadpool and its completion arrives as the program's
 * `fs_done` import (libnode.ts), which runs the request's After and its MakeCallback. Node's C++ hands libuv its
 * buffers' own bytes; a Buffer here is the realm's memory, not the process's, so a call's bytes are copied into the
 * request's room and a read's out of it, which is the one thing this layer adds to Node's.
 */
import type { Buffer as NodeBuffer } from '../buffer-module';
import { AsyncResource } from '../internals/runtime';
import { awaitRequest, type Libnode } from './libnode';
import { currentOwner, ownedRun, observeNodeRequest, forgetNodeRequest } from './handles';
import type { ProcessToken } from '../../process-tokens';
import { kUsePromises } from './fs';

export const kFsStatsFieldsNumber = 18;
export const kFsStatFsFieldsNumber = 8;

/** Node's `enum encoding`, by the names Buffer takes. */
export type Encoding = 'utf8' | 'utf16le' | 'latin1' | 'ascii' | 'base64' | 'base64url' | 'hex' | 'buffer';

/** ParseEncoding (src/api/encoding.cc): a string names one, case aside; anything else is the default. */
export function parseEncoding(value: unknown, fallback: Encoding = 'utf8'): Encoding {
  if (typeof value !== 'string') return fallback;
  switch (value.toLowerCase()) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': return 'utf16le';
    case 'latin1': case 'binary': return 'latin1';
    case 'ascii': return 'ascii';
    case 'base64': return 'base64';
    case 'base64url': return 'base64url';
    case 'hex': return 'hex';
    case 'buffer': return 'buffer';
    default: return fallback;
  }
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder();

/** BufferValue: a string's UTF-8 bytes, or a view's own bytes. */
export function pathBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return encoder.encode(String(value));
}
/** A path's bytes as an error names them (String::NewFromUtf8). */
export function pathText(bytes: Uint8Array): string { return utf8.decode(bytes); }

/** The scope's Buffer, and the conversions V8's half of a binding makes with it. */
export interface FsContext {
  Bytes(): typeof NodeBuffer;
  /** StringBytes::Encode: a Buffer of the bytes, or the string they are in the encoding. */
  encode(bytes: Uint8Array, encoding: Encoding): string | Uint8Array;
  /** Node's `internal/errors` determineSpecificType, which DetermineSpecificErrorType mirrors. */
  specificType(value: unknown): string;
}

export function fsContext(Bytes: () => typeof NodeBuffer, specificType: (value: unknown) => string): FsContext {
  return {
    Bytes,
    encode: (bytes, encoding) => {
      const buffer = Bytes().from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
      return encoding === 'buffer' ? Bytes().from(bytes) : (buffer as { toString(encoding: string): string }).toString(encoding);
    },
    specificType,
  };
}

// ---- errors, as Node's C++ makes them -----------------------------------------------------------------------------

const names = new Map<number, string>();
const messages = new Map<number, string>();

/** UVException (src/api/exceptions.cc): `code: message, syscall 'path' -> 'dest'`, with errno, code and the rest. */
export function uvException(lib: Libnode, err: number, syscall: string, message: string | null, path: string | null,
  dest: string | null): Error {
  let code = names.get(err);
  if (code === undefined) { code = lib.cString(lib.exports.tabnode_uv_err_name(err)) ?? ''; names.set(err, code); }
  let text = message;
  if (!text) {
    text = messages.get(err) ?? null;
    if (text === null) { text = lib.cString(lib.exports.tabnode_uv_strerror(err)) ?? ''; messages.set(err, text); }
  }
  let said = `${code}: ${text}, ${syscall}`;
  if (path !== null) said += ` '${path}'`;
  if (dest !== null) said += ` -> '${dest}'`;
  const error = new Error(said) as Error & Record<string, unknown>;
  error.errno = err;
  error.code = code;
  error.syscall = syscall;
  if (path !== null) error.path = path;
  if (dest !== null) error.dest = dest;
  return error;
}

/** errors::errno_string: a positive errno's name, and none for any other number. */
function errnoString(lib: Libnode, errorno: number): string {
  if (errorno <= 0) return '';
  const name = lib.cString(lib.exports.tabnode_uv_err_name(-errorno)) ?? '';
  return name.startsWith('Unknown system error') ? '' : name;
}

/** ErrnoException (exceptions.cc): `CODE, message 'path'`, with errno, code, path and syscall. */
export function errnoException(lib: Libnode, errorno: number, syscall: string | null, message: string | null,
  path: string | null): Error {
  const code = errnoString(lib, errorno);
  const text = message || (lib.cString(lib.exports.tabnode_strerror(errorno)) ?? '');
  let said = `${code}, ${text}`;
  if (path !== null) said += ` '${path}'`;
  const error = new Error(said) as Error & Record<string, unknown>;
  error.errno = errorno;
  error.code = code;
  if (path !== null) error.path = path;
  if (syscall !== null) error.syscall = syscall;
  return error;
}

/** THROW_ERR_<code> (src/node_errors.h): the error's class with its message, and `code`. */
export function codeError(code: string, message: string, Kind: ErrorConstructor = Error): Error {
  return Object.assign(new Kind(message), { code });
}

/** The error a composite call of native/node decided (fs.h tabnode_fs_error), made as V8 would make it. */
export function recordedError(lib: Libnode): Error {
  const x = lib.exports;
  const text = (pointer: number): string | null => { const value = lib.cString(pointer); return value ? value : null; };
  const kind = x.tabnode_fs_error_kind(), errorno = x.tabnode_fs_error_errno();
  if (kind === 1) return uvException(lib, errorno, text(x.tabnode_fs_error_syscall()) ?? '', null, text(x.tabnode_fs_error_path()), text(x.tabnode_fs_error_dest()));
  if (kind === 2) return errnoException(lib, errorno, text(x.tabnode_fs_error_syscall()), text(x.tabnode_fs_error_message()), text(x.tabnode_fs_error_path()));
  return codeError(text(x.tabnode_fs_error_code()) ?? '', text(x.tabnode_fs_error_message()) ?? '');
}

/** GetValidatedFd (src/util.cc). */
export function validatedFd(context: FsContext, value: unknown): number {
  if (typeof value !== 'number') {
    throw codeError('ERR_INVALID_ARG_TYPE', `The "fd" argument must be of type number. Received ${context.specificType(value)}`, TypeError);
  }
  const outOfRange = value < 0 || value > 2147483647;
  if (outOfRange || !Number.isSafeInteger(value)) {
    throw codeError('ERR_OUT_OF_RANGE', outOfRange && Number.isFinite(value)
      ? `The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received ${String(value)}`
      : `The value of "fd" is out of range. It must be an integer. Received ${String(value)}`, RangeError);
  }
  return value;
}

/** GetValidFileMode (src/util.cc), for access (F_OK..R_OK|W_OK|X_OK) and copyfile (0..EXCL|FICLONE|FICLONE_FORCE). */
export function validFileMode(value: unknown, type: 'access' | 'copyfile'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw codeError('ERR_OUT_OF_RANGE', 'mode is out of range', RangeError);
  } else if (value !== null && value !== undefined) {
    throw codeError('ERR_INVALID_ARG_TYPE', 'mode must be int32 or null/undefined', TypeError);
  }
  if (value === null || value === undefined) return 0;
  const mode = (value as number) | 0;
  if (mode < 0 || mode > 7) throw codeError('ERR_OUT_OF_RANGE', 'mode is out of range: >= 0 && <= 7', RangeError);
  return mode;
}

/** GetOffset: a number's integer, or -1 (the descriptor's own position) for anything else; Read takes a BigInt too. */
export function offsetOf(value: unknown): bigint {
  if (typeof value === 'bigint') return BigInt.asIntN(64, value);
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  return -1n;
}

// ---- the room: a request's arguments in the process's memory ------------------------------------------------------

/** The bytes a call writes after its request (fs.h `room`), each part at its offset; the request is zeroed. */
export class Room {
  private readonly parts: { at: number; bytes: Uint8Array }[] = [];
  size = 0;
  /** `bytes` at the next offset aligned to `align`, answered. */
  add(bytes: Uint8Array, align = 1): number {
    const at = this.reserve(bytes.length, align);
    if (bytes.length > 0) this.parts.push({ at, bytes });
    return at;
  }
  /** A NUL-terminated string (the room is zeroed, so its NUL is there). */
  cstr(bytes: Uint8Array): number {
    const at = this.add(bytes);
    this.size += 1;
    return at;
  }
  /** `length` zero bytes, for the C to fill. */
  reserve(length: number, align = 1): number {
    this.size = Math.ceil(this.size / align) * align;
    const at = this.size;
    this.size += length;
    return at;
  }
  /** A read's or a write's buffers (fs.c buffers_of): their lengths, then their bytes from the next 8-byte boundary. */
  buffers(lengths: readonly number[], bytes?: readonly Uint8Array[]): number {
    this.add(new Uint8Array(Uint32Array.from(lengths).buffer));
    const at = this.reserve(0, 8);
    if (bytes) for (const part of bytes) this.add(part);
    else this.reserve(lengths.reduce((sum, length) => sum + length, 0));
    return at;
  }
  /** The request, made with this room and its parts written: its pointer and its room's. */
  open(lib: Libnode): { request: number; base: number } {
    const request = lib.exports.tabnode_fs_new(this.size) >>> 0;
    if (request === 0) throw codeError('ERR_MEMORY_ALLOCATION_FAILED', 'Failed to allocate memory');
    const base = lib.exports.tabnode_fs_room(request) >>> 0;
    for (const { at, bytes } of this.parts) lib.write(base + at, bytes);
    return { request, base };
  }
}

// ---- FSReqBase ---------------------------------------------------------------------------------------------------

/** What Node's FSReqBase holds for its After: its kind's settling, and the call's syscall, data and encoding. */
export interface FSReq {
  readonly bigint: boolean;
  readonly owner: ProcessToken | null;
  /** The FSReqCallback the program made, or none for an FSReqPromise. */
  readonly callback: (object & { oncomplete?: unknown }) | null;
  readonly resource: AsyncResource | null;
  readonly promise: Promise<unknown> | null;
  readonly settle: { resolve(value: unknown): void; reject(error: unknown): void } | null;
  syscall: string;
  /** FSReqBase::Init's data: AsyncDestCall's destination, in the error. */
  dest: string | null;
  encoding: Encoding;
  withFileTypes: boolean;
}

const callbackRequests = new WeakMap<object, FSReq>();

/** `new FSReqCallback(bigint)` (NewFSReqCallback): an AsyncWrap whose `oncomplete` the program sets. */
export class FSReqCallback {
  oncomplete: unknown;
  context: unknown;
  constructor(bigint?: unknown) {
    callbackRequests.set(this, {
      bigint: bigint === true, owner: currentOwner(), callback: this, resource: new AsyncResource('FSREQCALLBACK'),
      promise: null, settle: null, syscall: '', dest: null, encoding: 'utf8', withFileTypes: false,
    });
  }
}

/** GetReqWrap: the FSReqCallback passed, a new FSReqPromise for `kUsePromises`, or none (a synchronous call). */
export function getReqWrap(value: unknown, bigint = false): FSReq | null {
  if (typeof value === 'object' && value !== null) return callbackRequests.get(value) ?? null;
  if (value !== kUsePromises) return null;
  let settle: FSReq['settle'] = null;
  const promise = new Promise<unknown>((resolve, reject) => { settle = { resolve, reject }; });
  return {
    bigint, owner: currentOwner(), callback: null, resource: null, promise, settle,
    syscall: '', dest: null, encoding: 'utf8', withFileTypes: false,
  };
}

/** SetReturnValue: an FSReqPromise's promise, an FSReqCallback's undefined. */
export function returnValue(req: FSReq): unknown { return req.promise ?? undefined; }

/** MakeCallback(oncomplete): in the request's owner's run and its async context, as an AsyncWrap's callback runs. */
function makeCallback(req: FSReq, args: unknown[]): void {
  const target = req.callback!;
  const fn = target.oncomplete;
  if (typeof fn !== 'function') return;
  ownedRun(req.owner, () => req.resource!.runInAsyncScope(fn as (...values: never[]) => unknown, target, ...(args as never[])), true, 'fs', fn);
}

/** FSReqCallback::Resolve and FSReqPromise::Resolve, inside its callback scope. */
export function resolve(req: FSReq, value: unknown): void {
  if (req.callback) { makeCallback(req, value === undefined ? [null] : [null, value]); return; }
  ownedRun(req.owner, () => req.settle!.resolve(value), true, 'fs', req.settle!.resolve);
}
/** FSReqCallback::Reject and FSReqPromise::Reject. */
export function reject(req: FSReq, error: unknown): void {
  if (req.callback) { makeCallback(req, [error]); return; }
  ownedRun(req.owner, () => req.settle!.reject(error), true, 'fs', req.settle!.reject);
}

/** The binding's global stat arrays (BindingData's stats_field_array and statfs_field_array, and their bigint twins). */
export interface StatArrays {
  statValues: Float64Array;
  bigintStatValues: BigInt64Array;
  statFsValues: Float64Array;
  bigintStatFsValues: BigInt64Array;
}
export function statArrays(): StatArrays {
  return {
    statValues: new Float64Array(2 * kFsStatsFieldsNumber),
    bigintStatValues: new BigInt64Array(2 * kFsStatsFieldsNumber),
    statFsValues: new Float64Array(kFsStatFsFieldsNumber),
    bigintStatFsValues: new BigInt64Array(kFsStatFsFieldsNumber),
  };
}

/** The C's stat fields (fs.c stat_fields), `count` of them, as doubles or as int64s. */
export function readStatFields(lib: Libnode, bigint: boolean, count: number, statfs = false): Float64Array | BigInt64Array {
  const x = lib.exports;
  const at = (statfs ? (bigint ? x.tabnode_fs_bigint_statfs_fields() : x.tabnode_fs_statfs_fields())
    : (bigint ? x.tabnode_fs_bigint_stat_fields() : x.tabnode_fs_stat_fields())) >>> 0;
  const bytes = lib.read(at, count * 8);
  return bigint ? new BigInt64Array(bytes.buffer, bytes.byteOffset, count) : new Float64Array(bytes.buffer, bytes.byteOffset, count);
}

/** FillGlobalStatsArray into `arrays` (a callback's), or a request's own array (FSReqPromise::ResolveStat). */
export function statResult(req: FSReq, arrays: StatArrays, fields: Float64Array | BigInt64Array): Float64Array | BigInt64Array {
  if (req.promise) return req.bigint ? BigInt64Array.from(fields as BigInt64Array) : Float64Array.from(fields as Float64Array);
  const global = req.bigint ? arrays.bigintStatValues : arrays.statValues;
  (global as Float64Array).set(fields as Float64Array, 0);
  return global;
}
export function statFsResult(req: FSReq, arrays: StatArrays, fields: Float64Array | BigInt64Array): Float64Array | BigInt64Array {
  if (req.promise) return req.bigint ? BigInt64Array.from(fields as BigInt64Array) : Float64Array.from(fields as Float64Array);
  const global = req.bigint ? arrays.bigintStatFsValues : arrays.statFsValues;
  (global as Float64Array).set(fields as Float64Array, 0);
  return global;
}

// ---- AsyncCall, SyncCall, the After ------------------------------------------------------------------------------

/** What a request's uv_fs_t answered: its result and its path (none where the dispatch itself failed). */
export interface Done { request: number; base: number; result: number; path: string | null }

/**
 * An After (node_file.cc AfterNoArgs, AfterStat, ...), past FSReqAfterScope::Proceed: it reads what it needs out of
 * the request and answers what to deliver once the request is gone (FSReqAfterScope::Clear runs first).
 */
export type After = (lib: Libnode, req: FSReq, done: Done) => () => void;

/** FSReqAfterScope: an error rejects with its UVException; otherwise the After runs. The request is freed before the
 *  answer is delivered, as Node clears its uv_fs_t first. */
function complete(lib: Libnode, req: FSReq, done: Done, after: After, proceed = true): void {
  let deliver: () => void;
  try {
    deliver = proceed && done.result < 0
      ? () => reject(req, uvException(lib, done.result, req.syscall, null, done.path, req.dest))
      : after(lib, req, done);
  } finally {
    lib.exports.tabnode_fs_free(done.request);
  }
  deliver();
}

/** An After that decides its own errors (AfterStatNoThrowIfNoEntry): no Proceed before it. */
export const ownErrors = Symbol('fs.after.ownErrors');
export type OwnErrorsAfter = After & { [ownErrors]?: true };

/** A call as AsyncCall, AsyncDestCall and SyncCall take it. */
export interface Call {
  syscall: string;
  /** FSReqWrapSync's path and dest, in a synchronous call's error. */
  path?: string | null;
  dest?: string | null;
  /** AsyncDestCall: the destination is the asynchronous request's data. */
  asyncDest?: boolean;
  encoding?: Encoding;
  after: After;
  /** The uv_fs_* call: the request, its room's address, and 1 for an asynchronous one. */
  call(request: number, base: number, async: 0 | 1): number;
  /** A synchronous call's value once it succeeded (none: undefined). */
  sync?(request: number, base: number, result: number): unknown;
  /** SyncCallAndThrowIf's predicate; a result it lets through that is an error answers undefined. */
  throwIf?(result: number): boolean;
}

/** AsyncCall where `req` is one, else SyncCallAndThrowOnError (or its predicate). Answers SetReturnValue's value. */
export function dispatch(lib: Libnode, room: Room, req: FSReq | null, call: Call): unknown {
  const { request, base } = room.open(lib);
  if (req) {
    req.syscall = call.syscall;
    req.dest = call.asyncDest ? call.dest ?? null : null;
    req.encoding = call.encoding ?? 'utf8';
    let err: number;
    try { err = call.call(request, base, 1); } catch (error) { lib.exports.tabnode_fs_free(request); throw error; }
    const proceed = !(call.after as OwnErrorsAfter)[ownErrors];
    // A dispatch that fails at once: `after` with that result and no path, now (AsyncDestCall).
    if (err < 0) complete(lib, req, { request, base, result: err, path: null }, call.after, proceed);
    else pend(lib, req, request, base, call.after, proceed);
    return returnValue(req);
  }
  try {
    const result = call.call(request, base, 0);
    if ((call.throwIf ?? isUvError)(result)) throw uvException(lib, result, call.syscall, null, call.path ?? null, call.dest ?? null);
    if (result < 0) return undefined;
    return call.sync ? call.sync(request, base, result) : undefined;
  } finally {
    lib.exports.tabnode_fs_free(request);
  }
}

/**
 * SyncCall with a context object (`ctx`): the error's number and syscall are put in it, and the call answers its
 * result, as Node's WriteBuffer, WriteString and OpenFileHandle forms do.
 */
export function syncCallWithContext(lib: Libnode, room: Room, ctx: unknown, syscall: string,
  call: (request: number, base: number) => number, value: (request: number, base: number, result: number) => unknown): unknown {
  const { request, base } = room.open(lib);
  try {
    const result = call(request, base);
    if (result < 0 && typeof ctx === 'object' && ctx !== null) Object.assign(ctx, { errno: result, syscall });
    return value(request, base, result);
  } finally {
    lib.exports.tabnode_fs_free(request);
  }
}

export const isUvError = (result: number): boolean => result < 0;

/**
 * A dispatched request until libuv completes it: libuv's request, which holds its loop while it is pending (the run's
 * end is libuv's, ADR-0018 item 7), and a request Node's getActiveResourcesInfo lists. Its completion is the program's
 * `fs_done`.
 */
function pend(lib: Libnode, req: FSReq, request: number, base: number, after: After, proceed: boolean): void {
  const listed = req.callback ?? req.promise!;
  observeNodeRequest(listed);
  awaitRequest(request, () => {
    forgetNodeRequest(listed);
    const x = lib.exports;
    complete(lib, req, { request, base, result: x.tabnode_fs_result(request), path: lib.cString(x.tabnode_fs_path(request)) }, after, proceed);
  });
}

// ---- the Afters every binding shares (node_file.cc) ---------------------------------------------------------------

export const afterNoArgs: After = (_lib, req) => () => resolve(req, undefined);
export const afterInteger: After = (_lib, req, done) => () => resolve(req, done.result);
/** AfterStringPtr: req->ptr in the request's encoding (readlink, realpath). */
export function afterStringPtr(context: FsContext): After {
  return (lib, req, done) => {
    const bytes = lib.cBytes(lib.exports.tabnode_fs_ptr(done.request)) ?? new Uint8Array(0);
    return () => resolve(req, context.encode(bytes, req.encoding));
  };
}
/** AfterStringPath: req->path in the request's encoding (mkdtemp). */
export function afterStringPath(context: FsContext): After {
  return (lib, req, done) => {
    const bytes = lib.cBytes(lib.exports.tabnode_fs_path(done.request)) ?? new Uint8Array(0);
    return () => resolve(req, context.encode(bytes, req.encoding));
  };
}
