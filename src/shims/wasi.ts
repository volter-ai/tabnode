/**
 * `wasi`, as Node's own `lib/wasi.js` on a binding over the engine's
 * filesystem and process.
 *
 * What died: the engine had no `node:wasi` at all. `require('node:wasi')` and
 * `require('wasi')` both answered "Cannot find module", and
 * `module.builtinModules` did not list it where Node's does. The first program
 * to hit it in the tab was Tailwind v4's scanner, whose Node loader opens with
 * `const { WASI } = require('node:wasi')`; every route of the app died behind
 * that. Any program that runs a WASI-compiled wasm module hits the same wall.
 *
 * What Node does: `lib/wasi.js` is a thin JS surface — the `WASI` class, its
 * option validation, `start`, `initialize`, `getImportObject` — over
 * `internalBinding('wasi')`, a C++ wrap of uvwasi. The wrap's prototype holds
 * the forty-six `wasi_snapshot_preview1` syscalls, each reading the instance's
 * `WebAssembly.Memory` afresh on every call, checking every pointer against
 * the memory's current size (EOVERFLOW past it), answering an errno rather
 * than throwing, and throwing ERR_WASI_NOT_STARTED only when called before
 * `start`/`initialize` handed over the memory. uvwasi keeps its own descriptor
 * table over the host's fds — stdio at 0, 1, 2; the preopens from 3 upward in
 * the order given; every later open at the lowest free slot — with WASI rights
 * per file type, and resolves every guest path against the descriptor's
 * mapped path, refusing one that normalizes outside it with ENOTCAPABLE and a
 * symlink chain past thirty-two links with ELOOP.
 *
 * What this is: Node's `lib/wasi.js` v22.18.0, vendored unmodified in
 * `../node-lib/wasi.js` and evaluated per guest on a binding that supplies
 * what the Node runtime would have — `primordials`, the three internals it
 * requires, and `internalBinding('wasi')`. The binding is the uvwasi-shaped
 * class below, written from WASI preview1's witx and Node's `src/node_wasi.cc`
 * and uvwasi's sources, over the engine's fs shim (its descriptor table, its
 * tree) and the guest's process (stdio, exit, signals). It carries no
 * implementation from any WASI polyfill package. The rule for this file: the
 * JS surface is Node's file and is never edited here; a surface bug is fixed
 * by moving the vendored file to a newer Node. The binding is corrected only
 * toward what uvwasi answers.
 *
 * Measured by Node's own `test/wasi/*` through the substrate's
 * `scripts/engine-fork/node-tests.mjs`, and by `tests/wasi.test.ts`, a
 * differential against the host's `node:wasi`.
 *
 * What the engine cannot serve, and answers as uvwasi answers a host that
 * cannot: `path_link` is ENOSYS (the tree keeps no hard links); the process and
 * thread CPU-time clocks answer the monotonic clock (a tab has no CPU clock);
 * `fd_read` on descriptor 0 answers what the guest's stdin stream has already
 * buffered, then EOF (a syscall cannot wait); `poll_oneoff` sleeps the calling
 * thread for a clock subscription (Atomics.wait where the thread may, a timed
 * spin where it may not), as uvwasi blocks on its loop.
 */
import NODE_WASI_SOURCE from '../node-lib/wasi.js?raw';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  validateArray,
  validateBoolean,
  validateFunction,
  validateInt32,
  validateObject,
  validateString,
  validateUndefined,
} from '../node-internals';

// ---------------------------------------------------------------------------
// What the binding needs of the engine: the fs shim's synchronous surface, and
// the guest's process. Typed by shape so the runtime hands its own in.
// ---------------------------------------------------------------------------

/** The stats the engine's fs answers, read by name. */
export interface WasiHostStats {
  size: number;
  ino?: number;
  dev?: number;
  nlink?: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  atime?: Date;
  mtime?: Date;
  ctime?: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isCharacterDevice?(): boolean;
  isBlockDevice?(): boolean;
  isSocket?(): boolean;
  isFIFO?(): boolean;
}

export interface WasiHostDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The fs members the binding calls; each is the engine's `fs.<name>`. */
export interface WasiHostFs {
  existsSync(path: string): boolean;
  statSync(path: string): WasiHostStats;
  lstatSync(path: string): WasiHostStats;
  fstatSync(fd: number): WasiHostStats;
  openSync(path: string, flags: string | number, mode?: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): number;
  readdirSync(path: string, options: { withFileTypes: true }): WasiHostDirent[];
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  realpathSync(path: string): string;
  ftruncateSync(fd: number, length?: number): void;
  utimesSync?(path: string, atime: number, mtime: number): void;
  readlinkSync?(path: string): string;
  symlinkSync?(target: string, path: string): void;
}

/** The process members the binding reaches: the guest's own. */
export interface WasiHostProcess {
  pid: number;
  stdout: { write(data: string): unknown };
  stderr: { write(data: string): unknown };
  stdin: { read?: (size?: number) => string | Uint8Array | null };
  exit(code?: number): never;
  kill(pid: number, signal?: string | number): boolean;
  emitWarning(warning: string | Error, ...rest: unknown[]): void;
}

// ---------------------------------------------------------------------------
// WASI preview1's constants, from its witx (uvwasi's wasi_types.h carries the
// same numbers).
// ---------------------------------------------------------------------------

const ERRNO = {
  ESUCCESS: 0, E2BIG: 1, EACCES: 2, EADDRINUSE: 3, EADDRNOTAVAIL: 4, EAFNOSUPPORT: 5, EAGAIN: 6,
  EALREADY: 7, EBADF: 8, EBADMSG: 9, EBUSY: 10, ECANCELED: 11, ECHILD: 12, ECONNABORTED: 13,
  ECONNREFUSED: 14, ECONNRESET: 15, EDEADLK: 16, EDESTADDRREQ: 17, EDOM: 18, EDQUOT: 19, EEXIST: 20,
  EFAULT: 21, EFBIG: 22, EHOSTUNREACH: 23, EIDRM: 24, EILSEQ: 25, EINPROGRESS: 26, EINTR: 27,
  EINVAL: 28, EIO: 29, EISCONN: 30, EISDIR: 31, ELOOP: 32, EMFILE: 33, EMLINK: 34, EMSGSIZE: 35,
  EMULTIHOP: 36, ENAMETOOLONG: 37, ENETDOWN: 38, ENETRESET: 39, ENETUNREACH: 40, ENFILE: 41,
  ENOBUFS: 42, ENODEV: 43, ENOENT: 44, ENOEXEC: 45, ENOLCK: 46, ENOLINK: 47, ENOMEM: 48, ENOMSG: 49,
  ENOPROTOOPT: 50, ENOSPC: 51, ENOSYS: 52, ENOTCONN: 53, ENOTDIR: 54, ENOTEMPTY: 55,
  ENOTRECOVERABLE: 56, ENOTSOCK: 57, ENOTSUP: 58, ENOTTY: 59, ENXIO: 60, EOVERFLOW: 61,
  EOWNERDEAD: 62, EPERM: 63, EPIPE: 64, EPROTO: 65, EPROTONOSUPPORT: 66, EPROTOTYPE: 67, ERANGE: 68,
  EROFS: 69, ESPIPE: 70, ESRCH: 71, ESTALE: 72, ETIMEDOUT: 73, ETXTBSY: 74, EXDEV: 75, ENOTCAPABLE: 76,
} as const;
type Errno = (typeof ERRNO)[keyof typeof ERRNO];

/** The errno name for each WASI number, for the error a failed init throws. */
const ERRNO_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ERRNO).map(([name, value]) => [value, name]));

const FILETYPE = { UNKNOWN: 0, BLOCK_DEVICE: 1, CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4, SOCKET_DGRAM: 5, SOCKET_STREAM: 6, SYMBOLIC_LINK: 7 } as const;

const CLOCK = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME_ID: 2, THREAD_CPUTIME_ID: 3 } as const;

const EVENTTYPE = { CLOCK: 0, FD_READ: 1, FD_WRITE: 2 } as const;
const EVENT_FD_READWRITE_HANGUP = 1;
const SUBSCRIPTION_CLOCK_ABSTIME = 1;

const FDFLAG = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 } as const;
const OFLAG = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
const LOOKUP_SYMLINK_FOLLOW = 1;
const FSTFLAG = { ATIM: 1, ATIM_NOW: 2, MTIM: 4, MTIM_NOW: 8 } as const;
const WHENCE = { SET: 0, CUR: 1, END: 2 } as const;
const PREOPENTYPE_DIR = 0;

const RIGHT = {
  FD_DATASYNC: 1n << 0n, FD_READ: 1n << 1n, FD_SEEK: 1n << 2n, FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n, FD_TELL: 1n << 5n, FD_WRITE: 1n << 6n, FD_ADVISE: 1n << 7n, FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n, PATH_CREATE_FILE: 1n << 10n, PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n, PATH_OPEN: 1n << 13n, FD_READDIR: 1n << 14n, PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n, PATH_RENAME_TARGET: 1n << 17n, PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n, PATH_FILESTAT_SET_TIMES: 1n << 20n, FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n, FD_FILESTAT_SET_TIMES: 1n << 23n, PATH_SYMLINK: 1n << 24n,
  PATH_REMOVE_DIRECTORY: 1n << 25n, PATH_UNLINK_FILE: 1n << 26n, POLL_FD_READWRITE: 1n << 27n,
  SOCK_SHUTDOWN: 1n << 28n, SOCK_ACCEPT: 1n << 29n,
} as const;

// uvwasi's rights per file type (wasi_rights.h).
const RIGHTS_ALL = Object.values(RIGHT).reduce((all, right) => all | right, 0n);
const RIGHTS_REGULAR_FILE_BASE =
  RIGHT.FD_DATASYNC | RIGHT.FD_READ | RIGHT.FD_SEEK | RIGHT.FD_FDSTAT_SET_FLAGS | RIGHT.FD_SYNC |
  RIGHT.FD_TELL | RIGHT.FD_WRITE | RIGHT.FD_ADVISE | RIGHT.FD_ALLOCATE | RIGHT.FD_FILESTAT_GET |
  RIGHT.FD_FILESTAT_SET_SIZE | RIGHT.FD_FILESTAT_SET_TIMES | RIGHT.POLL_FD_READWRITE;
const RIGHTS_REGULAR_FILE_INHERITING = 0n;
const RIGHTS_DIRECTORY_BASE =
  RIGHT.FD_FDSTAT_SET_FLAGS | RIGHT.FD_SYNC | RIGHT.FD_ADVISE | RIGHT.PATH_CREATE_DIRECTORY |
  RIGHT.PATH_CREATE_FILE | RIGHT.PATH_LINK_SOURCE | RIGHT.PATH_LINK_TARGET | RIGHT.PATH_OPEN |
  RIGHT.FD_READDIR | RIGHT.PATH_READLINK | RIGHT.PATH_RENAME_SOURCE | RIGHT.PATH_RENAME_TARGET |
  RIGHT.PATH_FILESTAT_GET | RIGHT.PATH_FILESTAT_SET_SIZE | RIGHT.PATH_FILESTAT_SET_TIMES |
  RIGHT.FD_FILESTAT_GET | RIGHT.FD_FILESTAT_SET_TIMES | RIGHT.PATH_SYMLINK | RIGHT.PATH_UNLINK_FILE |
  RIGHT.PATH_REMOVE_DIRECTORY | RIGHT.POLL_FD_READWRITE;
const RIGHTS_DIRECTORY_INHERITING = RIGHTS_DIRECTORY_BASE | RIGHTS_REGULAR_FILE_BASE;
const RIGHTS_SOCKET_BASE =
  RIGHT.FD_READ | RIGHT.FD_FDSTAT_SET_FLAGS | RIGHT.FD_WRITE | RIGHT.FD_FILESTAT_GET |
  RIGHT.POLL_FD_READWRITE | RIGHT.SOCK_SHUTDOWN | RIGHT.SOCK_ACCEPT;
const RIGHTS_SOCKET_INHERITING = RIGHTS_ALL;
const RIGHTS_TTY_BASE = RIGHT.FD_READ | RIGHT.FD_FDSTAT_SET_FLAGS | RIGHT.FD_WRITE | RIGHT.FD_FILESTAT_GET | RIGHT.POLL_FD_READWRITE;
const RIGHTS_TTY_INHERITING = 0n;

/** WASI's signal numbers, to the names the guest's `process.kill` takes. */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
  9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
  16: 'SIGCHLD', 17: 'SIGCONT', 18: 'SIGSTOP', 19: 'SIGTSTP', 20: 'SIGTTIN', 21: 'SIGTTOU', 22: 'SIGURG',
  23: 'SIGXCPU', 24: 'SIGXFSZ', 25: 'SIGVTALRM', 26: 'SIGPROF', 27: 'SIGWINCH', 28: 'SIGPOLL', 29: 'SIGPWR', 30: 'SIGSYS',
};

// The engine's open flags, the numbers Node's fs.constants carry on Linux.
const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 64, O_EXCL = 128, O_TRUNC = 512, O_APPEND = 1024;

/** Structure sizes in guest memory (uvwasi's wasi_serdes.h). */
const SIZE = { iovec: 8, dirent: 24, fdstat: 24, filestat: 64, prestat: 8, event: 32, subscription: 48 } as const;

const MAX_SYMLINK_FOLLOWS = 32;
const NANOS_PER_SEC = 1_000_000_000n;

// ---------------------------------------------------------------------------
// Errors the JS surface reads.
// ---------------------------------------------------------------------------

class ERR_WASI_ALREADY_STARTED extends Error {
  code = 'ERR_WASI_ALREADY_STARTED';
  constructor() {
    super('WASI instance has already started');
    this.name = 'Error';
  }
}

class ERR_WASI_NOT_STARTED extends Error {
  code = 'ERR_WASI_NOT_STARTED';
  constructor() {
    super('wasi.start() has not been called');
    this.name = 'Error';
  }
}

/** node_wasi.cc's WASIException: what a failed uvwasi_init throws. */
function wasiException(errno: number, syscall: string): Error {
  const code = `UVWASI_${ERRNO_NAMES[errno] ?? 'EIO'}`;
  return Object.assign(new Error(`${code}, ${syscall}`), { errno, code, syscall });
}

/** The engine's fs error, as the errno uvwasi would translate the host's to. */
function errnoOf(error: unknown): Errno {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERRNO, code)) return ERRNO[code as keyof typeof ERRNO];
  return ERRNO.EIO;
}

/** Whether a thrown value is a filesystem error (one carrying a code) rather than the guest's exit. */
function isFsError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === 'string' && !/^ERR_/u.test((error as { code: string }).code);
}

// ---------------------------------------------------------------------------
// Paths, as uvwasi's path_resolver.c resolves them.
// ---------------------------------------------------------------------------

/** uvwasi__normalize_path: '.' and '..' folded, a leading '..' kept on a relative path. */
function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0 || out[out.length - 1] === '..') {
        if (!absolute) out.push('..');
      } else {
        out.pop();
      }
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) return absolute ? '/' : '.';
  return (absolute ? '/' : '') + out.join('/');
}

/** uvwasi__is_path_sandboxed: does a normalized path stay under the descriptor's? */
function isSandboxed(path: string, fdPath: string): boolean {
  if (fdPath.startsWith('/')) {
    if (fdPath === '/') return path.startsWith('/');
    return path === fdPath || path.startsWith(`${fdPath}/`);
  }
  if (fdPath === '.') return !(path === '..' || path.startsWith('../'));
  if (!(path === fdPath || path.startsWith(`${fdPath}/`))) return false;
  const rest = path.slice(fdPath.length + 1);
  return !(rest === '..' || rest.startsWith('../'));
}

function dirnameOf(path: string): string {
  const at = path.lastIndexOf('/');
  if (at < 0) return '.';
  if (at === 0) return '/';
  return path.slice(0, at);
}

// ---------------------------------------------------------------------------
// The descriptor table: uvwasi's, over the engine's descriptors.
// ---------------------------------------------------------------------------

/** One WASI descriptor: a guest stream, an open file of the engine, or a directory. */
interface Descriptor {
  kind: 'stream' | 'file' | 'dir';
  stream?: 'stdin' | 'stdout' | 'stderr';
  /** The engine's descriptor, for a file. */
  fd?: number;
  /** The guest's path, normalized; what path resolution is sandboxed to. */
  path: string;
  /** The engine's path the guest path maps to. */
  hostPath: string;
  type: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
  preopen: boolean;
  fdflags: number;
  /** The file cursor, kept here since the engine's descriptor has no lseek. */
  position: number;
  /** A stream's decoder, so a multi-byte character split across two writes arrives whole. */
  decoder?: TextDecoder;
}

interface Filestat {
  dev: bigint;
  ino: bigint;
  filetype: number;
  nlink: bigint;
  size: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
}

/** uvwasi__stat_to_filetype */
function filetypeOf(stats: WasiHostStats): number {
  if (stats.isSymbolicLink()) return FILETYPE.SYMBOLIC_LINK;
  if (stats.isFile()) return FILETYPE.REGULAR_FILE;
  if (stats.isDirectory()) return FILETYPE.DIRECTORY;
  if (stats.isCharacterDevice?.()) return FILETYPE.CHARACTER_DEVICE;
  if (stats.isBlockDevice?.()) return FILETYPE.BLOCK_DEVICE;
  if (stats.isSocket?.() || stats.isFIFO?.()) return FILETYPE.SOCKET_STREAM;
  return FILETYPE.UNKNOWN;
}

function nanosOf(ms: number | undefined, date: Date | undefined): bigint {
  const value = typeof ms === 'number' ? ms : date instanceof Date ? date.getTime() : 0;
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const whole = Math.floor(value);
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((value - whole) * 1e6));
}

/** uvwasi__stat_to_filestat */
function filestatOf(stats: WasiHostStats): Filestat {
  return {
    dev: BigInt(stats.dev ?? 0),
    ino: BigInt(stats.ino ?? 0),
    filetype: filetypeOf(stats),
    nlink: BigInt(stats.nlink ?? 1),
    size: BigInt(stats.size ?? 0),
    atim: nanosOf(stats.atimeMs, stats.atime),
    mtim: nanosOf(stats.mtimeMs, stats.mtime),
    ctim: nanosOf(stats.ctimeMs, stats.ctime),
  };
}

// ---------------------------------------------------------------------------
// Guest memory, read afresh on every call: the buffer changes when the guest
// grows its memory (Node's test fd_prestat_get_refresh grows between calls).
// ---------------------------------------------------------------------------

class GuestMemory {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  /** A shared memory (a threaded guest's) cannot be handed to TextDecoder or getRandomValues; its bytes are copied through. */
  readonly shared: boolean;
  constructor(buffer: ArrayBufferLike) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.shared = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
  }
  /** The bytes at a range, as a view where the memory is unshared and as a copy where it is shared. */
  bytesAt(offset: number, length: number): Uint8Array {
    const range = this.bytes.subarray(offset, offset + length);
    return this.shared ? range.slice() : range;
  }
  /** node_wasi.cc's CHECK_BOUNDS_OR_RETURN. */
  fits(offset: number, size: number): boolean {
    return offset >= 0 && size >= 0 && offset + size <= this.bytes.length;
  }
  u8(offset: number): number { return this.view.getUint8(offset); }
  u16(offset: number): number { return this.view.getUint16(offset, true); }
  u32(offset: number): number { return this.view.getUint32(offset, true); }
  u64(offset: number): bigint { return this.view.getBigUint64(offset, true); }
  setU8(offset: number, value: number): void { this.view.setUint8(offset, value); }
  setU16(offset: number, value: number): void { this.view.setUint16(offset, value, true); }
  setU32(offset: number, value: number): void { this.view.setUint32(offset, value >>> 0, true); }
  setU64(offset: number, value: bigint): void { this.view.setBigUint64(offset, BigInt.asUintN(64, value), true); }
  text(offset: number, length: number): string {
    return new TextDecoder().decode(this.bytesAt(offset, length));
  }
  writeFilestat(offset: number, stat: Filestat): void {
    this.setU64(offset, stat.dev);
    this.setU64(offset + 8, stat.ino);
    this.setU8(offset + 16, stat.filetype);
    this.setU64(offset + 24, stat.nlink);
    this.setU64(offset + 32, stat.size);
    this.setU64(offset + 40, stat.atim);
    this.setU64(offset + 48, stat.mtim);
    this.setU64(offset + 56, stat.ctim);
  }
}

/** The (pointer, length) pairs an iovec array names, bounds-checked as a whole. */
function iovecsOf(memory: GuestMemory, iovsPtr: number, iovsLen: number): Array<[number, number]> | Errno {
  if (!memory.fits(iovsPtr, iovsLen * SIZE.iovec)) return ERRNO.EOVERFLOW;
  const iovs: Array<[number, number]> = [];
  for (let index = 0; index < iovsLen; index += 1) {
    const ptr = memory.u32(iovsPtr + index * SIZE.iovec);
    const len = memory.u32(iovsPtr + index * SIZE.iovec + 4);
    if (!memory.fits(ptr, len)) return ERRNO.EOVERFLOW;
    iovs.push([ptr, len]);
  }
  return iovs;
}

// ---------------------------------------------------------------------------
// Clocks and sleeping.
// ---------------------------------------------------------------------------

function nanosSince(ms: number): bigint {
  const whole = Math.floor(ms);
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6));
}

function realtimeNanos(): bigint {
  return nanosSince(performance.timeOrigin + performance.now());
}

function monotonicNanos(): bigint {
  return nanosSince(performance.now());
}

/**
 * A synchronous sleep, which is what a clock subscription is to the guest: it
 * called poll_oneoff and expects to resume after the timeout. Atomics.wait
 * parks the thread where the thread may park (a worker, a Node host); on a
 * thread that may not, the time is spent watching the clock.
 */
function sleepNanos(nanos: bigint): void {
  if (nanos <= 0n) return;
  const ms = Number(nanos) / 1e6;
  const until = performance.now() + ms;
  if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function') {
    try {
      const cell = new Int32Array(new SharedArrayBuffer(4));
      let remaining = until - performance.now();
      while (remaining > 0) {
        Atomics.wait(cell, 0, 0, remaining);
        remaining = until - performance.now();
      }
      return;
    } catch {
      // Not allowed on this thread; fall through to the timed spin.
    }
  }
  while (performance.now() < until) { /* spin */ }
}

// ---------------------------------------------------------------------------
// The binding: internalBinding('wasi').WASI for one guest.
// ---------------------------------------------------------------------------

/** What a wrap instance holds. Kept off the instance: Node's lib binds every enumerable property as a function. */
interface WrapState {
  args: string[];
  env: string[];
  table: Map<number, Descriptor>;
  memory: WebAssembly.Memory | undefined;
  /** Bytes the guest's stdin stream has yielded and the guest has not yet read. */
  stdinPending: Uint8Array;
  stdinEnded: boolean;
}

interface BindingClass {
  new (args: string[], env: string[], preopens: string[], stdio: number[]): object;
}

function isWasmMemory(value: unknown): value is WebAssembly.Memory {
  // A memory from another realm (Node's tests instantiate in a vm context) is
  // not an instanceof this realm's constructor; its tag is the same everywhere.
  return value !== null && typeof value === 'object' && Object.prototype.toString.call(value) === '[object WebAssembly.Memory]';
}

function bindingClassFor(fs: WasiHostFs, process: WasiHostProcess): BindingClass {
  const states = new WeakMap<object, WrapState>();
  const encoder = new TextEncoder();

  const stateOf = (wrap: object): WrapState => {
    const state = states.get(wrap);
    if (state === undefined) throw new TypeError('Illegal invocation');
    return state;
  };

  // A stream descriptor of the guest's process. The engine's stdio are pipes
  // to the shell (its streams report no TTY), which uvwasi types as a socket
  // stream with socket rights; a TTY gets the narrower TTY rights.
  const streamDescriptor = (stream: 'stdin' | 'stdout' | 'stderr', isTTY: boolean): Descriptor => ({
    kind: 'stream',
    stream,
    path: `<${stream}>`,
    hostPath: '',
    type: isTTY ? FILETYPE.CHARACTER_DEVICE : FILETYPE.SOCKET_STREAM,
    rightsBase: isTTY ? RIGHTS_TTY_BASE : RIGHTS_SOCKET_BASE,
    rightsInheriting: isTTY ? RIGHTS_TTY_INHERITING : RIGHTS_SOCKET_INHERITING,
    preopen: false,
    fdflags: 0,
    position: 0,
    decoder: stream === 'stdin' ? undefined : new TextDecoder(),
  });

  /** uvwasi__get_rights */
  const rightsFor = (type: number, accessFlags: number): [bigint, bigint] => {
    let base: bigint;
    let inheriting: bigint;
    switch (type) {
      case FILETYPE.REGULAR_FILE: base = RIGHTS_REGULAR_FILE_BASE; inheriting = RIGHTS_REGULAR_FILE_INHERITING; break;
      case FILETYPE.DIRECTORY: base = RIGHTS_DIRECTORY_BASE; inheriting = RIGHTS_DIRECTORY_INHERITING; break;
      case FILETYPE.SOCKET_STREAM: case FILETYPE.SOCKET_DGRAM: base = RIGHTS_SOCKET_BASE; inheriting = RIGHTS_SOCKET_INHERITING; break;
      case FILETYPE.CHARACTER_DEVICE: case FILETYPE.BLOCK_DEVICE: base = RIGHTS_ALL; inheriting = RIGHTS_ALL; break;
      default: base = 0n; inheriting = 0n;
    }
    const access = accessFlags & 3;
    if (access === O_RDONLY) base &= ~RIGHT.FD_WRITE;
    else if (access === O_WRONLY) base &= ~RIGHT.FD_READ;
    return [base, inheriting];
  };

  /** A descriptor over one of the engine's open files (a stdio option naming an fd, or a path_open). */
  const fileDescriptor = (fd: number, guestPath: string, hostPath: string, accessFlags: number, fdflags: number): Descriptor => {
    const stats = fs.fstatSync(fd);
    const type = filetypeOf(stats);
    const [rightsBase, rightsInheriting] = rightsFor(type, accessFlags);
    return { kind: 'file', fd, path: guestPath, hostPath, type, rightsBase, rightsInheriting, preopen: false, fdflags, position: fdflags & FDFLAG.APPEND ? stats.size : 0 };
  };

  /** uvwasi_fd_table_insert: the lowest free slot. */
  const insert = (table: Map<number, Descriptor>, descriptor: Descriptor): number => {
    let fd = 0;
    while (table.has(fd)) fd += 1;
    table.set(fd, descriptor);
    return fd;
  };

  /** uvwasi_fd_table_get: the descriptor, or EBADF, or ENOTCAPABLE when it lacks a right asked for. */
  const lookup = (state: WrapState, fd: number, rightsBase = 0n, rightsInheriting = 0n): Descriptor | Errno => {
    const descriptor = state.table.get(fd >>> 0);
    if (descriptor === undefined) return ERRNO.EBADF;
    if ((~descriptor.rightsBase & rightsBase) !== 0n || (~descriptor.rightsInheriting & rightsInheriting) !== 0n) return ERRNO.ENOTCAPABLE;
    return descriptor;
  };

  /** The host path a guest path under a descriptor maps to (uvwasi__resolve_path_to_host). */
  const hostPathOf = (descriptor: Descriptor, guestPath: string): string => {
    if (guestPath === descriptor.path) return descriptor.hostPath;
    const rest = descriptor.path === '/' ? guestPath.slice(1) : descriptor.path === '.' ? guestPath : guestPath.slice(descriptor.path.length + 1);
    return descriptor.hostPath === '/' ? `/${rest}` : `${descriptor.hostPath}/${rest}`;
  };

  /**
   * uvwasi__resolve_path: the guest path normalized against the descriptor's,
   * refused when it leaves the descriptor's tree, and, when asked, followed
   * through symlinks with each target resolved the same way.
   */
  const resolve = (descriptor: Descriptor, path: string, lookupFlags: number): { guest: string; host: string } | Errno => {
    if (descriptor.kind === 'stream') return ERRNO.ENOTDIR;
    // uvwasi refuses these before it resolves anything, and normalizing first
    // folded them away: an empty path opened the preopen itself, a trailing
    // slash opened a file as though it were a directory, an absolute path
    // that happened to land inside the preopen was admitted where uvwasi
    // refuses every absolute path, and a path carrying a NUL reached the
    // filesystem as a name.
    if (path.length === 0) return ERRNO.EINVAL;
    if (path.includes('\0')) return ERRNO.EINVAL;
    if (path.startsWith('/')) return ERRNO.ENOTCAPABLE;
    // A path written with a trailing slash names a directory, whatever it
    // resolves to.
    const mustBeDirectory = path.endsWith('/');
    let input = path;
    for (let follows = 0; ; follows += 1) {
      const normalized = normalizePath(`${descriptor.path}/${input}`);
      if (!isSandboxed(normalized, descriptor.path)) return ERRNO.ENOTCAPABLE;
      const host = hostPathOf(descriptor, normalized);
      if (mustBeDirectory) {
        try { if (!fs.statSync(host).isDirectory()) return ERRNO.ENOTDIR; } catch { /* absent: the caller's own errno */ }
      }
      if ((lookupFlags & LOOKUP_SYMLINK_FOLLOW) === 0) return { guest: normalized, host };
      let target: string;
      try {
        if (!fs.lstatSync(host).isSymbolicLink() || typeof fs.readlinkSync !== 'function') return { guest: normalized, host };
        target = fs.readlinkSync(host);
      } catch {
        // Not there, or not a link: both are fine here, as uvwasi treats them.
        return { guest: normalized, host };
      }
      if (follows + 1 >= MAX_SYMLINK_FOLLOWS) return ERRNO.ELOOP;
      // A link's target is resolved against the descriptor again, and an
      // absolute target leaves the descriptor's tree.
      if (target.startsWith('/')) return ERRNO.ENOTCAPABLE;
      input = `${dirnameOf(normalized)}/${target}`;
    }
  };

  const filestatOfDescriptor = (descriptor: Descriptor): Filestat => {
    if (descriptor.kind === 'file') return filestatOf(fs.fstatSync(descriptor.fd!));
    if (descriptor.kind === 'dir') return filestatOf(fs.statSync(descriptor.hostPath));
    return { dev: 0n, ino: 0n, filetype: descriptor.type, nlink: 1n, size: 0n, atim: 0n, mtim: 0n, ctim: 0n };
  };

  const sizeOf = (descriptor: Descriptor): number => (descriptor.kind === 'file' ? fs.fstatSync(descriptor.fd!).size : 0);

  /** What the guest's stdin has to give: whatever its stream yields now; then EOF. */
  const readStdin = (state: WrapState, into: Uint8Array): number => {
    if (state.stdinPending.length === 0 && !state.stdinEnded) {
      const chunk = typeof process.stdin.read === 'function' ? process.stdin.read() : null;
      if (chunk === null || chunk === undefined) state.stdinEnded = true;
      else state.stdinPending = typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk);
    }
    const count = Math.min(into.length, state.stdinPending.length);
    into.set(state.stdinPending.subarray(0, count));
    state.stdinPending = state.stdinPending.subarray(count);
    return count;
  };

  const writeStream = (descriptor: Descriptor, bytes: Uint8Array): void => {
    const text = descriptor.decoder!.decode(bytes, { stream: true });
    if (text.length === 0) return;
    (descriptor.stream === 'stderr' ? process.stderr : process.stdout).write(text);
  };

  /** uvwasi__get_filestat_set_times: the seconds to set, from the flags and the times given. */
  const timesToSet = (descriptor: Descriptor | null, hostPath: string, atim: bigint, mtim: bigint, flags: number): [number, number] => {
    const now = realtimeNanos();
    let current: Filestat | undefined;
    if ((flags & (FSTFLAG.ATIM | FSTFLAG.ATIM_NOW)) === 0 || (flags & (FSTFLAG.MTIM | FSTFLAG.MTIM_NOW)) === 0) {
      current = descriptor ? filestatOfDescriptor(descriptor) : filestatOf(fs.lstatSync(hostPath));
    }
    const atime = flags & FSTFLAG.ATIM_NOW ? now : flags & FSTFLAG.ATIM ? atim : current!.atim;
    const mtime = flags & FSTFLAG.MTIM_NOW ? now : flags & FSTFLAG.MTIM ? mtim : current!.mtim;
    // Seconds, fraction kept: uvwasi sets the times to the nanosecond, and
    // truncating here lost every sub-second a program asked for.
    return [Number(atime) / Number(NANOS_PER_SEC), Number(mtime) / Number(NANOS_PER_SEC)];
  };

  const setTimes = (hostPath: string, atime: number, mtime: number): Errno => {
    if (typeof fs.utimesSync !== 'function') return ERRNO.ENOSYS;
    fs.utimesSync(hostPath, atime, mtime);
    return ERRNO.ESUCCESS;
  };

  class WASI {
    constructor(args: string[], env: string[], preopens: string[], stdio: number[]) {
      const table = new Map<number, Descriptor>();
      const state: WrapState = { args: [...args], env: [...env], table, memory: undefined, stdinPending: new Uint8Array(0), stdinEnded: false };
      // uvwasi_init: stdio first, at 0, 1, 2; a stdio option naming another
      // descriptor is one of the engine's open files (the guest opened it).
      const names = ['stdin', 'stdout', 'stderr'] as const;
      for (let index = 0; index < 3; index += 1) {
        const given = stdio[index];
        if (given === index) {
          table.set(index, streamDescriptor(names[index], (process[names[index]] as { isTTY?: boolean }).isTTY === true));
          continue;
        }
        if (given === 0 || given === 1 || given === 2) {
          table.set(index, streamDescriptor(names[given], (process[names[given]] as { isTTY?: boolean }).isTTY === true));
          continue;
        }
        try {
          table.set(index, fileDescriptor(given, `<${names[index]}>`, '', O_RDWR, 0));
        } catch (error) {
          throw wasiException(errnoOf(error), 'uvwasi_init');
        }
      }
      // Then the preopens, in the order given, each a directory that is there.
      for (let index = 0; index + 1 < preopens.length; index += 2) {
        const mapped = preopens[index];
        const real = preopens[index + 1];
        let hostPath: string;
        let stats: WasiHostStats;
        try {
          hostPath = fs.realpathSync(real);
          stats = fs.statSync(hostPath);
        } catch (error) {
          throw wasiException(errnoOf(error), 'uvwasi_init');
        }
        if (!stats.isDirectory()) throw wasiException(ERRNO.ENOTDIR, 'uvwasi_init');
        insert(table, {
          kind: 'dir',
          path: normalizePath(mapped),
          hostPath,
          type: FILETYPE.DIRECTORY,
          rightsBase: RIGHTS_DIRECTORY_BASE,
          rightsInheriting: RIGHTS_DIRECTORY_INHERITING,
          preopen: true,
          fdflags: 0,
          position: 0,
        });
      }
      states.set(this, state);
      // An own, enumerable, deletable property, as node_wasi.cc installs it on
      // the instance: lib/wasi.js takes it and deletes it from the import object.
      Object.defineProperty(this, '_setMemory', {
        value: function _setMemory(this: object, memory: unknown) {
          if (!isWasmMemory(memory)) {
            throw Object.assign(new TypeError('"instance.exports.memory" property must be a WebAssembly.Memory object'), { code: 'ERR_INVALID_ARG_TYPE' });
          }
          stateOf(this).memory = memory;
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  type Syscall = (this: object, state: WrapState, memory: GuestMemory, ...args: Array<number | bigint>) => Errno | void;

  /**
   * One syscall on the prototype, enumerable so lib/wasi.js's `for...in` binds
   * it. As node_wasi.cc's SlowCallback: the wrong count or type of arguments
   * is EINVAL; a call before the memory is set throws ERR_WASI_NOT_STARTED;
   * the memory is read afresh; a filesystem failure is its errno.
   */
  const define = (name: string, signature: string, syscall: Syscall): void => {
    const method = function (this: object, ...args: Array<number | bigint>): number | void {
      if (args.length !== signature.length) return ERRNO.EINVAL;
      for (let index = 0; index < signature.length; index += 1) {
        const kind = signature[index] === 'L' ? 'bigint' : 'number';
        if (typeof args[index] !== kind) return ERRNO.EINVAL;
      }
      const state = stateOf(this);
      if (state.memory === undefined) throw new ERR_WASI_NOT_STARTED();
      const normalized = args.map((value, index) => (signature[index] === 'L' ? BigInt.asUintN(64, value as bigint) : (value as number) >>> 0));
      try {
        const result = syscall.call(this, state, new GuestMemory(state.memory.buffer), ...normalized);
        return result === undefined ? ERRNO.ESUCCESS : result;
      } catch (error) {
        if (isFsError(error)) return errnoOf(error);
        throw error;
      }
    };
    Object.defineProperty(method, 'name', { value: name, configurable: true });
    Object.defineProperty(WASI.prototype, name, { value: method, enumerable: true, writable: true, configurable: true });
  };

  // Signatures: 'i' a 32-bit integer, 'L' a 64-bit one (a BigInt at this boundary).
  // The order below is the order node_wasi.cc declares the syscalls, because
  // lib/wasi.js builds `wasiImport` by a `for...in` over this prototype and a
  // guest reads `Object.keys(wasi.wasiImport)`: not alphabetical
  // (fd_prestat_get precedes fd_prestat_dir_name).

  define('args_get', 'ii', (state, memory, argvPtr, bufPtr) => {
    const bytes = state.args.map((arg) => encoder.encode(`${arg}\0`));
    const size = bytes.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!memory.fits(bufPtr as number, size) || !memory.fits(argvPtr as number, state.args.length * 4)) return ERRNO.EOVERFLOW;
    let at = bufPtr as number;
    bytes.forEach((chunk, index) => {
      memory.setU32((argvPtr as number) + index * 4, at);
      memory.bytes.set(chunk, at);
      at += chunk.length;
    });
  });

  define('args_sizes_get', 'ii', (state, memory, argcPtr, bufSizePtr) => {
    if (!memory.fits(argcPtr as number, 4) || !memory.fits(bufSizePtr as number, 4)) return ERRNO.EOVERFLOW;
    memory.setU32(argcPtr as number, state.args.length);
    memory.setU32(bufSizePtr as number, state.args.reduce((sum, arg) => sum + encoder.encode(arg).length + 1, 0));
  });

  define('clock_res_get', 'ii', (_state, memory, clockId, resolutionPtr) => {
    if (!memory.fits(resolutionPtr as number, 8)) return ERRNO.EOVERFLOW;
    switch (clockId) {
      case CLOCK.REALTIME: case CLOCK.MONOTONIC: case CLOCK.PROCESS_CPUTIME_ID: case CLOCK.THREAD_CPUTIME_ID:
        memory.setU64(resolutionPtr as number, 1n);
        return;
      default:
        return ERRNO.EINVAL;
    }
  });

  define('clock_time_get', 'iLi', (_state, memory, clockId, _precision, timePtr) => {
    if (!memory.fits(timePtr as number, 8)) return ERRNO.EOVERFLOW;
    switch (clockId) {
      case CLOCK.REALTIME:
        memory.setU64(timePtr as number, realtimeNanos());
        return;
      case CLOCK.MONOTONIC:
      // A tab has no CPU clock; the process and thread CPU clocks answer the
      // time the program has run, which is what a guest measuring its own
      // progress against them needs to see advance.
      case CLOCK.PROCESS_CPUTIME_ID:
      case CLOCK.THREAD_CPUTIME_ID:
        memory.setU64(timePtr as number, monotonicNanos());
        return;
      default:
        return ERRNO.EINVAL;
    }
  });

  define('environ_get', 'ii', (state, memory, environPtr, bufPtr) => {
    const bytes = state.env.map((entry) => encoder.encode(`${entry}\0`));
    const size = bytes.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!memory.fits(bufPtr as number, size) || !memory.fits(environPtr as number, state.env.length * 4)) return ERRNO.EOVERFLOW;
    let at = bufPtr as number;
    bytes.forEach((chunk, index) => {
      memory.setU32((environPtr as number) + index * 4, at);
      memory.bytes.set(chunk, at);
      at += chunk.length;
    });
  });

  define('environ_sizes_get', 'ii', (state, memory, countPtr, bufSizePtr) => {
    if (!memory.fits(countPtr as number, 4) || !memory.fits(bufSizePtr as number, 4)) return ERRNO.EOVERFLOW;
    memory.setU32(countPtr as number, state.env.length);
    memory.setU32(bufSizePtr as number, state.env.reduce((sum, entry) => sum + encoder.encode(entry).length + 1, 0));
  });

  define('fd_advise', 'iLLi', (state, _memory, fd, _offset, _len, advice) => {
    const descriptor = lookup(state, fd as number, RIGHT.FD_ADVISE);
    if (typeof descriptor === 'number') return descriptor;
    if ((advice as number) > 5) return ERRNO.EINVAL;
  });

  define('fd_allocate', 'iLL', (state, _memory, fd, offset, len) => {
    const descriptor = lookup(state, fd as number, RIGHT.FD_ALLOCATE);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind !== 'file') return ERRNO.EBADF;
    const end = Number((offset as bigint) + (len as bigint));
    if (end > sizeOf(descriptor)) fs.ftruncateSync(descriptor.fd!, end);
  });

  define('fd_close', 'i', (state, _memory, fd) => {
    const descriptor = lookup(state, fd as number);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind === 'file') fs.closeSync(descriptor.fd!);
    state.table.delete(fd as number);
  });

  define('fd_datasync', 'i', (state, _memory, fd) => {
    const descriptor = lookup(state, fd as number, RIGHT.FD_DATASYNC);
    if (typeof descriptor === 'number') return descriptor;
  });

  define('fd_fdstat_get', 'ii', (state, memory, fd, bufPtr) => {
    if (!memory.fits(bufPtr as number, SIZE.fdstat)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number);
    if (typeof descriptor === 'number') return descriptor;
    memory.setU8(bufPtr as number, descriptor.type);
    memory.setU16((bufPtr as number) + 2, descriptor.fdflags);
    memory.setU64((bufPtr as number) + 8, descriptor.rightsBase);
    memory.setU64((bufPtr as number) + 16, descriptor.rightsInheriting);
  });

  define('fd_fdstat_set_flags', 'ii', (state, _memory, fd, flags) => {
    const descriptor = lookup(state, fd as number, RIGHT.FD_FDSTAT_SET_FLAGS);
    if (typeof descriptor === 'number') return descriptor;
    descriptor.fdflags = flags as number;
  });

  define('fd_fdstat_set_rights', 'iLL', (state, _memory, fd, rightsBase, rightsInheriting) => {
    const descriptor = lookup(state, fd as number);
    if (typeof descriptor === 'number') return descriptor;
    // Rights can only be narrowed.
    if ((~descriptor.rightsBase & (rightsBase as bigint)) !== 0n || (~descriptor.rightsInheriting & (rightsInheriting as bigint)) !== 0n) return ERRNO.ENOTCAPABLE;
    descriptor.rightsBase = rightsBase as bigint;
    descriptor.rightsInheriting = rightsInheriting as bigint;
  });

  define('fd_filestat_get', 'ii', (state, memory, fd, bufPtr) => {
    if (!memory.fits(bufPtr as number, SIZE.filestat)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.FD_FILESTAT_GET);
    if (typeof descriptor === 'number') return descriptor;
    memory.writeFilestat(bufPtr as number, filestatOfDescriptor(descriptor));
  });

  define('fd_filestat_set_size', 'iL', (state, _memory, fd, size) => {
    const descriptor = lookup(state, fd as number, RIGHT.FD_FILESTAT_SET_SIZE);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind !== 'file') return ERRNO.EBADF;
    fs.ftruncateSync(descriptor.fd!, Number(size as bigint));
  });

  define('fd_filestat_set_times', 'iLLi', (state, _memory, fd, atim, mtim, flags) => {
    const descriptor = lookup(state, fd as number, RIGHT.FD_FILESTAT_SET_TIMES);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind === 'stream') return ERRNO.EBADF;
    const [atime, mtime] = timesToSet(descriptor, descriptor.hostPath, atim as bigint, mtim as bigint, flags as number);
    return setTimes(descriptor.hostPath, atime, mtime);
  });

  define('fd_pread', 'iiiLi', (state, memory, fd, iovsPtr, iovsLen, offset, nreadPtr) => {
    if (!memory.fits(nreadPtr as number, 4)) return ERRNO.EOVERFLOW;
    const iovs = iovecsOf(memory, iovsPtr as number, iovsLen as number);
    if (typeof iovs === 'number') return iovs;
    const descriptor = lookup(state, fd as number, RIGHT.FD_READ | RIGHT.FD_SEEK);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind !== 'file') return ERRNO.EBADF;
    let at = Number(offset as bigint);
    let total = 0;
    for (const [ptr, len] of iovs) {
      const count = fs.readSync(descriptor.fd!, memory.bytes.subarray(ptr, ptr + len), 0, len, at);
      at += count;
      total += count;
      if (count < len) break;
    }
    memory.setU32(nreadPtr as number, total);
  });

  define('fd_prestat_get', 'ii', (state, memory, fd, bufPtr) => {
    if (!memory.fits(bufPtr as number, SIZE.prestat)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number);
    if (typeof descriptor === 'number') return descriptor;
    if (!descriptor.preopen) return ERRNO.EINVAL;
    memory.setU8(bufPtr as number, PREOPENTYPE_DIR);
    memory.setU32((bufPtr as number) + 4, encoder.encode(descriptor.path).length);
  });

  define('fd_prestat_dir_name', 'iii', (state, memory, fd, pathPtr, pathLen) => {
    if (!memory.fits(pathPtr as number, pathLen as number)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number);
    if (typeof descriptor === 'number') return descriptor;
    if (!descriptor.preopen) return ERRNO.EBADF;
    const name = encoder.encode(descriptor.path);
    if (name.length > (pathLen as number)) return ERRNO.ENOBUFS;
    memory.bytes.set(name, pathPtr as number);
  });

  define('fd_pwrite', 'iiiLi', (state, memory, fd, iovsPtr, iovsLen, offset, nwrittenPtr) => {
    if (!memory.fits(nwrittenPtr as number, 4)) return ERRNO.EOVERFLOW;
    const iovs = iovecsOf(memory, iovsPtr as number, iovsLen as number);
    if (typeof iovs === 'number') return iovs;
    const descriptor = lookup(state, fd as number, RIGHT.FD_WRITE | RIGHT.FD_SEEK);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind !== 'file') return ERRNO.EBADF;
    let at = Number(offset as bigint);
    let total = 0;
    for (const [ptr, len] of iovs) {
      const count = fs.writeSync(descriptor.fd!, memory.bytes.subarray(ptr, ptr + len), 0, len, at);
      at += count;
      total += count;
    }
    memory.setU32(nwrittenPtr as number, total);
  });

  define('fd_read', 'iiii', (state, memory, fd, iovsPtr, iovsLen, nreadPtr) => {
    if (!memory.fits(nreadPtr as number, 4)) return ERRNO.EOVERFLOW;
    const iovs = iovecsOf(memory, iovsPtr as number, iovsLen as number);
    if (typeof iovs === 'number') return iovs;
    const descriptor = lookup(state, fd as number, RIGHT.FD_READ);
    if (typeof descriptor === 'number') return descriptor;
    let total = 0;
    if (descriptor.kind === 'stream') {
      if (descriptor.stream !== 'stdin') return ERRNO.EBADF;
      for (const [ptr, len] of iovs) {
        const count = readStdin(state, memory.bytes.subarray(ptr, ptr + len));
        total += count;
        if (count < len) break;
      }
    } else if (descriptor.kind === 'file') {
      for (const [ptr, len] of iovs) {
        const count = fs.readSync(descriptor.fd!, memory.bytes.subarray(ptr, ptr + len), 0, len, descriptor.position);
        descriptor.position += count;
        total += count;
        if (count < len) break;
      }
    } else {
      return ERRNO.EISDIR;
    }
    memory.setU32(nreadPtr as number, total);
  });

  define('fd_readdir', 'iiiLi', (state, memory, fd, bufPtr, bufLen, cookie, bufusedPtr) => {
    if (!memory.fits(bufPtr as number, bufLen as number) || !memory.fits(bufusedPtr as number, 4)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.FD_READDIR);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind !== 'dir') return ERRNO.ENOTDIR;
    const entries = fs.readdirSync(descriptor.hostPath, { withFileTypes: true });
    // The cookie is the index of the next entry to hand over, as uvwasi's is
    // the directory stream's telldir position.
    let used = 0;
    for (let index = Number(cookie as bigint); index < entries.length; index += 1) {
      const entry = entries[index];
      const name = encoder.encode(entry.name);
      if (used + SIZE.dirent > (bufLen as number)) {
        used = bufLen as number;
        break;
      }
      let ino = 0n;
      try {
        ino = BigInt(fs.lstatSync(`${descriptor.hostPath === '/' ? '' : descriptor.hostPath}/${entry.name}`).ino ?? 0);
      } catch {
        // An entry that went away between the listing and its stat is listed as it was.
      }
      const at = (bufPtr as number) + used;
      memory.setU64(at, BigInt(index + 1));
      memory.setU64(at + 8, ino);
      memory.setU32(at + 16, name.length);
      memory.setU8(at + 20, entry.isSymbolicLink() ? FILETYPE.SYMBOLIC_LINK : entry.isDirectory() ? FILETYPE.DIRECTORY : entry.isFile() ? FILETYPE.REGULAR_FILE : FILETYPE.UNKNOWN);
      used += SIZE.dirent;
      const room = (bufLen as number) - used;
      const copied = Math.min(room, name.length);
      memory.bytes.set(name.subarray(0, copied), (bufPtr as number) + used);
      used += copied;
      if ((bufLen as number) - used === 0) break;
    }
    memory.setU32(bufusedPtr as number, used);
  });

  define('fd_renumber', 'ii', (state, _memory, from, to) => {
    if (from === to) return;
    const source = state.table.get(from as number);
    const target = state.table.get(to as number);
    if (source === undefined || target === undefined) return ERRNO.EBADF;
    if (target.kind === 'file') fs.closeSync(target.fd!);
    state.table.set(to as number, source);
    state.table.delete(from as number);
  });

  define('fd_seek', 'iLii', (state, memory, fd, offset, whence, newOffsetPtr) => {
    if (!memory.fits(newOffsetPtr as number, 8)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.FD_SEEK);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind !== 'file') return ERRNO.ESPIPE;
    const delta = Number(BigInt.asIntN(64, offset as bigint));
    let base: number;
    switch (whence) {
      case WHENCE.SET: base = 0; break;
      case WHENCE.CUR: base = descriptor.position; break;
      case WHENCE.END: base = sizeOf(descriptor); break;
      default: return ERRNO.EINVAL;
    }
    const next = base + delta;
    if (next < 0) return ERRNO.EINVAL;
    descriptor.position = next;
    memory.setU64(newOffsetPtr as number, BigInt(next));
  });

  define('fd_sync', 'i', (state, _memory, fd) => {
    const descriptor = lookup(state, fd as number, RIGHT.FD_SYNC);
    if (typeof descriptor === 'number') return descriptor;
  });

  define('fd_tell', 'ii', (state, memory, fd, offsetPtr) => {
    if (!memory.fits(offsetPtr as number, 8)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.FD_TELL);
    if (typeof descriptor === 'number') return descriptor;
    if (descriptor.kind !== 'file') return ERRNO.ESPIPE;
    memory.setU64(offsetPtr as number, BigInt(descriptor.position));
  });

  define('fd_write', 'iiii', (state, memory, fd, iovsPtr, iovsLen, nwrittenPtr) => {
    if (!memory.fits(nwrittenPtr as number, 4)) return ERRNO.EOVERFLOW;
    const iovs = iovecsOf(memory, iovsPtr as number, iovsLen as number);
    if (typeof iovs === 'number') return iovs;
    const descriptor = lookup(state, fd as number, RIGHT.FD_WRITE);
    if (typeof descriptor === 'number') return descriptor;
    let total = 0;
    if (descriptor.kind === 'stream') {
      if (descriptor.stream === 'stdin') return ERRNO.EBADF;
      for (const [ptr, len] of iovs) {
        writeStream(descriptor, memory.bytesAt(ptr, len));
        total += len;
      }
    } else if (descriptor.kind === 'file') {
      for (const [ptr, len] of iovs) {
        // O_APPEND: every write lands at the end, and the cursor follows it.
        const at = descriptor.fdflags & FDFLAG.APPEND ? sizeOf(descriptor) : descriptor.position;
        const count = fs.writeSync(descriptor.fd!, memory.bytes.subarray(ptr, ptr + len), 0, len, at);
        descriptor.position = at + count;
        total += count;
      }
    } else {
      return ERRNO.EISDIR;
    }
    memory.setU32(nwrittenPtr as number, total);
  });

  define('path_create_directory', 'iii', (state, memory, fd, pathPtr, pathLen) => {
    if (!memory.fits(pathPtr as number, pathLen as number)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.PATH_CREATE_DIRECTORY);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(pathPtr as number, pathLen as number), 0);
    if (typeof resolved === 'number') return resolved;
    if (fs.existsSync(resolved.host)) return ERRNO.EEXIST;
    const parent = dirnameOf(resolved.host);
    if (!fs.existsSync(parent)) return ERRNO.ENOENT;
    if (!fs.statSync(parent).isDirectory()) return ERRNO.ENOTDIR;
    fs.mkdirSync(resolved.host);
  });

  define('path_filestat_get', 'iiiii', (state, memory, fd, flags, pathPtr, pathLen, bufPtr) => {
    if (!memory.fits(pathPtr as number, pathLen as number) || !memory.fits(bufPtr as number, SIZE.filestat)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.PATH_FILESTAT_GET);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(pathPtr as number, pathLen as number), flags as number);
    if (typeof resolved === 'number') return resolved;
    memory.writeFilestat(bufPtr as number, filestatOf(fs.lstatSync(resolved.host)));
  });

  define('path_filestat_set_times', 'iiiiLLi', (state, memory, fd, flags, pathPtr, pathLen, atim, mtim, fstFlags) => {
    if (!memory.fits(pathPtr as number, pathLen as number)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.PATH_FILESTAT_SET_TIMES);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(pathPtr as number, pathLen as number), flags as number);
    if (typeof resolved === 'number') return resolved;
    const [atime, mtime] = timesToSet(null, resolved.host, atim as bigint, mtim as bigint, fstFlags as number);
    return setTimes(resolved.host, atime, mtime);
  });

  define('path_link', 'iiiiiii', (state, memory, oldFd, _oldFlags, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) => {
    if (!memory.fits(oldPathPtr as number, oldPathLen as number) || !memory.fits(newPathPtr as number, newPathLen as number)) return ERRNO.EOVERFLOW;
    const source = lookup(state, oldFd as number, RIGHT.PATH_LINK_SOURCE);
    if (typeof source === 'number') return source;
    const target = lookup(state, newFd as number, RIGHT.PATH_LINK_TARGET);
    if (typeof target === 'number') return target;
    // The engine's tree keeps no hard links (its fs.link refuses every call).
    return ERRNO.ENOSYS;
  });

  define('path_open', 'iiiiiLLii', (state, memory, dirFd, dirFlags, pathPtr, pathLen, oFlags, rightsBase, rightsInheriting, fdFlags, fdPtr) => {
    if (!memory.fits(pathPtr as number, pathLen as number) || !memory.fits(fdPtr as number, 4)) return ERRNO.EOVERFLOW;
    const wanted = rightsBase as bigint;
    const read = (wanted & (RIGHT.FD_READ | RIGHT.FD_READDIR)) !== 0n;
    const write = (wanted & (RIGHT.FD_DATASYNC | RIGHT.FD_WRITE | RIGHT.FD_ALLOCATE | RIGHT.FD_FILESTAT_SET_SIZE)) !== 0n;
    let flags = write ? (read ? O_RDWR : O_WRONLY) : O_RDONLY;
    let neededBase = RIGHT.PATH_OPEN;
    let neededInheriting = wanted | (rightsInheriting as bigint);
    if ((oFlags as number) & OFLAG.CREAT) { flags |= O_CREAT; neededBase |= RIGHT.PATH_CREATE_FILE; }
    if ((oFlags as number) & OFLAG.EXCL) flags |= O_EXCL;
    if ((oFlags as number) & OFLAG.TRUNC) { flags |= O_TRUNC; neededBase |= RIGHT.PATH_FILESTAT_SET_SIZE; }
    if ((fdFlags as number) & FDFLAG.APPEND) flags |= O_APPEND;
    if ((fdFlags as number) & FDFLAG.DSYNC) neededInheriting |= RIGHT.FD_DATASYNC;
    if ((fdFlags as number) & (FDFLAG.RSYNC | FDFLAG.SYNC)) neededInheriting |= RIGHT.FD_SYNC;
    if (write && (flags & (O_APPEND | O_TRUNC)) === 0) neededInheriting |= RIGHT.FD_SEEK;
    const descriptor = lookup(state, dirFd as number, neededBase, neededInheriting);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(pathPtr as number, pathLen as number), dirFlags as number);
    if (typeof resolved === 'number') return resolved;
    // A directory is opened as one: the engine has no descriptor for a
    // directory, and a guest asks a directory descriptor only for what its
    // path serves.
    const exists = fs.existsSync(resolved.host);
    if (exists && fs.statSync(resolved.host).isDirectory()) {
      if (write || flags & O_TRUNC) return ERRNO.EISDIR;
      if (flags & O_EXCL) return ERRNO.EEXIST;
      const [maxBase, maxInheriting] = rightsFor(FILETYPE.DIRECTORY, flags);
      const fd = insert(state.table, {
        kind: 'dir',
        path: resolved.guest,
        hostPath: resolved.host,
        type: FILETYPE.DIRECTORY,
        rightsBase: wanted & maxBase,
        rightsInheriting: (rightsInheriting as bigint) & maxInheriting,
        preopen: false,
        fdflags: fdFlags as number,
        position: 0,
      });
      memory.setU32(fdPtr as number, fd);
      return;
    }
    if ((oFlags as number) & OFLAG.DIRECTORY) return exists ? ERRNO.ENOTDIR : ERRNO.ENOENT;
    const hostFd = fs.openSync(resolved.host, flags, 0o666);
    let opened: Descriptor;
    try {
      opened = fileDescriptor(hostFd, resolved.guest, resolved.host, flags, fdFlags as number);
    } catch (error) {
      fs.closeSync(hostFd);
      throw error;
    }
    opened.rightsBase = wanted & opened.rightsBase;
    opened.rightsInheriting = (rightsInheriting as bigint) & opened.rightsInheriting;
    memory.setU32(fdPtr as number, insert(state.table, opened));
  });

  define('path_readlink', 'iiiiii', (state, memory, fd, pathPtr, pathLen, bufPtr, bufLen, bufusedPtr) => {
    if (!memory.fits(pathPtr as number, pathLen as number) || !memory.fits(bufPtr as number, bufLen as number) || !memory.fits(bufusedPtr as number, 4)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.PATH_READLINK);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(pathPtr as number, pathLen as number), 0);
    if (typeof resolved === 'number') return resolved;
    if (typeof fs.readlinkSync !== 'function') return ERRNO.ENOSYS;
    const target = encoder.encode(fs.readlinkSync(resolved.host));
    if (target.length >= (bufLen as number)) return ERRNO.ENOBUFS;
    memory.bytes.set(target, bufPtr as number);
    memory.setU32(bufusedPtr as number, target.length);
  });

  define('path_remove_directory', 'iii', (state, memory, fd, pathPtr, pathLen) => {
    if (!memory.fits(pathPtr as number, pathLen as number)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.PATH_REMOVE_DIRECTORY);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(pathPtr as number, pathLen as number), 0);
    if (typeof resolved === 'number') return resolved;
    if (!fs.existsSync(resolved.host)) return ERRNO.ENOENT;
    if (!fs.statSync(resolved.host).isDirectory()) return ERRNO.ENOTDIR;
    if (fs.readdirSync(resolved.host, { withFileTypes: true }).length > 0) return ERRNO.ENOTEMPTY;
    fs.rmdirSync(resolved.host);
  });

  define('path_rename', 'iiiiii', (state, memory, oldFd, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) => {
    if (!memory.fits(oldPathPtr as number, oldPathLen as number) || !memory.fits(newPathPtr as number, newPathLen as number)) return ERRNO.EOVERFLOW;
    const source = lookup(state, oldFd as number, RIGHT.PATH_RENAME_SOURCE);
    if (typeof source === 'number') return source;
    const target = lookup(state, newFd as number, RIGHT.PATH_RENAME_TARGET);
    if (typeof target === 'number') return target;
    const from = resolve(source, memory.text(oldPathPtr as number, oldPathLen as number), 0);
    if (typeof from === 'number') return from;
    const to = resolve(target, memory.text(newPathPtr as number, newPathLen as number), 0);
    if (typeof to === 'number') return to;
    fs.renameSync(from.host, to.host);
  });

  define('path_symlink', 'iiiii', (state, memory, oldPathPtr, oldPathLen, fd, newPathPtr, newPathLen) => {
    if (!memory.fits(oldPathPtr as number, oldPathLen as number) || !memory.fits(newPathPtr as number, newPathLen as number)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.PATH_SYMLINK);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(newPathPtr as number, newPathLen as number), 0);
    if (typeof resolved === 'number') return resolved;
    if (typeof fs.symlinkSync !== 'function') return ERRNO.ENOSYS;
    fs.symlinkSync(memory.text(oldPathPtr as number, oldPathLen as number), resolved.host);
  });

  define('path_unlink_file', 'iii', (state, memory, fd, pathPtr, pathLen) => {
    if (!memory.fits(pathPtr as number, pathLen as number)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.PATH_UNLINK_FILE);
    if (typeof descriptor === 'number') return descriptor;
    const resolved = resolve(descriptor, memory.text(pathPtr as number, pathLen as number), 0);
    if (typeof resolved === 'number') return resolved;
    if (!fs.existsSync(resolved.host)) return ERRNO.ENOENT;
    if (fs.lstatSync(resolved.host).isDirectory()) return ERRNO.EISDIR;
    fs.unlinkSync(resolved.host);
  });

  define('poll_oneoff', 'iiii', (state, memory, inPtr, outPtr, nsubscriptions, neventsPtr) => {
    if (!memory.fits(inPtr as number, (nsubscriptions as number) * SIZE.subscription) || !memory.fits(outPtr as number, (nsubscriptions as number) * SIZE.event) || !memory.fits(neventsPtr as number, 4)) return ERRNO.EOVERFLOW;
    if ((nsubscriptions as number) === 0) return ERRNO.EINVAL;
    let timeout: bigint | undefined;
    let timerUserdata = 0n;
    const ready: Array<{ userdata: bigint; error: number; type: number; hangup: boolean }> = [];
    for (let index = 0; index < (nsubscriptions as number); index += 1) {
      const at = (inPtr as number) + index * SIZE.subscription;
      const userdata = memory.u64(at);
      const type = memory.u8(at + 8);
      if (type === EVENTTYPE.CLOCK) {
        const clockTimeout = memory.u64(at + 24);
        const flags = memory.u16(at + 40);
        const relative = flags === SUBSCRIPTION_CLOCK_ABSTIME ? clockTimeout - realtimeNanos() : clockTimeout;
        if (timeout === undefined || relative < timeout) {
          timeout = relative;
          timerUserdata = userdata;
        }
      } else if (type === EVENTTYPE.FD_READ || type === EVENTTYPE.FD_WRITE) {
        const descriptor = lookup(state, memory.u32(at + 16), RIGHT.POLL_FD_READWRITE);
        if (typeof descriptor === 'number') {
          ready.push({ userdata, error: descriptor, type, hangup: false });
          continue;
        }
        // The engine's files and directories never block; its stdout and
        // stderr always take a write; its stdin is readable when its stream
        // has yielded bytes and hung up when it has nothing more to give.
        if (descriptor.kind !== 'stream') ready.push({ userdata, error: 0, type, hangup: false });
        else if (descriptor.stream !== 'stdin') { if (type === EVENTTYPE.FD_WRITE) ready.push({ userdata, error: 0, type, hangup: false }); }
        else if (type === EVENTTYPE.FD_READ) {
          if (state.stdinPending.length === 0 && !state.stdinEnded) readStdin(state, new Uint8Array(0));
          ready.push({ userdata, error: 0, type, hangup: state.stdinPending.length === 0 });
        }
      } else {
        return ERRNO.EINVAL;
      }
    }
    let nevents = 0;
    if (ready.length === 0) {
      if (timeout !== undefined) sleepNanos(timeout);
      memory.setU64(outPtr as number, timerUserdata);
      memory.setU16((outPtr as number) + 8, ERRNO.ESUCCESS);
      memory.setU8((outPtr as number) + 10, EVENTTYPE.CLOCK);
      nevents = 1;
    } else {
      for (const event of ready) {
        const at = (outPtr as number) + nevents * SIZE.event;
        memory.setU64(at, event.userdata);
        memory.setU16(at + 8, event.error);
        memory.setU8(at + 10, event.type);
        memory.setU64(at + 16, 0n);
        memory.setU16(at + 24, event.hangup ? EVENT_FD_READWRITE_HANGUP : 0);
        nevents += 1;
      }
    }
    memory.setU32(neventsPtr as number, nevents);
  });

  define('proc_exit', 'i', (_state, _memory, code) => {
    // uvwasi's proc_exit ends the process there and then; the guest's
    // process.exit is that door here. Node's lib replaces this syscall when
    // the caller asked for the exit code back (returnOnExit).
    process.exit(code as number);
  });

  define('proc_raise', 'i', (_state, _memory, signal) => {
    const name = SIGNAL_NAMES[signal as number];
    if (name === undefined) return ERRNO.ENOSYS;
    try {
      process.kill(process.pid, name);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ERR_UNKNOWN_SIGNAL') return ERRNO.ENOSYS;
      throw error;
    }
  });

  define('random_get', 'ii', (_state, memory, bufPtr, bufLen) => {
    if (!memory.fits(bufPtr as number, bufLen as number)) return ERRNO.EOVERFLOW;
    const target = memory.bytes.subarray(bufPtr as number, (bufPtr as number) + (bufLen as number));
    // getRandomValues fills at most 65536 bytes per call, and never a shared buffer.
    for (let at = 0; at < target.length; at += 65536) {
      const chunk = target.subarray(at, Math.min(at + 65536, target.length));
      if (memory.shared) chunk.set(crypto.getRandomValues(new Uint8Array(chunk.length)));
      else crypto.getRandomValues(chunk);
    }
  });

  define('sched_yield', '', () => {});

  // Sockets: the engine's guests have no WASI sockets, so a descriptor that is
  // there and has the right is not a socket, as uvwasi answers a plain file.
  define('sock_accept', 'iii', (state, memory, fd, _flags, fdPtr) => {
    if (!memory.fits(fdPtr as number, 4)) return ERRNO.EOVERFLOW;
    const descriptor = lookup(state, fd as number, RIGHT.SOCK_ACCEPT);
    if (typeof descriptor === 'number') return descriptor;
    return ERRNO.ENOTSOCK;
  });

  define('sock_recv', 'iiiiii', (state, memory, fd, riDataPtr, riDataLen, _riFlags, roDataLenPtr, roFlagsPtr) => {
    if (!memory.fits(roDataLenPtr as number, 4) || !memory.fits(roFlagsPtr as number, 4)) return ERRNO.EOVERFLOW;
    const iovs = iovecsOf(memory, riDataPtr as number, riDataLen as number);
    if (typeof iovs === 'number') return iovs;
    const descriptor = lookup(state, fd as number, RIGHT.FD_READ);
    if (typeof descriptor === 'number') return descriptor;
    return ERRNO.ENOTSOCK;
  });

  define('sock_send', 'iiiii', (state, memory, fd, siDataPtr, siDataLen, _siFlags, soDataLenPtr) => {
    if (!memory.fits(soDataLenPtr as number, 4)) return ERRNO.EOVERFLOW;
    const iovs = iovecsOf(memory, siDataPtr as number, siDataLen as number);
    if (typeof iovs === 'number') return iovs;
    const descriptor = lookup(state, fd as number, RIGHT.FD_WRITE);
    if (typeof descriptor === 'number') return descriptor;
    return ERRNO.ENOTSOCK;
  });

  define('sock_shutdown', 'ii', (state, _memory, fd, _how) => {
    const descriptor = lookup(state, fd as number, RIGHT.SOCK_SHUTDOWN);
    if (typeof descriptor === 'number') return descriptor;
    return ERRNO.ENOTSOCK;
  });

  return WASI as unknown as BindingClass;
}

// ---------------------------------------------------------------------------
// primordials — the seven names wasi.js destructures, written literally over
// the built-ins, captured at module load as Node captures its own.
// ---------------------------------------------------------------------------

const uncurry = <A extends unknown[], R>(fn: (...args: A) => R) =>
  Function.prototype.call.bind(fn) as unknown as (self: unknown, ...args: A) => R;

const primordials = {
  ArrayPrototypeForEach: uncurry(Array.prototype.forEach),
  ArrayPrototypeMap: uncurry(Array.prototype.map),
  ArrayPrototypePush: uncurry(Array.prototype.push),
  FunctionPrototypeBind: uncurry(Function.prototype.bind),
  ObjectEntries: Object.entries,
  String,
  Symbol,
};

// ---------------------------------------------------------------------------
// The one evaluation of Node's file, per guest: its binding is the guest's fs
// and process, so `require('wasi')` in two programs answers two modules.
// ---------------------------------------------------------------------------

/** The `wasi` module as Node's `lib/wasi.js` exports it. */
export interface WasiModule {
  WASI: new (options?: unknown) => {
    wasiImport: Record<string, unknown>;
    start(instance: unknown): number;
    initialize(instance: unknown): void;
    getImportObject(): Record<string, Record<string, unknown>>;
  };
}

const experimentalWarnings = new WeakMap<WasiHostProcess, Set<string>>();

export function createWasiModule(fs: WasiHostFs, process: WasiHostProcess): WasiModule {
  const binding = { WASI: bindingClassFor(fs, process) };
  // internal/util's emitExperimentalWarning: once per feature per process.
  const emitExperimentalWarning = (feature: string): void => {
    let warned = experimentalWarnings.get(process);
    if (warned === undefined) experimentalWarnings.set(process, (warned = new Set()));
    if (warned.has(feature)) return;
    warned.add(feature);
    process.emitWarning(`${feature} is an experimental feature and might change at any time`, 'ExperimentalWarning');
  };
  const nodeInternalRequire = (specifier: string): unknown => {
    switch (specifier) {
      case 'internal/errors':
        return { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_WASI_ALREADY_STARTED } };
      case 'internal/util':
        return { emitExperimentalWarning, kEmptyObject: Object.freeze(Object.create(null)) };
      case 'internal/validators':
        return { validateArray, validateBoolean, validateFunction, validateInt32, validateObject, validateString, validateUndefined };
      default:
        throw new Error(`node-lib/wasi.js asked for an internal the binding does not provide: ${specifier}`);
    }
  };
  const internalBinding = (name: string): unknown => {
    if (name === 'wasi') return binding;
    throw new Error(`node-lib/wasi.js asked for a binding the engine does not provide: ${name}`);
  };
  const module: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('primordials', 'require', 'internalBinding', 'module', 'exports', NODE_WASI_SOURCE)(
    primordials,
    nodeInternalRequire,
    internalBinding,
    module,
    module.exports,
  );
  return module.exports as WasiModule;
}
