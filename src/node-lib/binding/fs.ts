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
import { registerHandle, releaseHandle, refHandle, unrefHandle, handleHasRef, currentOwner, ownedRun, ownerOfInstance } from './handles';
import { __runFor, type ProcessToken } from '../../process-tokens';
import { kStdinRing, type StdinRingReader } from '../../stdin-ring';
// The guest stdin stream's engine-side read (shims/process.ts `kEngineStdinRead`),
// named here so this binding does not import the process shim.
const kEngineStdinRead = Symbol.for('tabnode.stdin.engineRead');
import { allocateFd, handleForFd } from './fds';
import { treeDescriptorsOf, type TreeDescriptors, type TreeDescriptorStats } from '../../tree-descriptors';
import { LibuvStreamWrap, WriteWrap } from './stream_wrap';
import { errname, UV_ENOENT } from './uv';

/**
 * An errno error, as the filesystem makes one. The tree's own maker knows the
 * codes it raises; a descriptor code is this file's to raise, so it is made
 * the same shape here rather than widened there.
 */
function createNodeError(code: string, syscall: string, path: string): Error {
  const known = ['EEXIST', 'EINVAL', 'EISDIR', 'ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'ELOOP', 'EROFS'];
  if (known.includes(code)) return vfsError(code as 'ENOENT', syscall, path);
  // Linux's numbers for the stream errors a descriptor answers.
  const errno = ({ EAGAIN: -11, ESPIPE: -29, EPIPE: -32 } as Record<string, number>)[code] ?? -9;
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path, errno });
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
function flagBits(): { create: number; excl: number; truncate: number; append: number; nonblock: number } {
  const fs = (constantsBinding as unknown as { fs?: Record<string, number> }).fs ?? {};
  return {
    create: fs.O_CREAT ?? 0o100,
    excl: fs.O_EXCL ?? 0o200,
    truncate: fs.O_TRUNC ?? 0o1000,
    append: fs.O_APPEND ?? 0o2000,
    nonblock: fs.O_NONBLOCK ?? 0o4000,
  };
}

/** The file-type bits a `mode` carries, which is how `Stats` answers `isFile()`. */
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;
const S_IFBLK = 0o060000;
const S_IFSOCK = 0o140000;
const S_IFMT = 0o170000;

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
  /** The buffer `cached` views when writes have grown it a piece at a time. */
  room?: Uint8Array;
}

/** Every descriptor this engine has open, and the next number to hand out. */
const openFiles = new Map<number, OpenFile>();

/**
 * fd 0, 1 and 2 are descriptors of every process, as on Linux: a program
 * that writes its output through `fs.writeSync(1, buf)`, or opens
 * `/dev/stdout`, `/dev/fd/1` or `/proc/self/fd/1` and writes there, writes
 * the bytes its `process.stdout` writes, to the same place and in the same
 * order; one that reads `fs.readSync(0, buf)` or `/dev/stdin` reads what its
 * `process.stdin` reads; `fstat` of each says what it is. The engine
 * registered no such descriptors, so all of it was EBADF. A path of these
 * opens a new descriptor that names the stream, as open(2) on it does.
 */
type StdioFd = 0 | 1 | 2;
const STDIO_PATHS = new Map<string, StdioFd>([
  ['/dev/stdin', 0], ['/dev/stdout', 1], ['/dev/stderr', 2],
  ['/dev/fd/0', 0], ['/dev/fd/1', 1], ['/dev/fd/2', 2],
  ['/proc/self/fd/0', 0], ['/proc/self/fd/1', 1], ['/proc/self/fd/2', 2],
]);
const stdioAliases = new Map<number, StdioFd>();
/** Descriptors on a standard stream that were opened O_NONBLOCK: a read with nothing there is EAGAIN. */
const nonblockingAliases = new Set<number>();

/** The standard stream a descriptor names, where it names one. */
function stdioOf(fd: number): StdioFd | null {
  const alias = stdioAliases.get(fd);
  if (alias !== undefined) return alias;
  return (fd === 0 || fd === 1 || fd === 2) && !openFiles.has(fd) && !ownedFds.has(fd) ? fd : null;
}

/**
 * The standard stream a path names. Besides the fixed names above, Linux's procfs has every process's descriptors
 * under its number: `/proc/<pid>/fd/N` of the process's own pid is `/proc/self/fd/N`. And `/proc/1/fd/1` and
 * `/proc/1/fd/2` are how a program in a container writes to the container's log from wherever it is (pid 1 is the
 * container's first process, and its output is the log): a logger given that path as its file, `fs.appendFileSync`
 * of it from a child whose own output is piped. A process here is given its own standard stream for pid 1's: its
 * output and the first process's go to the same place. It was ENOENT or, over a kernel's tree, EBADF at the write.
 * Where it differs from Linux: a process whose own stream is not the first process's (its stdout redirected to a
 * file by its parent) writes pid 1's path to its own; no other process's descriptor is opened by a path.
 */
function stdioPath(name: string): StdioFd | undefined {
  const fixed = STDIO_PATHS.get(name);
  if (fixed !== undefined) return fixed;
  const match = /^\/proc\/(\d+)\/fd\/([012])$/.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]), own = (stdioProcess() as { pid?: unknown } | undefined)?.pid;
  return pid === 1 || pid === own ? Number(match[2]) as StdioFd : undefined;
}

/** Where a run's process carries what each of its fds 0, 1 and 2 is: 'tty', 'pipe', 'file' or 'char'. */
export const kStdioKinds = Symbol.for('tabnode.run.stdioKinds');

/** What a run's standard streams are, as the fs binding reads them. */
interface StdioStreams {
  stdin?: { isTTY?: boolean; read(size?: number): unknown; [kEngineStdinRead]?: (size?: number) => unknown; unshift(chunk: Uint8Array): void; readableEnded?: boolean; readableLength?: number; _readableState?: { ended?: boolean } };
  stdout?: { isTTY?: boolean };
  stderr?: { isTTY?: boolean };
}

/** A read of the guest's stdin by the engine, not counted as the program reading its stream. */
function engineRead(stdin: NonNullable<StdioStreams['stdin']>, size?: number): unknown {
  const own = stdin[kEngineStdinRead];
  return typeof own === 'function' ? own.call(stdin, size) : stdin.read(size);
}

/** The asking run's process -- its own, not whichever guest holds the realm's name. */
function stdioProcess(token: ProcessToken | null = currentOwner()): StdioStreams | undefined {
  const run = token === null ? undefined : __runFor(token);
  if (run) return run.process as unknown as StdioStreams;
  return (globalThis as unknown as { process?: StdioStreams }).process;
}

/**
 * A read of fd 0 for a run whose stdin is a shared ring written from another
 * thread, as Linux reads a blocking pipe: the bytes the guest's stream
 * already holds first (taken without asking the stream for more, which would
 * start its drain from the ring: `fs.readSync(0)` never touches
 * process.stdin in Node), then the ring's next ones, waiting for them, or 0
 * at its end. An O_NONBLOCK descriptor gets EAGAIN instead of a wait.
 */
function readStdinRing(fd: number, stdin: NonNullable<StdioStreams['stdin']>, ring: StdinRingReader, buffer: Uint8Array, offset: number, length: number): number {
  const buffered = stdin.readableLength ?? 0;
  if (buffered > 0) {
    const chunk = engineRead(stdin, Math.min(length, buffered));
    if (chunk !== null && chunk !== undefined) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk as Uint8Array;
      const count = Math.min(length, bytes.length);
      buffer.set(bytes.subarray(0, count), offset);
      if (count < bytes.length) stdin.unshift(bytes.slice(count));
      return count;
    }
  }
  if (stdin.readableEnded === true || stdin._readableState?.ended === true) return 0;
  if (nonblockingAliases.has(fd)) {
    const taken = ring.take(buffer, offset, length);
    if (taken === null) throw createNodeError('EAGAIN', 'read', String(fd));
    return taken;
  }
  try { return ring.takeBlocking(buffer, offset, length); } catch (cause) {
    throw Object.assign(new Error(
      `read(${fd}): this realm refuses to block (${cause instanceof Error ? cause.message : String(cause)}), `
      + 'as a page\'s main thread does, so a blocking read of stdin cannot wait here. Run the program in a worker.'), {
      code: 'ERR_STDIN_BLOCKING_READ', syscall: 'read', fd,
    });
  }
}

/**
 * `fstat` of a standard stream, as Linux answers it for what the run was
 * given on that fd (`stdioKind`, else its terminals): a terminal is a
 * character device (a pts, major 136), a file a regular file, anything else
 * a pipe. A file's size is not one the run supplies, and is 0.
 */
function stdioStat(stream: StdioFd, bigint: boolean): Float64Array | BigInt64Array {
  const proc = stdioProcess();
  const kinds = (proc as Record<symbol, unknown> | undefined)?.[kStdioKinds] as readonly string[] | undefined;
  const tty = (stream === 0 ? proc?.stdin : stream === 1 ? proc?.stdout : proc?.stderr)?.isTTY === true;
  const kind = kinds?.[stream] ?? (tty ? 'tty' : 'pipe');
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = Math.floor((now % 1000) * 1e6);
  // A character device that is not a terminal is /dev/null's shape: 0666, device 1,3.
  const mode = kind === 'tty' ? S_IFCHR | 0o620 : kind === 'char' ? S_IFCHR | 0o666
    : kind === 'file' ? S_IFREG | 0o644 : S_IFIFO | 0o600;
  const values = [
    0, mode, 1,
    0, 0, kind === 'tty' ? 136 << 8 : kind === 'char' ? (1 << 8) | 3 : 0,
    4096, stream + 1, 0, 0,
    seconds, nanos, seconds, nanos, seconds, nanos, seconds, nanos,
  ];
  return bigint ? BigInt64Array.from(values, (value) => BigInt(value)) : Float64Array.from(values);
}

/**
 * A read of the run's fd 0: the bytes its `process.stdin` holds, taken from
 * that same stream so the two read in order, the rest left for the next
 * read; at the writer's end, 0. That covers every stdin a run is given
 * whole (`stdin`, a `<` file, a pipe whose writer finished first).
 *
 * With nothing there and the writer still open, Linux blocks a blocking fd
 * and answers EAGAIN on an O_NONBLOCK one. The second is answered. The
 * first cannot be, in this realm: every byte a run's stdin can still
 * receive arrives through this realm's own loop (a host's `stdinStream`, its
 * `sendInput`, a parent guest's pipe write), and a thread blocked in this
 * read would hold that loop and never receive it -- a wait here is a
 * deadlock, not a slow read. A run given a shared ring (`stdin-ring.ts`)
 * is written from another thread, and its read waits on the ring. Any other
 * run's is refused by name rather than with an EAGAIN the program did not
 * ask for.
 */
function readStdin(fd: number, buffer: Uint8Array, offset: number, length: number): number {
  const stdin = stdioProcess()?.stdin;
  if (!stdin || typeof stdin.read !== 'function') throw createNodeError('EBADF', 'read', '0');
  if (length <= 0) return 0;
  const ring = (stdioProcess() as Record<symbol, unknown> | undefined)?.[kStdinRing] as StdinRingReader | undefined;
  if (ring) return readStdinRing(fd, stdin, ring, buffer, offset, length);
  const chunk = engineRead(stdin);
  if (chunk === null || chunk === undefined) {
    if (stdin.readableEnded === true || stdin._readableState?.ended === true) return 0;
    if (nonblockingAliases.has(fd)) throw createNodeError('EAGAIN', 'read', String(fd));
    throw Object.assign(new Error(
      `read(${fd}): this run's stdin is still open and holds no bytes yet, and a blocking read cannot wait for them: `
      + 'they arrive on this realm\'s own event loop, which a blocked read would hold. Read it asynchronously '
      + '(process.stdin), give the run its whole stdin before it starts, or give it a shared ring (stdinShared).'), {
      code: 'ERR_STDIN_BLOCKING_READ', syscall: 'read', fd,
    });
  }
  const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk as Uint8Array;
  const count = Math.min(length, bytes.length);
  buffer.set(bytes.subarray(0, count), offset);
  if (count < bytes.length) stdin.unshift(bytes.slice(count));
  return count;
}

/**
 * Bytes on the asking run's fd 1 or 2: the run's own stream sink, which is
 * what its `process.stdout`/`stderr` writes into -- not a guest's replacement
 * of `process.stdout.write`, which a write to the descriptor never calls.
 */
function writeStdio(stream: 1 | 2, bytes: Uint8Array, token: ProcessToken | null = currentOwner()): void {
  const run = token === null ? undefined : __runFor(token);
  if (run) { (stream === 1 ? run.stdout : run.stderr)(bytes.slice()); return; }
  const realm = (globalThis as unknown as { process?: { stdout?: { write(chunk: Uint8Array): unknown }; stderr?: { write(chunk: Uint8Array): unknown } } }).process;
  const sink = stream === 1 ? realm?.stdout : realm?.stderr;
  if (!sink || typeof sink.write !== 'function') throw createNodeError('EBADF', 'write', String(stream));
  sink.write(bytes.slice());
}

/**
 * Descriptors a tree owns (`tree-descriptors.ts`): the number is the tree's,
 * and every operation on it is the tree's own call, so its offset, its
 * O_APPEND and its sharing with other processes are the owner's. The engine
 * keeps only which owner answers for the number.
 */
const ownedFds = new Map<number, TreeDescriptors>();

/** The owner of a descriptor a tree opened, where the tree opened it. */
function ownerOf(fd: number): TreeDescriptors | undefined {
  return ownedFds.get(fd);
}

/** A position as the tree takes it: null for the description's own offset. */
function positionOf(position: number | null | undefined): number | null {
  return position === null || position === undefined || position < 0 ? null : position;
}

function fileFor(fd: number): OpenFile {
  const file = openFiles.get(fd);
  if (!file) throw createNodeError('EBADF', 'read', String(fd));
  return file;
}

/**
 * Where a child's output goes when its stdio names a descriptor of the
 * parent's (`stdio: ['ignore', fd, fd]` with `fd` from `openSync`): the file
 * that descriptor has open, as the child's own duplicate of it, so it keeps
 * writing after the parent closes its copy. Appending descriptors append;
 * others write on from the position the parent's copy had. A descriptor that
 * is a stream (a socket, a pipe) is written as a stream. Anything else is
 * not a sink, and the child's output there goes nowhere, as `ignore` does.
 */
export type DescriptorWriter = ((chunk: string | Uint8Array) => void) & {
  /** The child has ended: its own reference to the description goes (a dup the tree made). */
  release?(): void;
};

export function descriptorWriter(fd: number): DescriptorWriter | null {
  // A descriptor takes bytes; a chunk a child wrote as bytes goes on as them.
  const bytesOf = (chunk: string | Uint8Array): Uint8Array => typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
  // A description a tree owns is written through it: one offset, the
  // owner's, shared with the parent's copy as a dup'd descriptor's is.
  const owner = ownerOf(fd);
  if (owner) {
    // The child's own number for the description, taken now, while the parent's is open: the parent
    // closing (or reusing) its number then changes nothing for the child (fork's copy plus dup2).
    let own: number | undefined;
    try { own = owner.dup?.(fd); } catch { own = undefined; }
    const target = own ?? fd;
    const writer: DescriptorWriter = (chunk) => {
      const bytes = bytesOf(chunk);
      try { owner.write(target, bytes, 0, bytes.length, null); } catch { /* a closed description drops the child's output */ }
    };
    if (own !== undefined) {
      let released = false;
      writer.release = () => {
        if (released) return;
        released = true;
        try { owner.close(own!); } catch { /* the tree has already let it go */ }
      };
    }
    return writer;
  }
  // The parent's own fd 1 or 2 (or a descriptor it opened on /dev/stdout):
  // the child writes the parent's stream, read against the parent, whose
  // code is the code running now.
  const standard = stdioOf(fd);
  if (standard !== null && standard !== 0 && handleForFd(fd) === undefined) {
    const parent = currentOwner();
    return (chunk) => { try { writeStdio(standard, bytesOf(chunk), parent); } catch { /* a closed stream drops the child's output */ } };
  }
  const stream = handleForFd(fd);
  if (stream instanceof LibuvStreamWrap) {
    return (chunk) => { try { stream.writeBuffer(new WriteWrap(), bytesOf(chunk)); } catch { /* a closed stream drops the child's output, as a closed pipe does */ } };
  }
  const file = openFiles.get(fd);
  if (!file || file.directory || (file.flags & 3) === 0) return null;
  const { tree, path } = file;
  const append = (file.flags & flagBits().append) !== 0;
  // One offset per open file, as a dup'd descriptor shares one: a child's
  // stdout and stderr on the same file follow each other, and the parent's
  // own position moves with them while its copy is open.
  let cursor = descriptorCursors.get(file);
  if (!cursor) { cursor = { position: file.position }; descriptorCursors.set(file, cursor); }
  const offset = cursor;
  return (chunk) => {
    const bytes = bytesOf(chunk);
    // the parent's copy, while it is open, holds the file's bytes as it last wrote them
    const shared = openFiles.get(fd) === file ? file : null;
    if (shared) offset.position = shared.position;
    const existing = shared?.cached ?? (tree.existsSync(path) ? tree.readFileSync(path) as Uint8Array : new Uint8Array(0));
    const at = append ? existing.length : offset.position;
    const next = new Uint8Array(Math.max(existing.length, at + bytes.length));
    next.set(existing, 0);
    next.set(bytes, at);
    tree.writeFileSync(path, next);
    offset.position = at + bytes.length;
    if (shared) { shared.cached = next; shared.position = offset.position; }
  };
}
const descriptorCursors = new WeakMap<object, { position: number }>();

/** Node's stat array: eighteen numbers, with each time a second and a nanosecond. */
function statArray(stats: VfsStats | TreeDescriptorStats, bigint: boolean, path?: string): Float64Array | BigInt64Array {
  const mtime = stats.mtime instanceof Date ? stats.mtime.getTime() : Number(stats.mtimeMs ?? 0);
  const atime = stats.atime instanceof Date ? stats.atime.getTime() : Number(stats.atimeMs ?? mtime);
  const ctime = stats.ctime instanceof Date ? stats.ctime.getTime() : Number(stats.ctimeMs ?? mtime);
  const birth = stats.birthtime instanceof Date ? stats.birthtime.getTime() : Number(stats.birthtimeMs ?? mtime);
  const seconds = (ms: number): number => Math.floor(ms / 1000);
  const nanos = (ms: number): number => Math.floor((ms % 1000) * 1e6);
  // `Stats.isFile()` is `mode & S_IFMT`, so the entry's type goes where Node
  // looks: the type bits a tree's mode carries, else every kind its stat
  // answers -- a directory, a link, a character or block device, a FIFO, a
  // socket -- and a regular file only when it is none of them. Deriving only
  // dir/link/reg made a kernel's character device (/dev/null) a regular file
  // through a path stat while fstat of its descriptor said S_IFCHR.
  // `chmod` stores what it set; a path it has not touched keeps the tree's.
  const permissions = Number(stats.mode ?? (stats.isDirectory?.() ? 0o755 : 0o644)) & 0o7777;
  const type = (Number(stats.mode ?? 0) & S_IFMT)
    || (stats.isDirectory?.() ? S_IFDIR : stats.isSymbolicLink?.() ? S_IFLNK
      : stats.isCharacterDevice?.() ? S_IFCHR : stats.isBlockDevice?.() ? S_IFBLK
        : stats.isFIFO?.() ? S_IFIFO : stats.isSocket?.() ? S_IFSOCK : S_IFREG);
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
  // Called as MakeCallback calls it: in the request's owner's run, its throw that run's uncaught exception.
  const owner = ownerOfInstance(request as object);
  onNextTick(() => {
    let value: T;
    try { value = run(); } catch (error) { ownedRun(owner, () => complete.call(request, error as Error), true); return; }
    ownedRun(owner, () => complete.call(request, null, value as unknown), true);
  });
  return undefined;
}

/**
 * A name the binding answers, in the encoding Node handed. `fs.rm` recursive
 * (rimraf) readdir's with encoding `buffer` and `Buffer.concat`s each child
 * onto the path; a string child threw `list[1]`/`list[2]` must be a Buffer,
 * received `'exthost1'`.
 */
export function createFsBindings(Bytes: () => typeof NodeBuffer = () => NodeBuffer) {
function encodeFsName(name: string, encoding: unknown): string | Uint8Array {
  if (encoding !== 'buffer' && encoding !== 6) {
    if (typeof encoding === 'string' && encoding.length > 0 && encoding !== 'utf8' && encoding !== 'utf-8') {
      return (Bytes().from(name) as { toString(enc: string): string }).toString(encoding);
    }
    return name;
  }
  return Bytes().from(name);
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
class FSReqCallback {
  oncomplete: ((error: Error | null, ...rest: unknown[]) => void) | undefined;
  context: unknown;
  constructor(public bigint = false) {}
}

/** The symbol `fs.promises` passes where a callback would go. */


/**
 * `internalBinding('fs_dir')`'s handle: an open directory, read a batch at a
 * time. Node's own `Dir` and `Dirent` are built on it; what a handle owes is
 * a flat list of name and type, and `null` when there is nothing left.
 */
class DirHandle {
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

const fsDirBinding = {
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
class FSEvent {
  onchange: ((status: number, event: string, filename: string | Uint8Array) => void) | null = null;
  #watcher: { close(): void } | null = null;
  initialized = false;

  start(path: unknown, persistent?: boolean, recursive?: boolean, encoding?: string): number {
    const name = asPath(path);
    const tree = vfs();
    const cwd = callingCwd();
    const owner = currentOwner();
    try {
      this.#watcher = tree.watch(name, { recursive: Boolean(recursive) }, ((event: string, filename: string | null) => {
        // libuv names a change `change` and a create or a remove `rename`,
        // which is what Node's `FSWatcher` turns into its own two events.
        const notify = () => withFilesystem(tree, () => withCwd(cwd, () =>
          // libuv encodes the filename at this binding, including Buffer
          // when requested. Node's FSWatcher forwards it without conversion.
          this.onchange?.(0, event === 'rename' ? 'rename' : 'change', encodeFsName(filename ?? '', encoding))));
        ownedRun(owner, notify, true);
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
/** The fields of one stat as the binding passes them (Node's kFsStatsFieldsNumber, 18 in v24.21.0). */
const FS_STATS_FIELDS = 18;
class StatWatcher {
  /** Node's callback: the poll's status (0, or libuv's error for a file that is not there) and ONE array, the new stat's fields then the old one's. */
  onchange: ((status: number, stats: Float64Array | BigInt64Array) => void) | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #previous: Float64Array | BigInt64Array | null = null;
  constructor(public bigint = false) {}

  start(path: unknown, interval = 5007): number {
    const name = asPath(path);
    const tree = vfs();
    let status = 0;
    const read = (): Float64Array | BigInt64Array => {
      try { const values = statArray(tree.statSync(name), this.bigint); status = 0; return values; }
      catch { status = UV_ENOENT; return this.bigint ? new BigInt64Array(FS_STATS_FIELDS) : new Float64Array(FS_STATS_FIELDS); }
    };
    this.#previous = read();
    this.#timer = setInterval(() => {
      const current = read();
      const previous = this.#previous!;
      let changed = false;
      for (let index = 0; index < current.length; index += 1) {
        if (current[index] !== previous[index]) { changed = true; break; }
      }
      if (!changed) return;
      this.#previous = current;
      // lib/internal/fs/watchers.js `onchange(newStatus, stats)` reads the new stat at 0 and the old one at
      // kFsStatsFieldsNumber of the same array. Handed two arrays, it took the old stat for both, so a
      // `fs.watchFile` listener was called with `curr` equal to `prev` and saw no change in either.
      const both = this.bigint ? new BigInt64Array(2 * FS_STATS_FIELDS) : new Float64Array(2 * FS_STATS_FIELDS);
      (both as Float64Array).set(current as Float64Array, 0);
      (both as Float64Array).set(previous as Float64Array, FS_STATS_FIELDS);
      this.onchange?.(status, both);
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

const fsEventWrapBinding = { FSEvent };

/**
 * What `fs.promises.open` is handed: a descriptor with a close of its own.
 * Node's is a C++ handle whose destructor closes the file; here it is the
 * same number this file's table keeps, with the same close.
 */
class FileHandle {
  constructor(public fd: number) {}
  close(): Promise<void> {
    // A description a tree owns is closed by its owner, as `close` does.
    const owner = ownedFds.get(this.fd);
    if (owner) {
      ownedFds.delete(this.fd);
      try { owner.close(this.fd); } catch (error) { return Promise.reject(error); }
      return Promise.resolve();
    }
    openFiles.delete(this.fd);
    return Promise.resolve();
  }
  release(): void { openFiles.delete(this.fd); }
  getAsyncId(): number { return this.fd; }
}

const fsBinding = {
  FSReqCallback,
  kUsePromises,
  StatWatcher,
  kFsStatsFieldsNumber: FS_STATS_FIELDS,

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
      const standard = stdioPath(name);
      if (standard !== undefined) {
        const fd = allocateFd();
        stdioAliases.set(fd, standard);
        if ((flags & flagBits().nonblock) !== 0) nonblockingAliases.add(fd);
        return fd;
      }
      const tree = vfs();
      // A tree that owns its descriptions opens the file itself, flags and
      // mode as given: the rules of open(2) are its own.
      const owner = treeDescriptorsOf(tree);
      if (owner) {
        const fd = owner.open(name, flags, _mode);
        ownedFds.set(fd, owner);
        return fd;
      }
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
      const fd = allocateFd();
      const position = (flags & bits.append) !== 0 && exists ? (tree.readFileSync(name) as Uint8Array).length : 0;
      openFiles.set(fd, { path: name, flags, position, directory: false, tree });
      return fd;
    });
  },

  close(fd: number, req?: FSReq): undefined {
    return answer(req, () => {
      const owner = ownerOf(fd);
      if (owner) { ownedFds.delete(fd); owner.close(fd); return undefined; }
      const stream = handleForFd(fd);
      if (stream instanceof LibuvStreamWrap) { stream.close(); return undefined; }
      if (stdioOf(fd) !== null) { stdioAliases.delete(fd); nonblockingAliases.delete(fd); return undefined; }
      fileFor(fd); openFiles.delete(fd); return undefined;
    });
  },

  // ---- reading ------------------------------------------------------------
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number, req?: FSReq): number | undefined {
    return answer(req, () => {
      const owner = ownerOf(fd);
      if (owner) return owner.read(fd, buffer, offset, length, positionOf(position));
      const standard = handleForFd(fd) === undefined ? stdioOf(fd) : null;
      if (standard !== null) {
        // fd 1 and 2 are the write ends the run was given.
        if (standard !== 0) throw createNodeError('EBADF', 'read', String(fd));
        if (position !== null && position !== undefined && position >= 0) throw createNodeError('ESPIPE', 'read', String(fd));
        return readStdin(fd, buffer, offset, length);
      }
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
      const owner = ownerOf(fd);
      if (owner) {
        // The size is the description's; a file still growing reads to its end.
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (let size = Math.max(owner.fstat(fd).size, 65536); ;) {
          const chunk = new Uint8Array(size);
          const read = owner.read(fd, chunk, 0, chunk.length, null);
          if (read === 0) break;
          chunks.push(chunk.subarray(0, read));
          total += read;
          size = 65536;
        }
        const whole = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) { whole.set(chunk, at); at += chunk.length; }
        return new TextDecoder().decode(whole);
      }
      const file = fileFor(fd);
      const bytes = new Uint8Array(file.tree.statSync(file.path).size);
      const length = fsBinding.read(fd, bytes, 0, bytes.length, -1) as number;
      return new TextDecoder().decode(bytes.subarray(0, length));
    } finally { if (owned) fsBinding.close(fd); }
  },

  // ---- writing ------------------------------------------------------------
  writeBuffer(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, req?: FSReq): number | undefined {
    return answer(req, () => {
      const stream = handleForFd(fd);
      if (stream instanceof LibuvStreamWrap) {
        if (position !== null && position !== undefined && position >= 0) throw createNodeError('ESPIPE', 'write', String(fd));
        const bytes = buffer.subarray(offset, offset + length);
        const status = stream.writeBuffer(new WriteWrap(), bytes);
        if (status !== 0) throw createNodeError(errname(status), 'write', String(fd));
        return bytes.length;
      }
      const owner = ownerOf(fd);
      if (owner) return owner.write(fd, buffer, offset, length, positionOf(position));
      const standard = stdioOf(fd);
      if (standard !== null) {
        // fd 0 is the read end the run was given.
        if (standard === 0) throw createNodeError('EBADF', 'write', String(fd));
        // A stream has no position, as a pipe or a terminal has none.
        if (position !== null && position !== undefined && position >= 0) throw createNodeError('ESPIPE', 'write', String(fd));
        const bytes = buffer.subarray(offset, offset + length);
        writeStdio(standard, bytes);
        return bytes.length;
      }
      const file = fileFor(fd);
      if ((file.flags & 3) === 0) throw createNodeError('EBADF', 'write', file.path);
      const tree = file.tree;
      const slice = buffer.subarray(offset, offset + length);
      // A write at the file's end is an append: the tree is given only the
      // bytes it adds, and this descriptor's copy grows in a buffer with room.
      // Writing the whole file again for each chunk made a 50 MB stream of
      // 1 KB writes copy about a terabyte.
      const held = file.cached?.length ?? (tree.existsSync(file.path) ? tree.statSync(file.path).size : 0);
      const end = (file.flags & flagBits().append) !== 0 ? held
        : position === null || position === undefined || position < 0 ? file.position : position;
      if (end === held && typeof (tree as { appendFileSync?: unknown }).appendFileSync === 'function') {
        (tree as { appendFileSync(path: string, data: Uint8Array): void }).appendFileSync(file.path, slice);
        if (file.cached !== undefined) {
          let room = file.room;
          if (!room || file.cached.buffer !== room.buffer || file.cached.byteOffset !== 0 || room.byteLength < held + slice.length) {
            room = new Uint8Array(Math.max(held + slice.length, held * 2, 4096));
            room.set(file.cached, 0);
          }
          room.set(slice, held);
          file.cached = room.subarray(0, held + slice.length);
          file.room = room;
        }
        if (position === null || position === undefined || position < 0) file.position = end + slice.length;
        return slice.length;
      }
      // A write elsewhere in the file goes where it lands, when the tree takes one: a database's page or log
      // record costs its own bytes, not the file's (Postgres's commits wrote its whole 16 MB log again).
      if (typeof (tree as { writeAtSync?: unknown }).writeAtSync === 'function') {
        const at = position === null || position === undefined || position < 0 ? file.position : position;
        (tree as { writeAtSync(path: string, data: Uint8Array, position: number): void }).writeAtSync(file.path, slice, at);
        // This descriptor's copy takes the same bytes, in a buffer of its own with room, as an append's does: a
        // read after the write is answered from it rather than by reading the whole file again.
        if (file.cached !== undefined && slice.length > 0) {
          const cached = file.cached;
          const length = Math.max(cached.length, at + slice.length);
          let room = file.room;
          if (!room || cached.buffer !== room.buffer || cached.byteOffset !== 0 || room.byteLength < length) {
            room = new Uint8Array(Math.max(length, cached.length * 2, 4096));
            room.set(cached, 0);
          } else if (at > cached.length) {
            room.fill(0, cached.length, at);
          }
          room.set(slice, at);
          file.cached = room.subarray(0, length);
          file.room = room;
        }
        if (position === null || position === undefined || position < 0) file.position = at + slice.length;
        return slice.length;
      }
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
    // The string's bytes in the encoding it was written with, as Node's own
    // Buffer makes them: `writeSync(fd, 'ff', null, 'hex')` is one byte. Every
    // encoding but UTF-8 was taken as latin1, so hex, base64 and utf16le
    // wrote their text's characters instead.
    const bytes = encoding === 'utf8' || encoding === undefined || encoding === 'utf-8'
      ? new TextEncoder().encode(value)
      : new Uint8Array(Bytes().from(value, encoding as BufferEncoding));
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
      try {
        // Native stat does not allocate an Error for an ordinary absent path
        // when its caller asked for absence. Carry that choice to the tree.
        const stats = vfs().statSync(name, { throwIfNoEntry });
        return stats === undefined ? undefined : statArray(stats, bigint, name);
      }
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
      try {
        const stats = vfs().lstatSync(name, { throwIfNoEntry });
        return stats === undefined ? undefined : statArray(stats, bigint, name);
      }
      catch (error) {
        if (throwIfNoEntry === false && (error as { code?: string }).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    return answer(req, work);
  },

  fstat(fd: number, bigint: boolean, req?: FSReq): Float64Array | BigInt64Array | undefined {
    return answer(req, () => {
      const owner = ownerOf(fd);
      if (owner) return statArray(owner.fstat(fd), bigint);
      const standard = handleForFd(fd) === undefined ? stdioOf(fd) : null;
      if (standard !== null) return stdioStat(standard, bigint);
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
    // The order Node's `getStatFsFromBinding` reads (v24.21.0, eight fields): type, bsize, frsize, blocks,
    // bfree, bavail, files, ffree. Seven were handed, without frsize, so every field after bsize was read one
    // place early: frsize as the block count, bavail as the file count, ffree as undefined.
    return answer(req, () => {
      const values = [0, 4096, 4096, 2 ** 31, 2 ** 31, 2 ** 31, 2 ** 20, 2 ** 20];
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
      const stats = vfs().statSync(asPath(name), { throwIfNoEntry: false });
      return stats === undefined ? -2 : stats.isDirectory() ? 1 : 0;
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

  /** Node24 moved synchronous rm out of JS rimraf into this binding. */
  rmSync(path: unknown, maxRetries: number, recursive: boolean, retryDelay: number): undefined {
    const name = asPath(path);
    const tree = vfs();
    const retryable = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
    // The native entry uses status (follows links) before remove/remove_all,
    // whose traversal itself never follows a link. Keep the same distinction.
    const initial = tree.statSync(name, { throwIfNoEntry: false });
    if (!initial) return undefined;
    if (initial.isDirectory() && !recursive) {
      throw Object.assign(createNodeError('EISDIR', 'rm', name), { code: 'ERR_FS_EISDIR' });
    }
    const remove = (target: string): void => {
      const stats = tree.lstatSync(target, { throwIfNoEntry: false });
      if (!stats) return;
      if (!stats.isDirectory()) { tree.unlinkSync(target); return; }
      if (!recursive) throw Object.assign(createNodeError('EISDIR', 'rm', target), { code: 'ERR_FS_EISDIR' });
      for (const entry of tree.readdirSync(target)) remove(`${target.endsWith('/') ? target.slice(0, -1) : target}/${entry}`);
      tree.rmdirSync(target);
    };
    for (let attempt = 0; ; attempt++) {
      try { remove(name); return undefined; }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT') return undefined;
        if (!recursive || !code || !retryable.has(code) || attempt >= maxRetries) {
          if (code && code !== 'ERR_FS_EISDIR') throw createNodeError(code, 'rm', name);
          throw error;
        }
        // The isolated worker can block as Node's synchronous rm does. Only
        // an actual transient filesystem failure needs this wait; no pending
        // timer or fabricated successful deletion substitutes for it.
        if (retryDelay > 0) {
          if (typeof SharedArrayBuffer !== 'function') throw createNodeError('ENOTSUP', 'rm', name);
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * retryDelay); }
          catch { throw createNodeError('ENOTSUP', 'rm', name); }
        }
      }
    }
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
      const owner = ownerOf(fd);
      if (owner) { owner.fchmod(fd, mode); return undefined; }
      const file = fileFor(fd);
      file.tree.chmodSync(file.path, mode);
      return undefined;
    });
  },
  chown(_path: unknown, _uid: number, _gid: number, req?: FSReq): undefined { return answer(req, () => unsupportedMetadata('chown')); },
  fchown(_fd: number, _uid: number, _gid: number, req?: FSReq): undefined { return answer(req, () => unsupportedMetadata('fchown')); },
  lchown(_path: unknown, _uid: number, _gid: number, req?: FSReq): undefined { return answer(req, () => unsupportedMetadata('lchown')); },
  utimes(path: unknown, atime: number, mtime: number, req?: FSReq): undefined { return answer(req, () => { vfs().utimesSync(asPath(path), new Date(atime * 1000), new Date(mtime * 1000)); return undefined; }); },
  futimes(fd: number, atime: number, mtime: number, req?: FSReq): undefined { return answer(req, () => { const owner = ownerOf(fd); if (owner) { owner.futimes(fd, atime, mtime); return undefined; } const file = fileFor(fd); file.tree.utimesSync(file.path, new Date(atime * 1000), new Date(mtime * 1000)); return undefined; }); },
  lutimes(path: unknown, atime: number, mtime: number, req?: FSReq): undefined { return answer(req, () => {
    if (treeHoldsLinks()) return unsupportedMetadata('lutimes');
    vfs().utimesSync(asPath(path), new Date(atime * 1000), new Date(mtime * 1000));
    return undefined;
  }); },
  // The engine's own tree is memory, with nothing to flush; a tree that owns
  // the description flushes it as its fsync(2) does.
  fsync(fd: number, req?: FSReq): undefined { return answer(req, () => { ownerOf(fd)?.fsync(fd); return undefined; }); },
  fdatasync(fd: number, req?: FSReq): undefined { return answer(req, () => { ownerOf(fd)?.fsync(fd); return undefined; }); },

  ftruncate(fd: number, length: number, req?: FSReq): undefined {
    return answer(req, () => {
      const owner = ownerOf(fd);
      if (owner) { owner.ftruncate(fd, length); return undefined; }
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

return { fsBinding, fsDirBinding, fsEventWrapBinding, FSReqCallback, DirHandle, FSEvent, StatWatcher, FileHandle };
}

export const kUsePromises = Symbol('kUsePromises');
const hostBindings = createFsBindings();
export const { fsBinding, fsDirBinding, fsEventWrapBinding, FSReqCallback, DirHandle, FSEvent, StatWatcher, FileHandle } = hostBindings;
export type FSReqCallback = InstanceType<typeof FSReqCallback>;
export type DirHandle = InstanceType<typeof DirHandle>;
export type FSEvent = InstanceType<typeof FSEvent>;
export type StatWatcher = InstanceType<typeof StatWatcher>;
export type FileHandle = InstanceType<typeof FileHandle>;
export default fsBinding;
