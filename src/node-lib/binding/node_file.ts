/**
 * `internalBinding('fs')` OVER libuv (ADR-0018 §3, item 6): Node v24.21.0's src/node_file.cc, its methods in its
 * order, each the V8 half of the call: what it validates, which uv_fs_* it makes and with which After, what it answers.
 * The uv_fs_t and every decision Node makes in C (a recursive mkdir, readFileUtf8's loop, rmSync and the cpSync
 * calls) are native/node's (fs.c, fs_cp.c); `fs_req.ts` is FSReqBase. Only a realm whose program is `node`
 * (libnode.ts) has this binding; one with no program has the engine's own tree's (fs.ts).
 */
import { libnode, type HandleCallbacks, type Libnode } from './libnode';
import { HandleWrap } from './handle_wrap';
import {
  Room, dispatch, syncCallWithContext, getReqWrap, resolve, reject, uvException, recordedError, codeError,
  validatedFd, validFileMode, offsetOf, parseEncoding, pathBytes, pathText, statArrays, readStatFields, statResult,
  statFsResult, afterNoArgs, afterInteger, afterStringPtr, afterStringPath, ownErrors, FSReqCallback, kFsStatsFieldsNumber,
  type After, type FsContext, type FSReq, type OwnErrorsAfter, type StatArrays,
} from './fs_req';
import { kUsePromises } from './fs';
import { uvConstant } from './uv';
import { AsyncResource } from '../internals/runtime';
import { currentOwner, ownedRun, registerHandle, releaseHandle, refHandle, unrefHandle, observeNodeHandle, forgetNodeHandle,
  type OwnedHandle } from './handles';
import type { ProcessToken } from '../../process-tokens';

/** A call's buffers: Buffer::Data of each, as the bytes the C reads or writes. */
function viewOf(value: unknown): Uint8Array {
  const view = value as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function createNodeFileBinding(context: FsContext, arrays: StatArrays = statArrays()) {
  const encodeName = (bytes: Uint8Array, encoding: FSReq['encoding']) => context.encode(bytes, encoding);

  /** AfterStat and FSReqCallback::ResolveStat. */
  const afterStat: After = (lib, req, done) => {
    lib.exports.tabnode_fs_fill_request_stats(done.request);
    const fields = readStatFields(lib, req.bigint, kFsStatsFieldsNumber);
    return () => resolve(req, statResult(req, arrays, fields));
  };
  /** AfterStatNoThrowIfNoEntry: ENOENT and ENOTDIR answer undefined; any other error rejects. */
  const afterStatNoThrowIfNoEntry: OwnErrorsAfter = (lib, req, done) => {
    if (done.result === uvConstant('UV_ENOENT') || done.result === uvConstant('UV_ENOTDIR')) return () => resolve(req, undefined);
    if (done.result < 0) {
      const error = uvException(lib, done.result, req.syscall, null, done.path, req.dest);
      return () => reject(req, error);
    }
    return afterStat(lib, req, done);
  };
  afterStatNoThrowIfNoEntry[ownErrors] = true;
  const afterStatFs: After = (lib, req, done) => {
    lib.exports.tabnode_fs_fill_request_statfs(done.request);
    const fields = readStatFields(lib, req.bigint, 8, true);
    return () => resolve(req, statFsResult(req, arrays, fields));
  };
  /** AfterOpenFileHandle: a FileHandle on the descriptor, named by the request's path. */
  const afterOpenFileHandle: After = (_lib, req, done) => {
    const handle = new FileHandle(done.result, undefined, undefined, done.path ?? '');
    return () => resolve(req, handle);
  };
  /** AfterMkdirp: the first directory made, in the request's encoding, or undefined where none was. */
  const afterMkdirp: After = (lib, req, done) => {
    const first = lib.cBytes(lib.exports.tabnode_fs_first_path(done.request));
    return () => resolve(req, first === null || first.length === 0 ? undefined : encodeName(first, req.encoding));
  };
  /** AfterScanDir: the names (and types) uv_fs_scandir_next answers, one at a time. */
  const scanned = (lib: Libnode, request: number, encoding: FSReq['encoding'], withTypes: boolean):
    { names: unknown[]; types: number[] } | { error: number } => {
    const x = lib.exports;
    const names: unknown[] = [], types: number[] = [];
    for (;;) {
      const r = x.tabnode_fs_scandir_next(request);
      if (r === -4095) break;
      if (r !== 0) return { error: r };
      names.push(encodeName(lib.cBytes(x.tabnode_fs_scanned_name()) ?? new Uint8Array(0), encoding));
      if (withTypes) types.push(x.tabnode_fs_scanned_type());
    }
    return { names, types };
  };
  const afterScanDir: After = (lib, req, done) => {
    const list = scanned(lib, done.request, req.encoding, req.withFileTypes);
    if ('error' in list) {
      const error = uvException(lib, list.error, req.syscall, null, done.path, null);
      return () => reject(req, error);
    }
    return () => resolve(req, req.withFileTypes ? [list.names, list.types] : list.names);
  };
  /** A read's After: the bytes the C read copied into the program's buffers, then AfterInteger. */
  const afterRead = (targets: readonly Uint8Array[], dataAt: number): After => (lib, req, done) => {
    if (done.result > 0) scatter(lib, done.base + dataAt, done.result, targets);
    return () => resolve(req, done.result);
  };
  const scatter = (lib: Libnode, at: number, count: number, targets: readonly Uint8Array[]): void => {
    const bytes = lib.read(at, count);
    let from = 0;
    for (const target of targets) {
      if (from >= count) break;
      const take = Math.min(target.length, count - from);
      target.set(bytes.subarray(from, from + take), 0);
      from += take;
    }
  };

  /**
   * FileHandle (node_file.cc): an AsyncWrap over a descriptor, closed by `close()` with a promise (a CloseReq over
   * uv_fs_close), or at once by `closeSync()`, or given up by `releaseFD()`.
   */
  class FileHandle {
    #fd: number;
    #closing = false;
    #closed = false;
    #closePromise: Promise<void> | null = null;
    readonly #resource = new AsyncResource('FILEHANDLE');
    constructor(fd: number, _offset?: unknown, _length?: unknown, _originalName = '') {
      this.#fd = fd | 0;
    }
    get fd(): number { return this.#fd; }
    getAsyncId(): number { return this.#resource.asyncId(); }

    /** FileHandle::ClosePromise. */
    close(): Promise<void> {
      if (this.#closePromise) return this.#closePromise;
      if (this.#closed || this.#closing) throw codeError('ERR_INVALID_STATE', 'The FileHandle is already closed');
      const lib = libnode();
      const req = getReqWrap(kUsePromises)!;
      this.#closing = true;
      const room = new Room();
      const fd = this.#fd;
      const afterClose: After = (_lib, _req, done) => {
        this.#afterClose();
        if (done.result < 0) {
          const error = uvException(lib, done.result, 'close', null, null, null);
          return () => reject(req, error);
        }
        return () => resolve(req, undefined);
      };
      (afterClose as OwnErrorsAfter)[ownErrors] = true;
      dispatch(lib, room, req, { syscall: 'close', after: afterClose, call: (r, _b, a) => lib.exports.tabnode_fs_close(r, fd, a) });
      this.#closePromise = req.promise as Promise<void>;
      return this.#closePromise;
    }

    /** FileHandle::CloseSync: already closed or closing is a no-op. */
    closeSync(): void {
      if (this.#closed || this.#closing) return;
      const lib = libnode();
      const room = new Room();
      const { request } = room.open(lib);
      let ret: number;
      try { ret = lib.exports.tabnode_fs_close(request, this.#fd, 0); } finally { lib.exports.tabnode_fs_free(request); }
      this.#afterClose();
      if (ret < 0) throw uvException(lib, ret, 'close', null, null, null);
    }

    /** FileHandle::Release: just pretend that Close was called. */
    releaseFD(): number {
      const fd = this.#fd;
      this.#afterClose();
      return fd;
    }

    #afterClose(): void {
      this.#closing = false;
      this.#closed = true;
      this.#fd = -1;
    }
  }

  /** StatWatcher (src/node_stat_watcher.cc): a HandleWrap over a uv_fs_poll_t, made with it initialized. */
  class StatWatcher implements OwnedHandle, HandleCallbacks {
    onchange: unknown = null;
    readonly #handle: HandleWrap;
    readonly #bigint: boolean;
    readonly #resource = new AsyncResource('STATWATCHER');
    readonly #owner: ProcessToken | null = currentOwner();
    constructor(bigint?: unknown) {
      this.#bigint = bigint === true;
      // StatWatcher's constructor: CHECK_EQ(0, uv_fs_poll_init(...)) (node_stat_watcher.cc:67-77).
      this.#handle = new HandleWrap(this, this, libnode().exports.tabnode_stat_watcher_new(), true);
    }

    /** StatWatcher::Callback: both stats into the binding's array, then `onchange(status, array)`. */
    onUvStatChange(status: number): void {
      const fields = readStatFields(libnode(), this.#bigint, 2 * kFsStatsFieldsNumber);
      const array = this.#bigint ? arrays.bigintStatValues : arrays.statValues;
      (array as Float64Array).set(fields as Float64Array, 0);
      const fn = this.onchange;
      if (typeof fn !== 'function') return;
      ownedRun(this.#owner, () => this.#resource.runInAsyncScope(fn as (...values: never[]) => unknown, this, ...([status, array] as never[])), true, 'fs', fn);
    }

    /** StatWatcher::Start: `filename` polled every `interval` ms; an error is answered, success is undefined. */
    start(path: unknown, interval: unknown): number | undefined {
      if (!this.#handle.alive) return undefined;
      const lib = libnode();
      const handle = this.#handle.wrap;
      if (lib.exports.tabnode_handle_is_active(handle)) throw new Error('StatWatcher: already started');
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const { request, base } = room.open(lib);
      let err: number;
      try { err = lib.exports.tabnode_stat_watcher_start(handle, base + at, Number(interval) >>> 0); }
      finally { lib.exports.tabnode_fs_free(request); }
      if (err !== 0) return err;
      return undefined;
    }

    // HandleWrap's close, ref, unref and hasRef (src/handle_wrap.cc).
    close(callback?: unknown): void { this.#handle.close(callback); }
    ref(): void { this.#handle.ref(); }
    unref(): void { this.#handle.unref(); }
    hasRef(): boolean { return this.#handle.hasRef(); }
    getAsyncId(): number { return this.#resource.asyncId(); }
  }

  const fsBinding = {
    FSReqCallback,
    FileHandle,
    StatWatcher,
    kUsePromises,
    kFsStatsFieldsNumber,
    statValues: arrays.statValues,
    bigintStatValues: arrays.bigintStatValues,
    statFsValues: arrays.statFsValues,
    bigintStatFsValues: arrays.bigintStatFsValues,

    access(path: unknown, mode: unknown, req?: unknown): unknown {
      const lib = libnode();
      const m = validFileMode(mode, 'access');
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'access', path: pathText(bytes), after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_access(r, b + at, m, a),
      });
    },

    close(fd: unknown, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      return dispatch(lib, new Room(), arguments.length > 1 ? getReqWrap(req) : null, {
        syscall: 'close', after: afterNoArgs, call: (r, _b, a) => lib.exports.tabnode_fs_close(r, descriptor, a),
      });
    },

    /** ExistsSync: uv_fs_access with F_OK, true where it succeeds. */
    existsSync(path: unknown): boolean {
      const lib = libnode();
      const room = new Room();
      const at = room.cstr(pathBytes(path));
      const { request, base } = room.open(lib);
      try { return lib.exports.tabnode_fs_access(request, base + at, 0, 0) === 0; }
      finally { lib.exports.tabnode_fs_free(request); }
    },

    open(path: unknown, flags: number, mode: number, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'open', path: pathText(bytes), after: afterInteger,
        call: (r, b, a) => lib.exports.tabnode_fs_open(r, b + at, flags, mode, a),
        sync: (_r, _b, result) => result,
      });
    },

    openFileHandle(path: unknown, flags: number, mode: number, req?: unknown, ctx?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const wrap = getReqWrap(req);
      if (wrap) {
        return dispatch(lib, room, wrap, {
          syscall: 'open', after: afterOpenFileHandle, call: (r, b, a) => lib.exports.tabnode_fs_open(r, b + at, flags, mode, a),
        });
      }
      return syncCallWithContext(lib, room, ctx, 'open', (r, b) => lib.exports.tabnode_fs_open(r, b + at, flags, mode, 0),
        (_r, _b, result) => result < 0 ? undefined : new FileHandle(result, undefined, undefined, pathText(bytes)));
    },

    read(fd: unknown, buffer: unknown, offset: number, length: number, position: unknown, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      const target = viewOf(buffer).subarray(offset, offset + length);
      const room = new Room();
      const dataAt = room.buffers([target.length]);
      const pos = offsetOf(position);
      return dispatch(lib, room, arguments.length > 5 ? getReqWrap(req) : null, {
        syscall: 'read', after: afterRead([target], dataAt),
        call: (r, _b, a) => lib.exports.tabnode_fs_read(r, descriptor, 1, pos, a),
        sync: (_r, b, result) => { if (result > 0) scatter(lib, b + dataAt, result, [target]); return result; },
      });
    },

    /** ReadFileUtf8: the whole file as a string, read in the program (fs.c), decoded as V8's ToV8Value decodes it. */
    readFileUtf8(path: unknown, flags: number): string {
      const lib = libnode();
      const isFd = typeof path === 'number' && (path | 0) === path;
      const room = new Room();
      const at = isFd ? -1 : room.cstr(pathBytes(path));
      const { request, base } = room.open(lib);
      try {
        const err = lib.exports.tabnode_fs_read_file_utf8(request, isFd ? 0 : base + at, isFd ? path as number : -1, flags);
        if (err !== 0) throw recordedError(lib);
        const length = lib.exports.tabnode_fs_data_length(request) >>> 0;
        const bytes = length === 0 ? new Uint8Array(0) : lib.read(lib.exports.tabnode_fs_data(request) >>> 0, length);
        return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      } finally {
        lib.exports.tabnode_fs_free(request);
      }
    },

    readBuffers(fd: unknown, buffers: unknown[], position: unknown, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      const targets = buffers.map(viewOf);
      const room = new Room();
      const dataAt = room.buffers(targets.map((target) => target.length));
      const pos = offsetOf(position);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'read', after: afterRead(targets, dataAt),
        call: (r, _b, a) => lib.exports.tabnode_fs_read(r, descriptor, targets.length, pos, a),
        sync: (_r, b, result) => { if (result > 0) scatter(lib, b + dataAt, result, targets); return result; },
      });
    },

    fdatasync(fd: unknown, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      return dispatch(lib, new Room(), arguments.length > 1 ? getReqWrap(req) : null, {
        syscall: 'fdatasync', after: afterNoArgs, call: (r, _b, a) => lib.exports.tabnode_fs_fdatasync(r, descriptor, a),
      });
    },

    fsync(fd: unknown, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      return dispatch(lib, new Room(), arguments.length > 1 ? getReqWrap(req) : null, {
        syscall: 'fsync', after: afterNoArgs, call: (r, _b, a) => lib.exports.tabnode_fs_fsync(r, descriptor, a),
      });
    },

    rename(oldPath: unknown, newPath: unknown, req?: unknown): unknown {
      const lib = libnode();
      const from = pathBytes(oldPath), to = pathBytes(newPath);
      const room = new Room();
      const fromAt = room.cstr(from), toAt = room.cstr(to);
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'rename', path: pathText(from), dest: pathText(to), asyncDest: true, after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_rename(r, b + fromAt, b + toAt, a),
      });
    },

    ftruncate(fd: unknown, len: number, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      const length = BigInt(Math.trunc(len));
      return dispatch(lib, new Room(), arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'ftruncate', after: afterNoArgs, call: (r, _b, a) => lib.exports.tabnode_fs_ftruncate(r, descriptor, length, a),
      });
    },

    rmdir(path: unknown, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 1 ? getReqWrap(req) : null, {
        syscall: 'rmdir', path: pathText(bytes), after: afterNoArgs, call: (r, b, a) => lib.exports.tabnode_fs_rmdir(r, b + at, a),
      });
    },

    /** RmSync: std::filesystem's remove or remove_all, with Node's retries and errors (fs_cp.c). */
    rmSync(path: unknown, maxRetries: number, recursive: boolean, retryDelay: number): void {
      const lib = libnode();
      const room = new Room();
      const at = room.cstr(pathBytes(path));
      const { request, base } = room.open(lib);
      try {
        if (lib.exports.tabnode_fs_rm_sync(base + at, maxRetries | 0, recursive === true ? 1 : 0, retryDelay | 0) !== 0) throw recordedError(lib);
      } finally {
        lib.exports.tabnode_fs_free(request);
      }
    },

    mkdir(path: unknown, mode: number, recursive: boolean, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const mkdirp = recursive === true;
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'mkdir', path: pathText(bytes), after: mkdirp ? afterMkdirp : afterNoArgs,
        call: (r, b, a) => mkdirp ? lib.exports.tabnode_fs_mkdirp(r, b + at, mode, a) : lib.exports.tabnode_fs_mkdir(r, b + at, mode, a),
        sync: (r) => {
          if (!mkdirp) return undefined;
          const first = lib.cBytes(lib.exports.tabnode_fs_first_path(r));
          return first === null || first.length === 0 ? undefined : encodeName(first, 'utf8');
        },
      });
    },

    readdir(path: unknown, encoding: unknown, withTypes: unknown, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const enc = parseEncoding(encoding);
      const typed = withTypes === true;
      const wrap = arguments.length > 3 ? getReqWrap(req) : null;
      if (wrap) wrap.withFileTypes = typed;
      return dispatch(lib, room, wrap, {
        syscall: 'scandir', path: pathText(bytes), encoding: enc, after: afterScanDir,
        call: (r, b, a) => lib.exports.tabnode_fs_scandir(r, b + at, a),
        sync: (r) => {
          const list = scanned(lib, r, enc, typed);
          if ('error' in list) throw uvException(lib, list.error, 'scandir', null, pathText(bytes), null);
          return typed ? [list.names, list.types] : list.names;
        },
      });
    },

    /** InternalModuleStat: 0 for a file, 1 for a directory, libuv's error otherwise. */
    internalModuleStat(receiver: unknown, path?: unknown): number {
      const lib = libnode();
      const room = new Room();
      const at = room.cstr(pathBytes(arguments.length > 1 ? path : receiver));
      const { request, base } = room.open(lib);
      try {
        return lib.exports.tabnode_fs_internal_module_stat(request, base + at);
      } finally {
        lib.exports.tabnode_fs_free(request);
      }
    },

    stat(path: unknown, useBigint: unknown, req?: unknown, throwIfNoEntry?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const bigint = useBigint === true;
      const noThrow = throwIfNoEntry === false;
      const wrap = req !== undefined ? getReqWrap(req, bigint) : null;
      return dispatch(lib, room, wrap, {
        syscall: 'stat', path: pathText(bytes), after: noThrow ? afterStatNoThrowIfNoEntry : afterStat,
        call: (r, b, a) => lib.exports.tabnode_fs_stat(r, b + at, a),
        throwIf: noThrow ? (result) => result < 0 && !(result === uvConstant('UV_ENOENT') || result === uvConstant('UV_ENOTDIR')) : undefined,
        sync: (r) => syncStat(lib, r, bigint),
      });
    },

    lstat(path: unknown, useBigint: unknown, req?: unknown, throwIfNoEntry?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const bigint = useBigint === true;
      const wrap = req !== undefined ? getReqWrap(req, bigint) : null;
      return dispatch(lib, room, wrap, {
        syscall: 'lstat', path: pathText(bytes), after: afterStat,
        call: (r, b, a) => lib.exports.tabnode_fs_lstat(r, b + at, a),
        throwIf: throwIfNoEntry === false ? (result) => result < 0 && result !== uvConstant('UV_ENOENT') : undefined,
        sync: (r) => syncStat(lib, r, bigint),
      });
    },

    fstat(fd: unknown, useBigint: unknown, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      const bigint = useBigint === true;
      const wrap = req !== undefined ? getReqWrap(req, bigint) : null;
      return dispatch(lib, new Room(), wrap, {
        syscall: 'fstat', after: afterStat, call: (r, _b, a) => lib.exports.tabnode_fs_fstat(r, descriptor, a),
        sync: (r) => syncStat(lib, r, bigint),
      });
    },

    statfs(path: unknown, useBigint: unknown, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const bigint = useBigint === true;
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req, bigint) : null, {
        syscall: 'statfs', path: pathText(bytes), after: afterStatFs,
        call: (r, b, a) => lib.exports.tabnode_fs_statfs(r, b + at, a),
        sync: (r) => {
          lib.exports.tabnode_fs_fill_request_statfs(r);
          const global = bigint ? arrays.bigintStatFsValues : arrays.statFsValues;
          (global as Float64Array).set(readStatFields(lib, bigint, 8, true) as Float64Array, 0);
          return global;
        },
      });
    },

    link(src: unknown, dest: unknown, req?: unknown): unknown {
      const lib = libnode();
      const from = pathBytes(src), to = pathBytes(dest);
      const room = new Room();
      const fromAt = room.cstr(from), toAt = room.cstr(to);
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'link', path: pathText(from), dest: pathText(to), asyncDest: true, after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_link(r, b + fromAt, b + toAt, a),
      });
    },

    symlink(target: unknown, path: unknown, flags: number, req?: unknown): unknown {
      const lib = libnode();
      const to = pathBytes(target), at = pathBytes(path);
      const room = new Room();
      const targetAt = room.cstr(to), pathAt = room.cstr(at);
      // AsyncDestCall's data is the link's own path; FSReqWrapSync names the target, then the path.
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'symlink', path: pathText(to), dest: pathText(at), asyncDest: true, after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_symlink(r, b + targetAt, b + pathAt, flags, a),
      });
    },

    readlink(path: unknown, encoding: unknown, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const enc = parseEncoding(encoding);
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'readlink', path: pathText(bytes), encoding: enc, after: afterStringPtr(context),
        call: (r, b, a) => lib.exports.tabnode_fs_readlink(r, b + at, a),
        sync: (r) => encodeName(lib.cBytes(lib.exports.tabnode_fs_ptr(r)) ?? new Uint8Array(0), enc),
      });
    },

    unlink(path: unknown, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 1 ? getReqWrap(req) : null, {
        syscall: 'unlink', path: pathText(bytes), after: afterNoArgs, call: (r, b, a) => lib.exports.tabnode_fs_unlink(r, b + at, a),
      });
    },

    writeBuffer(fd: unknown, buffer: unknown, offset: number, length: number, position: unknown, req?: unknown, ctx?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      const bytes = viewOf(buffer).subarray(offset, offset + length);
      const room = new Room();
      room.buffers([bytes.length], [bytes]);
      const pos = offsetOf(position);
      const wrap = getReqWrap(req);
      if (wrap) {
        return dispatch(lib, room, wrap, {
          syscall: 'write', after: afterInteger, call: (r, _b, a) => lib.exports.tabnode_fs_write(r, descriptor, 1, pos, a),
        });
      }
      return syncCallWithContext(lib, room, ctx, 'write', (r) => lib.exports.tabnode_fs_write(r, descriptor, 1, pos, 0),
        (_r, _b, result) => result);
    },

    writeBuffers(fd: unknown, chunks: unknown[], position: unknown, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      const parts = chunks.map(viewOf);
      const room = new Room();
      room.buffers(parts.map((part) => part.length), parts);
      const pos = offsetOf(position);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'write', after: afterInteger, call: (r, _b, a) => lib.exports.tabnode_fs_write(r, descriptor, parts.length, pos, a),
        sync: (_r, _b, result) => result,
      });
    },

    /** WriteString: the string's bytes in its encoding (StringBytes::Write), then uv_fs_write. */
    writeString(fd: unknown, value: unknown, position: unknown, encoding: unknown, req?: unknown, ctx?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      const pos = offsetOf(position);
      const enc = parseEncoding(encoding);
      const text = typeof value === 'string' ? value : String(value);
      const bytes = enc === 'buffer' || enc === 'utf8' ? new TextEncoder().encode(text) : viewOf(context.Bytes().from(text, enc));
      const room = new Room();
      room.buffers([bytes.length], [bytes]);
      const wrap = getReqWrap(req);
      if (wrap) {
        return dispatch(lib, room, wrap, {
          syscall: 'write', after: afterInteger, call: (r, _b, a) => lib.exports.tabnode_fs_write(r, descriptor, 1, pos, a),
        });
      }
      return syncCallWithContext(lib, room, ctx, 'write', (r) => lib.exports.tabnode_fs_write(r, descriptor, 1, pos, 0),
        (_r, _b, result) => result);
    },

    /** WriteFileUtf8: open, write until done, close, in the program (fs.c). */
    writeFileUtf8(path: unknown, data: unknown, flags: number, mode: number): void {
      const lib = libnode();
      const isFd = typeof path === 'number' && (path | 0) === path;
      const bytes = pathBytes(data);
      const room = new Room();
      const at = isFd ? -1 : room.cstr(pathBytes(path));
      const dataAt = room.add(bytes);
      const { request, base } = room.open(lib);
      try {
        const err = lib.exports.tabnode_fs_write_file_utf8(request, isFd ? 0 : base + at, isFd ? path as number : -1,
          flags, mode, base + dataAt, bytes.length);
        if (err !== 0) throw recordedError(lib);
      } finally {
        lib.exports.tabnode_fs_free(request);
      }
    },

    realpath(path: unknown, encoding: unknown, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      const enc = parseEncoding(encoding);
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'realpath', path: pathText(bytes), encoding: enc, after: afterStringPtr(context),
        call: (r, b, a) => lib.exports.tabnode_fs_realpath(r, b + at, a),
        sync: (r) => encodeName(lib.cBytes(lib.exports.tabnode_fs_ptr(r)) ?? new Uint8Array(0), enc),
      });
    },

    copyFile(src: unknown, dest: unknown, flags: unknown, req?: unknown): unknown {
      const lib = libnode();
      const mode = validFileMode(flags, 'copyfile');
      const from = pathBytes(src), to = pathBytes(dest);
      const room = new Room();
      const fromAt = room.cstr(from), toAt = room.cstr(to);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'copyfile', path: pathText(from), dest: pathText(to), asyncDest: true, after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_copyfile(r, b + fromAt, b + toAt, mode, a),
      });
    },

    chmod(path: unknown, mode: number, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'chmod', path: pathText(bytes), after: afterNoArgs, call: (r, b, a) => lib.exports.tabnode_fs_chmod(r, b + at, mode, a),
      });
    },

    fchmod(fd: unknown, mode: number, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      return dispatch(lib, new Room(), arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'fchmod', after: afterNoArgs, call: (r, _b, a) => lib.exports.tabnode_fs_fchmod(r, descriptor, mode, a),
      });
    },

    chown(path: unknown, uid: number, gid: number, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'chown', path: pathText(bytes), after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_chown(r, b + at, uid >>> 0, gid >>> 0, a),
      });
    },

    fchown(fd: unknown, uid: number, gid: number, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      return dispatch(lib, new Room(), arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'fchown', after: afterNoArgs, call: (r, _b, a) => lib.exports.tabnode_fs_fchown(r, descriptor, uid >>> 0, gid >>> 0, a),
      });
    },

    lchown(path: unknown, uid: number, gid: number, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'lchown', path: pathText(bytes), after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_lchown(r, b + at, uid >>> 0, gid >>> 0, a),
      });
    },

    utimes(path: unknown, atime: number, mtime: number, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'utime', path: pathText(bytes), after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_utime(r, b + at, atime, mtime, a),
      });
    },

    futimes(fd: unknown, atime: number, mtime: number, req?: unknown): unknown {
      const lib = libnode();
      const descriptor = validatedFd(context, fd);
      return dispatch(lib, new Room(), arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'futime', after: afterNoArgs, call: (r, _b, a) => lib.exports.tabnode_fs_futime(r, descriptor, atime, mtime, a),
      });
    },

    lutimes(path: unknown, atime: number, mtime: number, req?: unknown): unknown {
      const lib = libnode();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(lib, room, arguments.length > 3 ? getReqWrap(req) : null, {
        syscall: 'lutime', path: pathText(bytes), after: afterNoArgs,
        call: (r, b, a) => lib.exports.tabnode_fs_lutime(r, b + at, atime, mtime, a),
      });
    },

    /** Mkdtemp: the prefix and "XXXXXX", made by uv_fs_mkdtemp, answered from req->path. */
    mkdtemp(prefix: unknown, encoding: unknown, req?: unknown): unknown {
      const lib = libnode();
      const prefixBytes = pathBytes(prefix);
      const template = new Uint8Array(prefixBytes.length + 6);
      template.set(prefixBytes, 0);
      template.set(new TextEncoder().encode('XXXXXX'), prefixBytes.length);
      const room = new Room();
      const at = room.cstr(template);
      const enc = parseEncoding(encoding);
      return dispatch(lib, room, arguments.length > 2 ? getReqWrap(req) : null, {
        syscall: 'mkdtemp', path: pathText(template), encoding: enc, after: afterStringPath(context),
        call: (r, b, a) => lib.exports.tabnode_fs_mkdtemp(r, b + at, a),
        sync: (r) => encodeName(lib.cBytes(lib.exports.tabnode_fs_path(r)) ?? new Uint8Array(0), enc),
      });
    },

    cpSyncCheckPaths(src: unknown, dest: unknown, dereference: unknown, recursive: unknown): void {
      const lib = libnode();
      cpCall(lib, [src, dest], (b, [s, d]) => lib.exports.tabnode_fs_cp_check_paths(b + s!, b + d!, dereference === true ? 1 : 0, recursive === true ? 1 : 0));
    },

    cpSyncOverrideFile(src: unknown, dest: unknown, mode: unknown, preserveTimestamps: unknown): void {
      const lib = libnode();
      const m = validFileMode(mode, 'copyfile');
      cpCall(lib, [src, dest], (b, [s, d]) => lib.exports.tabnode_fs_cp_override_file(b + s!, b + d!, m, preserveTimestamps === true ? 1 : 0));
    },

    cpSyncCopyDir(src: unknown, dest: unknown, force: unknown, dereference: unknown, errorOnExist: unknown,
      verbatimSymlinks: unknown, preserveTimestamps: unknown): void {
      const lib = libnode();
      const flag = (value: unknown): number => value === true ? 1 : 0;
      cpCall(lib, [src, dest], (b, [s, d]) => lib.exports.tabnode_fs_cp_copy_dir(b + s!, b + d!, flag(force), flag(dereference),
        flag(errorOnExist), flag(verbatimSymlinks), flag(preserveTimestamps)));
    },

    /**
     * GetFormatOfExtensionlessFile (src/node_file.cc): EXTENSIONLESS_FORMAT_WASM where the file's first four bytes are
     * WebAssembly's magic, else EXTENSIONLESS_FORMAT_JAVASCRIPT, which a file that cannot be opened or read is too.
     */
    getFormatOfExtensionlessFile(path: unknown): number {
      let fd: number;
      try { fd = fsBinding.open(path, 0, 0) as number; } catch { return 0; }
      try {
        const head = new Uint8Array(4);
        let read: number;
        try { read = fsBinding.read(fd, head, 0, 4, 0) as number; } catch { return 0; }
        return read === 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d ? 1 : 0;
      } finally { fsBinding.close(fd); }
    },

    /**
     * BindingData::LegacyMainResolve (src/node_file.cc): the index into legacyMainResolve's extensions of the first
     * file found, the package's `main` with each of the seven before its `./index` with the three after; where none is
     * a file, ERR_MODULE_NOT_FOUND for the package imported from `base`'s path.
     */
    legacyMainResolve(packagePath: unknown, main?: unknown, base?: unknown): number {
      const extensions = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node', '.js', '.json', '.node'];
      const path = context.require('path') as { resolve(...parts: string[]): string };
      const isFile = (file: string): boolean => fsBinding.internalModuleStat(file) === 0;
      let initial = '';
      if (typeof main === 'string') {
        const start = path.resolve(String(packagePath), main);
        initial = start;
        for (let index = 0; index < 7; index++) if (isFile(start + extensions[index])) return index;
      }
      const index = path.resolve(String(packagePath), './index');
      for (let at = 7; at < 10; at++) if (isFile(index + extensions[at])) return at;
      if (initial === '') initial = `${index}.js`;
      const codes = (context.require('internal/errors') as { codes: Record<string, new (message: string) => Error> }).codes;
      if (typeof base !== 'string') {
        throw new codes.ERR_INVALID_ARG_TYPE!('The "base" argument must be of type string or an instance of URL.');
      }
      let from: string;
      try { from = (context.require('internal/url') as { fileURLToPath(url: string): string }).fileURLToPath(base); } catch { throw new codes.ERR_INVALID_URL!('Invalid URL'); }
      throw new codes.ERR_MODULE_NOT_FOUND!(`Cannot find package '${initial}' imported from ${from}`);
    },
  };

  /** A stat a synchronous call made, into the binding's global array (FillGlobalStatsArray). */
  function syncStat(lib: Libnode, request: number, bigint: boolean): Float64Array | BigInt64Array {
    lib.exports.tabnode_fs_fill_request_stats(request);
    const global = bigint ? arrays.bigintStatValues : arrays.statValues;
    (global as Float64Array).set(readStatFields(lib, bigint, kFsStatsFieldsNumber) as Float64Array, 0);
    return global;
  }

  /** A composite synchronous call of fs_cp.c over two paths, its error the one the C decided. */
  function cpCall(lib: Libnode, paths: unknown[], call: (base: number, at: number[]) => number): void {
    const room = new Room();
    const at = paths.map((path) => room.cstr(pathBytes(path)));
    const { request, base } = room.open(lib);
    try { if (call(base, at) !== 0) throw recordedError(lib); }
    finally { lib.exports.tabnode_fs_free(request); }
  }

  return { fsBinding, FileHandle, StatWatcher, arrays };
}
