/**
 * `internalBinding('fs')`: the filesystem calls Node's own `fs.js` makes,
 * over the engine's virtual filesystem.
 *
 * Node's `fs` is a thin, careful layer over libuv's syscalls: it validates,
 * it decides encodings, it owns `Stats`, `Dirent`, the streams and the
 * promises, and then it calls one of about forty operations. The engine's
 * `fs` was a hand-written 1,764-line imitation of that whole layer over the
 * same virtual filesystem, and Node's own `test-fs-*` passed 52 of 246.
 *
 * So this file is the forty operations and nothing above them. Everything
 * about paths, flags, encodings, `Stats` objects, `Dirent`, recursion,
 * `mkdtemp`'s template, `rm -rf`'s retries and every error message is Node's
 * own code now.
 *
 * WHAT A DESCRIPTOR IS HERE: the virtual filesystem is addressed by path, so
 * an open file is a path, a set of flags and a position, kept in this file's
 * own table. Reads and writes are whole-file reads and writes underneath,
 * which is what the filesystem offers; a program that seeks and writes gets
 * the bytes it asked for, at the cost of the copy.
 *
 * WHICH FILESYSTEM: a run's own. The engine holds one per run and swaps the
 * guest's `process` when it enters one, so the filesystem is read off that
 * process at call time -- the same way a vendored file gets the right
 * `process` at all. An asynchronous call captures the tree here and carries
 * it into the tick, because that tick can run after another guest has put
 * its own process on the realm. One `fs` module, many runs, each seeing its
 * own tree.
 */
import { createNodeError as vfsError } from '../../virtual-fs';
import { registerHandle, releaseHandle, refHandle, unrefHandle, handleHasRef, currentOwner } from './handles';
import { enterRun } from '../../process-tokens';

/**
 * An errno error, as the filesystem makes one. The tree's own maker knows the
 * codes it raises; a descriptor code is this file's to raise, so it is made
 * the same shape here rather than widened there.
 */
function createNodeError(code: string, syscall: string, path: string): Error {
  const known = ['EEXIST', 'EINVAL', 'EISDIR', 'ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'ELOOP'];
  if (known.includes(code)) return vfsError(code as 'ENOENT', syscall, path);
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path, errno: -9 });
}

/**
 * The tab's filesystem holds no links. `link` and `symlink` refuse with
 * EPERM rather than copying, which pretended a second name existed.
 */
function refuseLinks(syscall: string, path: string): never {
  throw Object.assign(
    new Error(`EPERM: the tab's filesystem holds no links, ${syscall} '${path}'`),
    { code: 'EPERM', errno: -1, syscall, path },
  );
}

function unsupportedMetadata(syscall: string): never {
  throw Object.assign(new Error(`ENOTSUP: filesystem does not support ${syscall}`), { code: 'ENOTSUP', syscall });
}


function treeHoldsLinks(): boolean {
  return (vfs() as VirtualFS & { holdsLinks?: boolean }).holdsLinks === true;
}
import type { VirtualFS, Stats as VfsStats } from '../../virtual-fs';
import { constantsBinding } from './misc';
import { Buffer as NodeBuffer } from '../buffer-module';

/** The key the engine hangs a run's filesystem off its guest process. */
export const kRunFilesystem = Symbol.for('tabnode.run.vfs');

/**
 * A tree named for the length of one call, which is how the engine's own
 * parts use `fs` outside a run: the substrate builds with rolldown over a
 * project's tree, and the engine hands WASI a tree of its own. Node's `fs` is
 * one module and reads the run's tree off the run's process; this is the
 * door for a caller that has a tree but is not a run.
 */
// eslint-disable-next-line no-var, vars-on-top
var overrideTree: VirtualFS | null = null;
export function withFilesystem<T>(tree: VirtualFS, work: () => T): T {
  const previous = overrideTree;
  overrideTree = tree;
  try { return work(); } finally { overrideTree = previous; }
}

/** The cwd named for the length of one call, captured with the tree. */
// eslint-disable-next-line no-var, vars-on-top
var overrideCwd: string | null = null;
function withCwd<T>(cwd: string, work: () => T): T {
  const previous = overrideCwd;
  overrideCwd = cwd;
  try { return work(); } finally { overrideCwd = previous; }
}

/** The filesystem of the run whose code is executing. */
function vfs(): VirtualFS {
  if (overrideTree !== null) return overrideTree;
  const realm = globalThis as unknown as { process?: Record<symbol, unknown> };
  const found = realm.process?.[kRunFilesystem] as VirtualFS | undefined;
  if (!found) {
    throw Object.assign(new Error('fs: this realm has no filesystem; the engine gives a run one when it starts'), { code: 'ENOSYS' });
  }
  return found;
}

/** The cwd of the run whose code is executing. */
function callingCwd(): string {
  if (overrideCwd !== null) return overrideCwd;
  const realm = globalThis as unknown as { process?: { cwd?: () => string } };
  if (typeof realm.process?.cwd !== 'function') {
    throw Object.assign(new Error('fs: this realm has no process cwd; the engine gives a run one when it starts'), { code: 'ENOSYS' });
  }
  return realm.process.cwd();
}

/**
 * The open flags, read from the same constants table `fs.js` turned a string
 * like `'w'` into. Written down here they were Linux's numbers while the
 * engine's table carries another platform's, so `openSync(path, 'w')` tested
 * the wrong bit and answered ENOENT for a file it was being asked to create.
 * One table, one answer.
 */
function flagBits(): { create: number; excl: number; truncate: number; append: number } {
  const fs = (constantsBinding as unknown as { fs?: Record<string, number> }).fs ?? {};
  return {
    create: fs.O_CREAT ?? 0o100,
    excl: fs.O_EXCL ?? 0o200,
    truncate: fs.O_TRUNC ?? 0o1000,
    append: fs.O_APPEND ?? 0o2000,
  };
}

/** The file-type bits a `mode` carries, which is how `Stats` answers `isFile()`. */
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface OpenFile {
  path: string;
  flags: number;
  position: number;
  /** A directory opened for reading, which `opendir` does. */
  directory: boolean;
  /** The tree this descriptor was opened on, so a later fstat/read/write
   *  does not re-resolve `process` after another run has taken the realm. */
  tree: VirtualFS;
  /**
   * Bytes this descriptor holds after its first read. A kernel page cache
   * does the same: `open` for reading, then every later `read` on that fd
   * is answered from memory. Node's `fs.readFile` issues 512 KiB
   * (`kReadFileBufferLength`) async `read`s; without this, each one was a
   * whole-file trip to the store, and openvscode-server's extension host
   * stalled on a cold boot of its ~20 MB `extensionHostProcess.js` before
   * it could send ready.
   */
  cached?: Uint8Array;
}

/** Every descriptor this engine has open, and the next number to hand out. */
const openFiles = new Map<number, OpenFile>();
let nextFd = 20;

function fileFor(fd: number): OpenFile {
  const file = openFiles.get(fd);
  if (!file) throw createNodeError('EBADF', 'read', String(fd));
  return file;
}

/** Node's stat array: eighteen numbers, with each time a second and a nanosecond. */
function statArray(stats: VfsStats, bigint: boolean, path?: string): Float64Array | BigInt64Array {
  const mtime = stats.mtime instanceof Date ? stats.mtime.getTime() : Number(stats.mtimeMs ?? 0);
  const atime = stats.atime instanceof Date ? stats.atime.getTime() : Number(stats.atimeMs ?? mtime);
  const ctime = stats.ctime instanceof Date ? stats.ctime.getTime() : Number(stats.ctimeMs ?? mtime);
  const birth = stats.birthtime instanceof Date ? stats.birthtime.getTime() : Number(stats.birthtimeMs ?? mtime);
  const seconds = (ms: number): number => Math.floor(ms / 1000);
  const nanos = (ms: number): number => Math.floor((ms % 1000) * 1e6);
  // The tree keeps permissions but not the type bits; `Stats.isFile()` is
  // `mode & S_IFMT`, so the type the tree does know is put where Node looks.
  // `chmod` stores what it set; a path it has not touched keeps the tree's.
  const permissions = Number(stats.mode ?? (stats.isDirectory?.() ? 0o755 : 0o644)) & 0o7777;
  const type = stats.isDirectory?.() ? S_IFDIR : stats.isSymbolicLink?.() ? S_IFLNK : S_IFREG;
  const values = [
    Number(stats.dev ?? 0), type | permissions, Number(stats.nlink ?? 1),
    Number(stats.uid ?? 0), Number(stats.gid ?? 0), Number(stats.rdev ?? 0),
    Number(stats.blksize ?? 4096), Number(stats.ino ?? 0), Number(stats.size ?? 0),
    Number(stats.blocks ?? Math.ceil(Number(stats.size ?? 0) / 512)),
    seconds(atime), nanos(atime),
    seconds(mtime), nanos(mtime),
    seconds(ctime), nanos(ctime),
    seconds(birth), nanos(birth),
  ];
  return bigint ? BigInt64Array.from(values, (value) => BigInt(Math.floor(value))) : Float64Array.from(values);
}

/** A request object `fs.js` hands an asynchronous call, answered on a tick. */
interface FSReq { oncomplete?: (error: Error | null, ...rest: unknown[]) => void }

/** The next tick of whatever realm this is: a guest's process, else the microtask queue. */
function onNextTick(fn: () => void): void {
  const tick = (globalThis as unknown as { process?: { nextTick?: (fn: () => void) => void } }).process?.nextTick;
  if (typeof tick === 'function') tick(fn); else queueMicrotask(fn);
}

/**
 * Every operation below is written once, synchronously, and this is what
 * makes one asynchronous: Node passes a request object as the last argument
 * when it wants a callback, and the answer arrives on the next tick rather
 * than in the caller's own stack -- which is the whole of the difference a
 * program can observe between `fs.readFile` and `fs.readFileSync` here.
 *
 * The tree and the cwd are captured on this stack, not on that tick. The
 * realm's process is swapped per run, so a `vfs()` or `process.cwd()` inside
 * the work would read whichever guest is executing then -- another run's
 * view, or none -- and a file `ls` listed (synchronous readdir) was ENOENT
 * through `open` and `readFile`, and a relative `made.txt` landed at the
 * root.
 *
 * Node's third flavour is the one `fs.promises` uses: the last argument is
 * `kUsePromises` and the call answers a promise. `internal/fs/promises.js`
 * passes it to every binding call it makes and hands what comes back to
 * `PromisePrototypeThen`, so a value returned there reads as `TypeError:
 * Method Promise.prototype.then called on incompatible receiver [object
 * Float64Array]` -- which is what `fs.promises.readFile` answered for every
 * program, openvscode-server reading its own `nls.messages.json` among them,
 * and it died of it after binding its port. The declared return type is the
 * value flavour's; with `kUsePromises` it is a promise of that value, as
 * Node's own binding is untyped C++ with the same three shapes.
 */
function answer<T>(req: FSReq | undefined, work: () => T): T | undefined {
  const usePromises = (req as unknown) === kUsePromises;
  const useCallback = req !== undefined && typeof req === 'object' && typeof req.oncomplete === 'function';
  if (!usePromises && !useCallback) return work();
  const tree = vfs();
  const cwd = callingCwd();
  const run = (): T => withFilesystem(tree, () => withCwd(cwd, work));
  if (usePromises) {
    return new Promise<T>((resolve, reject) => {
      onNextTick(() => { try { resolve(run()); } catch (error) { reject(error); } });
    }) as unknown as T;
  }
  // Node's binding invokes `req.oncomplete` as a method of the request:
  // `readFileAfterOpen` reads `this.context`, the `ReadFileContext`.
  // Capturing the function and calling it detached left `this` undefined
  // and a guest `fs.readFile(path, cb)` threw `TypeError: Cannot read
  // properties of undefined (reading 'context')` at `node:fs:297:24`.
  const request = req as FSReq;
  const complete = request.oncomplete!;
  onNextTick(() => {
    let value: T;
    try { value = run(); } catch (error) { complete.call(request, error as Error); return; }
    complete.call(request, null, value as unknown);
  });
  return undefined;
}

/**
 * A name the binding answers, in the encoding Node handed. `fs.rm` recursive
 * (rimraf) readdir's with encoding `buffer` and `Buffer.concat`s each child
 * onto the path; a string child threw `list[1]`/`list[2]` must be a Buffer,
 * received `'exthost1'`.
 */
function encodeFsName(name: string, encoding: unknown): string | Uint8Array {
  if (encoding !== 'buffer' && encoding !== 6) {
    if (typeof encoding === 'string' && encoding.length > 0 && encoding !== 'utf8' && encoding !== 'utf-8') {
      return (NodeBuffer.from(name) as { toString(enc: string): string }).toString(encoding);
    }
    return name;
  }
  return NodeBuffer.from(name);
}

/** The path as Node handed it, with a Buffer decoded. A symlink's target is this, not resolved. */
function asWritten(path: unknown): string {
  if (typeof path === 'string') return path;
  if (path instanceof Uint8Array) return new TextDecoder().decode(path);
  return String(path);
}

/**
 * A path as this filesystem takes one. Node's `fs.js` hands the binding the
 * path as written; libuv resolves a relative name against the process's cwd.
 * The tree used to prefix `/` and land `made.txt` at `/made.txt` while
 * `process.cwd()` was `/workspace`. The cwd is the calling run's, captured
 * at the call's entry together with the tree.
 */
function asPath(path: unknown): string {
  const name = asWritten(path);
  if (name.startsWith('/')) return name;
  const cwd = callingCwd();
  const combined = cwd.endsWith('/') ? `${cwd}${name}` : `${cwd}/${name}`;
  const parts: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/**
 * The request object `fs.js` makes for every asynchronous call and hangs its
 * callback off. Node's is a C++ handle the event loop owns; here it carries
 * the callback and nothing else, because `answer` above is the whole of what
 * makes a call asynchronous in a realm with one thread.
 */
export class FSReqCallback {
  oncomplete: ((error: Error | null, ...rest: unknown[]) => void) | undefined;
  context: unknown;
  constructor(public bigint = false) {}
}

/** The symbol `fs.promises` passes where a callback would go. */
export const kUsePromises = Symbol('kUsePromises');

/**
 * `internalBinding('fs_dir')`'s handle: an open directory, read a batch at a
 * time. Node's own `Dir` and `Dirent` are built on it; what a handle owes is
 * a flat list of name and type, and `null` when there is nothing left.
 */
export class DirHandle {
  #entries: Array<[string, number]>;
  #at = 0;
  #encoding: unknown;
  constructor(path: string, encoding?: unknown) {
    const tree = vfs();
    const base = path.endsWith('/') ? path.slice(0, -1) : path;
    this.#encoding = encoding;
    // `readdirSync` throws for a path that is not a directory, which is the
    // answer `opendir` owes too.
    this.#entries = tree.readdirSync(path).map((name) => {
      try {
        const stats = tree.lstatSync(`${base}/${name}`);
        return [name, stats.isDirectory() ? 2 : stats.isSymbolicLink() ? 10 : 1] as [string, number];
      } catch { return [name, 0] as [string, number]; }
    });
  }
  read(encoding?: string, bufferSize = 32, req?: FSReq): unknown {
    return answer(req, () => {
      if (this.#at >= this.#entries.length) return null;
      const batch: unknown[] = [];
      const enc = encoding ?? this.#encoding;
      for (let taken = 0; taken < bufferSize && this.#at < this.#entries.length; taken += 1) {
        const [name, type] = this.#entries[this.#at++]!;
        batch.push(encodeFsName(name, enc), type);
      }
      return batch;
    });
  }
  close(req?: FSReq): undefined {
    return answer(req, () => { this.#at = this.#entries.length; return undefined; });
  }
}

export const fsDirBinding = {
  opendirSync(path: unknown, encoding?: unknown): DirHandle { return new DirHandle(asPath(path), encoding); },
  opendir(path: unknown, encoding: string, req?: FSReq): DirHandle | undefined {
    return answer(req, () => new DirHandle(asPath(path), encoding));
  },
};

/**
 * `internalBinding('fs_event_wrap')`'s `FSEvent`: what `fs.watch` is. The
 * engine's tree reports its own changes, and this is the shape Node's
 * `FSWatcher` expects around them -- a start that takes a path and answers
 * an errno, a close, and `onchange(status, event, filename)`.
 */
export class FSEvent {
  onchange: ((status: number, event: string, filename: string) => void) | null = null;
  #watcher: { close(): void } | null = null;
  initialized = false;

  start(path: unknown, persistent?: boolean, recursive?: boolean, _encoding?: string): number {
    const name = asPath(path);
    const tree = vfs();
    const cwd = callingCwd();
    const owner = currentOwner();
    try {
      this.#watcher = tree.watch(name, { recursive: Boolean(recursive) }, ((event: string, filename: string | null) => {
        // libuv names a change `change` and a create or a remove `rename`,
        // which is what Node's `FSWatcher` turns into its own two events.
        const notify = () => withFilesystem(tree, () => withCwd(cwd, () =>
          this.onchange?.(0, event === 'rename' ? 'rename' : 'change', filename ?? '')));
        if (owner === null) notify();
        else enterRun(owner, notify);
      }) as never) as unknown as { close(): void };
      this.initialized = true;
      registerHandle(this);
      if (persistent === false) unrefHandle(this);
      return 0;
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === 'ENOENT' ? -2 : -22;
    }
  }

  close(): void {
    releaseHandle(this);
    this.initialized = false;
    try { this.#watcher?.close(); } catch { /* a watcher already closed is closed */ }
    this.#watcher = null;
  }

  ref(): void { if (this.initialized) refHandle(this); }
  unref(): void { unrefHandle(this); }
  getAsyncId(): number { return 0; }
  hasRef(): boolean { return this.initialized && handleHasRef(this); }
}

/**
 * `StatWatcher`: what `fs.watchFile` is. It polls, as libuv's does, and the
 * interval is the one the program asked for.
 */
export class StatWatcher {
  onchange: ((current: Float64Array | BigInt64Array, previous: Float64Array | BigInt64Array) => void) | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #previous: Float64Array | BigInt64Array | null = null;
  constructor(public bigint = false) {}

  start(path: unknown, interval = 5007): number {
    const name = asPath(path);
    const tree = vfs();
    const read = (): Float64Array | BigInt64Array => {
      try { return statArray(tree.statSync(name), this.bigint); }
      catch { return this.bigint ? new BigInt64Array(18) : new Float64Array(18); }
    };
    this.#previous = read();
    this.#timer = setInterval(() => {
      const current = read();
      const previous = this.#previous!;
      let changed = false;
      for (let index = 0; index < current.length; index += 1) {
        if (current[index] !== previous[index]) { changed = true; break; }
      }
      if (changed) { this.#previous = current; this.onchange?.(current, previous); }
    }, interval);
    (this.#timer as unknown as { unref?: () => void }).unref?.();
    return 0;
  }

  stop(): void { if (this.#timer !== null) { clearInterval(this.#timer); this.#timer = null; } }
  close(): void { this.stop(); }
  ref(): void {}
  unref(): void {}
  getAsyncId(): number { return 0; }
  hasRef(): boolean { return this.#timer !== null; }
}

export const fsEventWrapBinding = { FSEvent };

/**
 * What `fs.promises.open` is handed: a descriptor with a close of its own.
 * Node's is a C++ handle whose destructor closes the file; here it is the
 * same number this file's table keeps, with the same close.
 */
export class FileHandle {
  constructor(public fd: number) {}
  close(): Promise<void> { openFiles.delete(this.fd); return Promise.resolve(); }
  release(): void { openFiles.delete(this.fd); }
  getAsyncId(): number { return this.fd; }
}

export const fsBinding = {
  FSReqCallback,
  kUsePromises,
  StatWatcher,

  /** `fs.promises.open`: the same open, answered as a promise with a handle. */
  openFileHandle(path: unknown, flags: number, mode: number, usePromises?: unknown): Promise<FileHandle> | FileHandle {
    const fd = fsBinding.open(path, flags, mode) as number;
    const handle = new FileHandle(fd);
    return usePromises === kUsePromises ? Promise.resolve(handle) : handle;
  },
  // ---- opening and closing ------------------------------------------------
  open(path: unknown, flags: number, _mode: number, req?: FSReq): number | undefined {
    return answer(req, () => {
      const name = asPath(path);
      const tree = vfs();
      const bits = flagBits();
      const exists = tree.existsSync(name);
      if (exists && ((flags & 3) !== 0 || (flags & (bits.create | bits.truncate | bits.append)) !== 0)) {
        tree.accessSync(name, 2);
      }
      if ((flags & bits.excl) !== 0 && (flags & bits.create) !== 0 && exists) throw createNodeError('EEXIST', 'open', name);
      if (!exists) {
        if ((flags & bits.create) === 0) throw createNodeError('ENOENT', 'open', name);
        // VirtualFS writes create parents for image loading; open(2) does not.
        const parent = name.slice(0, name.lastIndexOf('/')) || '/';
        if (!tree.statSync(parent).isDirectory()) throw createNodeError('ENOTDIR', 'open', name);
        tree.writeFileSync(name, '');
      } else if ((flags & bits.truncate) !== 0) {
        tree.writeFileSync(name, '');
      }
      const fd = nextFd++;
      const position = (flags & bits.append) !== 0 && exists ? (tree.readFileSync(name) as Uint8Array).length : 0;
      openFiles.set(fd, { path: name, flags, position, directory: false, tree });
      return fd;
    });
  },

  close(fd: number, req?: FSReq): undefined {
    return answer(req, () => { fileFor(fd); openFiles.delete(fd); return undefined; });
  },

  // ---- reading ------------------------------------------------------------
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number, req?: FSReq): number | undefined {
    return answer(req, () => {
      const file = fileFor(fd);
      if ((file.flags & 3) === 1) throw createNodeError('EBADF', 'read', file.path);
      if (file.cached === undefined) file.cached = file.tree.readFileSync(file.path) as Uint8Array;
      const bytes = file.cached;
      const from = position === null || position === undefined || position < 0 ? file.position : position;
      const end = Math.min(from + length, bytes.length);
      const read = end > from ? end - from : 0;
      if (read > 0) buffer.set(bytes.subarray(from, end), offset);
      if (position === null || position === undefined || position < 0) file.position = from + read;
      return read;
    });
  },

  readBuffers(fd: number, buffers: Uint8Array[], position: number, req?: FSReq): number | undefined {
    return answer(req, () => {
      let total = 0;
      for (const buffer of buffers) {
        const read = fsBinding.read(fd, buffer, 0, buffer.length, position === undefined ? -1 : position + total) as number;
        total += read;
        if (read < buffer.length) break;
      }
      return total;
    });
  },

  /** Node's fast path for `readFile` with an encoding it can decode itself. */
  readFileUtf8(path: unknown, flags: number): string {
    const owned = typeof path !== 'number';
    const fd = owned ? fsBinding.open(path, flags, 0o666) as number : path as number;
    try {
      const file = fileFor(fd);
      const bytes = new Uint8Array(file.tree.statSync(file.path).size);
      const length = fsBinding.read(fd, bytes, 0, bytes.length, -1) as number;
      return new TextDecoder().decode(bytes.subarray(0, length));
    } finally { if (owned) fsBinding.close(fd); }
  },

  // ---- writing ------------------------------------------------------------
  writeBuffer(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, req?: FSReq): number | undefined {
    return answer(req, () => {
      const file = fileFor(fd);
      if ((file.flags & 3) === 0) throw createNodeError('EBADF', 'write', file.path);
      const tree = file.tree;
      const slice = buffer.subarray(offset, offset + length);
      const existing = file.cached ?? (tree.existsSync(file.path) ? tree.readFileSync(file.path) as Uint8Array : new Uint8Array(0));
      const at = (file.flags & flagBits().append) !== 0 ? existing.length
        : position === null || position === undefined || position < 0 ? file.position : position;
      const size = Math.max(existing.length, at + slice.length);
      const next = new Uint8Array(size);
      next.set(existing, 0);
      next.set(slice, at);
      tree.writeFileSync(file.path, next);
      file.cached = next;
      if (position === null || position === undefined || position < 0) file.position = at + slice.length;
      return slice.length;
    });
  },

  writeBuffers(fd: number, buffers: Uint8Array[], position: number | null, req?: FSReq): number | undefined {
    return answer(req, () => {
      let total = 0;
      for (const buffer of buffers) {
        total += fsBinding.writeBuffer(fd, buffer, 0, buffer.length,
          position === null || position === undefined ? null : position + total) as number;
      }
      return total;
    });
  },

  writeString(fd: number, value: string, position: number | null, encoding: string | undefined, req?: FSReq): number | undefined {
    const bytes = encoding === 'utf8' || encoding === undefined || encoding === 'utf-8'
      ? new TextEncoder().encode(value)
      : Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);
    return fsBinding.writeBuffer(fd, bytes, 0, bytes.length, position ?? null, req);
  },

  writeFileUtf8(path: unknown, data: string, flags: number, mode: number): undefined {
    // Node's UTF-8 fast path accepts a path OR an already-open descriptor.
    // Reuse open/write so flags, offsets and errors match the buffer path.
    const owned = typeof path !== 'number';
    const fd = owned ? fsBinding.open(path, flags, mode) as number : path as number;
    try { fsBinding.writeString(fd, data, null, 'utf8'); }
    finally { if (owned) fsBinding.close(fd); }
    return undefined;
  },

  // ---- metadata -----------------------------------------------------------
  stat(path: unknown, bigint: boolean, req?: FSReq, throwIfNoEntry = true): Float64Array | BigInt64Array | undefined {
    const work = (): Float64Array | BigInt64Array | undefined => {
      const name = asPath(path);
      try { return statArray(vfs().statSync(name), bigint, name); }
      catch (error) {
        if (throwIfNoEntry === false && (error as { code?: string }).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    return answer(req, work);
  },

  lstat(path: unknown, bigint: boolean, req?: FSReq, throwIfNoEntry = true): Float64Array | BigInt64Array | undefined {
    const work = (): Float64Array | BigInt64Array | undefined => {
      const name = asPath(path);
      try { return statArray(vfs().lstatSync(name), bigint, name); }
      catch (error) {
        if (throwIfNoEntry === false && (error as { code?: string }).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    return answer(req, work);
  },

  fstat(fd: number, bigint: boolean, req?: FSReq): Float64Array | BigInt64Array | undefined {
    return answer(req, () => {
      const file = fileFor(fd);
      return statArray(file.tree.statSync(file.path), bigint, file.path);
    });
  },

  /**
   * `statfs`: a tab's filesystem is the page's memory, and it has no device
   * of its own. The numbers are a filesystem's shape rather than a lie about
   * a disk: a block size, and a count no program can exhaust.
   */
  statfs(_path: unknown, bigint: boolean, req?: FSReq): Float64Array | BigInt64Array | undefined {
    // The order Node's `getStatFsFromBinding` reads: type, bsize, blocks,
    // bfree, bavail, files, ffree. `fs.statfs` and `fs.promises.statfs` pass
    // their flavour here like every other call, and it was read as nothing.
    return answer(req, () => {
      const values = [0, 4096, 2 ** 31, 2 ** 31, 2 ** 31, 2 ** 20, 2 ** 20];
      return bigint ? BigInt64Array.from(values.map((value) => BigInt(value))) : Float64Array.from(values);
    });
  },

  access(path: unknown, mode: number, req?: FSReq): undefined {
    return answer(req, () => {
      const name = asPath(path);
      vfs().accessSync(name, mode);
      return undefined;
    });
  },

  existsSync(path: unknown): boolean {
    try { return vfs().existsSync(asPath(path)); } catch { return false; }
  },

  /**
   * Node's `cpSync` asks this before it copies: a directory is not a file,
   * and without `recursive` the copy of one is `ERR_FS_EISDIR`.
   */
  cpSyncCheckPaths(src: unknown, dest: unknown, dereference: boolean, recursive: boolean): undefined {
    const source = asPath(src);
    const tree = vfs();
    const srcStat = dereference ? tree.statSync(source) : tree.lstatSync(source);
    if (srcStat.isDirectory() && !recursive) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, cp '${source}' -> '${asPath(dest)}'`), {
        code: 'ERR_FS_EISDIR',
        syscall: 'cp',
        path: source,
        dest: asPath(dest),
      });
    }
    return undefined;
  },

  /** Node's C++ `cp` of a file onto an existing dest. */
  cpSyncOverrideFile(src: unknown, dest: unknown, _mode: number, _preserveTimestamps: boolean): undefined {
    const tree = vfs();
    tree.writeFileSync(asPath(dest), tree.readFileSync(asPath(src)));
    return undefined;
  },

  /** Node's C++ recursive directory copy, without a JS filter. */
  cpSyncCopyDir(
    src: unknown, dest: unknown,
    force: boolean, dereference: boolean, errorOnExist: boolean,
    _verbatimSymlinks: boolean, _preserveTimestamps: boolean,
  ): undefined {
    const tree = vfs();
    const walk = (from: string, to: string): void => {
      const stats = dereference ? tree.statSync(from) : tree.lstatSync(from);
      if (stats.isDirectory()) {
        if (!tree.existsSync(to)) tree.mkdirSync(to, { recursive: true });
        else if (!tree.statSync(to).isDirectory()) {
          throw Object.assign(new Error(`EEXIST: file already exists, cp '${from}' -> '${to}'`), { code: 'EEXIST', syscall: 'cp', path: from });
        }
        for (const name of tree.readdirSync(from)) walk(`${from}/${name}`, `${to}/${name}`);
        return;
      }
      if (tree.existsSync(to)) {
        if (errorOnExist) throw Object.assign(new Error(`EEXIST: file already exists, cp '${from}' -> '${to}'`), { code: 'EEXIST', syscall: 'cp', path: from });
        if (!force) return;
      }
      const parent = to.slice(0, to.lastIndexOf('/')) || '/';
      if (parent !== '/' && !tree.existsSync(parent)) tree.mkdirSync(parent, { recursive: true });
      tree.writeFileSync(to, tree.readFileSync(from));
    };
    walk(asPath(src), asPath(dest));
    return undefined;
  },

  /**
   * What the module loader asks of a path before it reads it: 0 for a file,
   * 1 for a directory, and a negative errno for neither.
   *
   * Node has called this with a receiver in front of the path and without
   * one across versions; the three vendored call sites here -- `fs.js`'s
   * `glob` twice and `internal/fs/promises.js`'s once -- pass the path alone,
   * so the path is whichever argument is one.
   */
  internalModuleStat(receiver: unknown, path?: unknown): number {
    const name = path === undefined ? receiver : path;
    try {
      const stats = vfs().statSync(asPath(name));
      return stats.isDirectory() ? 1 : 0;
    } catch { return -2; }
  },

  // ---- the tree -----------------------------------------------------------
  readdir(path: unknown, encoding: string, withFileTypes: boolean, req?: FSReq): unknown {
    return answer(req, () => {
      const name = asPath(path);
      const tree = vfs();
      const names = tree.readdirSync(name).map((entry) => encodeFsName(entry, encoding));
      if (!withFileTypes) return names;
      // Node's own `Dirent` is built from a name and a type number, and the
      // binding answers the two lists side by side. Types are matched to the
      // tree's string names; the encoding only changes what the caller reads.
      const types = tree.readdirSync(name).map((entry) => {
        try {
          const stats = tree.lstatSync(`${name.endsWith('/') ? name.slice(0, -1) : name}/${entry}`);
          if (stats.isDirectory()) return 2;
          if (stats.isSymbolicLink()) return 10;
          return 1;
        } catch { return 0; }
      });
      return [names, types];
    });
  },

  mkdir(path: unknown, mode: number, recursive: boolean, req?: FSReq): string | undefined {
    return answer(req, () => {
      const name = asPath(path);
      const tree = vfs();
      const wanted = mode & 0o777;
      if (tree.existsSync(name)) {
        const stats = tree.statSync(name);
        if (!recursive || !stats.isDirectory()) throw createNodeError('EEXIST', 'mkdir', name);
        return undefined;
      }
      tree.mkdirSync(name, { recursive });
      tree.chmodSync(name, wanted);
      return undefined;
    });
  },

  rmdir(path: unknown, req?: FSReq): undefined {
    return answer(req, () => { vfs().rmdirSync(asPath(path)); return undefined; });
  },

  unlink(path: unknown, req?: FSReq): undefined {
    return answer(req, () => { vfs().unlinkSync(asPath(path)); return undefined; });
  },

  rename(from: unknown, to: unknown, req?: FSReq): undefined {
    return answer(req, () => { vfs().renameSync(asPath(from), asPath(to)); return undefined; });
  },

  copyFile(from: unknown, to: unknown, mode: number, req?: FSReq): undefined {
    return answer(req, () => {
      const tree = vfs();
      const source = asPath(from);
      const target = asPath(to);
      // `COPYFILE_EXCL` is the one mode a filesystem without clones can honour.
      if ((mode & 1) !== 0 && tree.existsSync(target)) throw createNodeError('EEXIST', 'copyfile', target);
      tree.writeFileSync(target, tree.readFileSync(source));
      return undefined;
    });
  },

  link(from: unknown, to: unknown, req?: FSReq): undefined {
    return answer(req, () => {
      const target = asPath(to);
      if (treeHoldsLinks()) {
        vfs().writeFileSync(target, vfs().readFileSync(asPath(from)));
        return undefined;
      }
      refuseLinks('link', target);
    });
  },

  symlink(target: unknown, path: unknown, _type: unknown, req?: FSReq): undefined {
    return answer(req, () => {
      const name = asPath(path);
      if (treeHoldsLinks()) {
        vfs().symlinkSync(asWritten(target), name);
        return undefined;
      }
      refuseLinks('symlink', name);
    });
  },

  readlink(path: unknown, encoding: string, req?: FSReq): string | Uint8Array | undefined {
    return answer(req, () => encodeFsName(vfs().readlinkSync(asPath(path)), encoding));
  },

  realpath(path: unknown, encoding: string, req?: FSReq): string | Uint8Array | undefined {
    return answer(req, () => encodeFsName(vfs().realpathSync(asPath(path)), encoding));
  },

  mkdtemp(prefix: unknown, encoding: string, req?: FSReq): string | Uint8Array | undefined {
    return answer(req, () => {
      const tree = vfs();
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      for (;;) {
        let suffix = '';
        for (let index = 0; index < 6; index += 1) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
        const name = `${asPath(prefix)}${suffix}`;
        if (tree.existsSync(name)) continue;
        tree.mkdirSync(name, { recursive: true });
        return encodeFsName(name, encoding);
      }
    });
  },

  // Metadata belongs to the filesystem, including a host's permission view.
  // Never keep a realm-global mode table or bypass that view for descriptors.
  chmod(path: unknown, mode: number, req?: FSReq): undefined {
    return answer(req, () => {
      const name = asPath(path);
      vfs().chmodSync(name, mode);
      return undefined;
    });
  },
  fchmod(fd: number, mode: number, req?: FSReq): undefined {
    return answer(req, () => {
      const file = fileFor(fd);
      file.tree.chmodSync(file.path, mode);
      return undefined;
    });
  },
  chown(_path: unknown, _uid: number, _gid: number, req?: FSReq): undefined { return answer(req, () => unsupportedMetadata('chown')); },
  fchown(_fd: number, _uid: number, _gid: number, req?: FSReq): undefined { return answer(req, () => unsupportedMetadata('fchown')); },
  lchown(_path: unknown, _uid: number, _gid: number, req?: FSReq): undefined { return answer(req, () => unsupportedMetadata('lchown')); },
  utimes(path: unknown, atime: number, mtime: number, req?: FSReq): undefined { return answer(req, () => { vfs().utimesSync(asPath(path), new Date(atime * 1000), new Date(mtime * 1000)); return undefined; }); },
  futimes(fd: number, atime: number, mtime: number, req?: FSReq): undefined { return answer(req, () => { const file = fileFor(fd); file.tree.utimesSync(file.path, new Date(atime * 1000), new Date(mtime * 1000)); return undefined; }); },
  lutimes(path: unknown, atime: number, mtime: number, req?: FSReq): undefined { return answer(req, () => {
    if (treeHoldsLinks()) return unsupportedMetadata('lutimes');
    vfs().utimesSync(asPath(path), new Date(atime * 1000), new Date(mtime * 1000));
    return undefined;
  }); },
  fsync(_fd: number, req?: FSReq): undefined { return answer(req, () => undefined); },
  fdatasync(_fd: number, req?: FSReq): undefined { return answer(req, () => undefined); },

  ftruncate(fd: number, length: number, req?: FSReq): undefined {
    return answer(req, () => {
      const file = fileFor(fd);
      if ((file.flags & 3) === 0) throw createNodeError('EBADF', 'ftruncate', file.path);
      const tree = file.tree;
      const bytes = file.cached ?? (tree.readFileSync(file.path) as Uint8Array);
      const next = new Uint8Array(length);
      next.set(bytes.subarray(0, Math.min(length, bytes.length)));
      tree.writeFileSync(file.path, next);
      file.cached = next;
      return undefined;
    });
  },
};

export default fsBinding;
