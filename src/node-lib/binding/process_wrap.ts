import { processCredentialsOf, copyProcessCredentials, spawnedProcessCredentials, type ProcessCredentials } from '../../process-credentials';
/**
 * `internalBinding('process_wrap')`: one run of the engine, seen as libuv sees
 * a child process.
 *
 * libuv's `uv_spawn` starts a program with its descriptors already wired and
 * answers through `onexit` when it ends; `uv_process_kill` ends it. That is
 * the whole of what `internal/child_process.js` asks of a process, and it is
 * the whole of this file. Nothing here knows about `ChildProcess`, `stdio`
 * streams, `exec`'s buffering, `fork`'s IPC protocol or what a signal means:
 * those are Node's own and are vendored.
 *
 * What the engine already did for a spawned command stays and becomes this
 * file's implementation, through the one door the engine's process model
 * installs below: the routing of a command to the engine's `node`, to a
 * program the page registered, to a WALI pack, or to the shell. A `pipe`
 * stdio entry is paired with an end of its own here, so the child's writes to
 * fd 1 are reads on the parent's handle and the parent's writes to the stdin
 * handle are the child's fd 0 -- which is what a `uv_stdio_container_t` with
 * `UV_CREATE_PIPE` is. In a process with socket calls each entry is what
 * libuv makes it in the parent's kernel table (a socketpair, the parent's
 * descriptor, /dev/null) and the child is started with them at its numbers
 * (ADR-0010).
 */
import {
  LibuvStreamWrap, WriteWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset,
} from './stream_wrap';
import { Pipe, constants as pipeConstants } from './pipe_wrap';
import { nativeStreamFor } from '../../native-stream-binding';
import { UV_EBADF, UV_ENOENT, UV_ESRCH, UV_EPERM, UV_EINVAL } from './uv';
import { traceReadingRequested, traceOutput } from '../../trace-output';
import {
  registerHandle, refHandle, unrefHandle, handleHasRef, releaseHandle, __adoptHandle, observeNodeHandle, nodeHandleHasRef, nodeHandleIsInitialized,
  ownerOf, ownerOfInstance, invokeOwned, type OwnedHandle,
} from './handles';
import { __runFor, type ProcessToken } from '../../process-tokens';
import { withGuestCallback, queueBindingTask } from '../../guest-loop';
import { handleForFd } from './fds';
import { KernelStreamWrap, kHandleFd } from './kernel_stream';
import { callingSockets, callingTree, linux, type TreeSockets } from '../../host-sockets';
import { treeDescriptorsOf, type TreeDescriptors } from '../../tree-descriptors';
import { descriptorWriter, type DescriptorWriter } from './fs';
import { TTY, type TerminalState } from './tty_wrap';

/** One entry of Node's `options.stdio`, as `getValidStdio` builds it. */
export interface StdioEntry {
  type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap';
  handle?: LibuvStreamWrap;
  fd?: number;
  ipc?: boolean;
  readable?: boolean;
  writable?: boolean;
}

/** Node24.21 src/process_wrap.cc's flags; these are not libuv's bit values. */
export const constants = Object.freeze({
  kProcessFlagDetached: 1 << 0,
  kProcessFlagWindowsHide: 1 << 1,
  kProcessFlagWindowsVerbatimArguments: 1 << 2,
});

/** What the engine's process runner receives after decoding the native call. */
export interface ProcessSpawnOptions {
  file: string;
  args?: string[];
  cwd?: string;
  envPairs?: string[];
  stdio: StdioEntry[];
  detached?: boolean;
  windowsHide?: boolean;
  uid?: number;
  gid?: number;
}

/** The channel a forked child is started with, at the descriptor it is told. */
export interface RunChannel {
  /** The number the child's `NODE_CHANNEL_FD` names. */
  fd: number;
  /** The child's end of the channel, which its own `Pipe.open(fd)` finds. */
  pipe: Pipe;
  /** `json` or `advanced`, as `NODE_CHANNEL_SERIALIZATION_MODE` says. */
  serialization: string;
}

/** What the binding asks the engine's process model to run. */
export interface RunRequest {
  /** A snapshot of the actual spawning process, not its mutable guest getter methods. */
  credentials: Readonly<ProcessCredentials>;
  /** Present only for an explicit spawn uid/gid declaration; passed to new-child admission. */
  runAs?: Readonly<ProcessCredentials>;
  /** The run whose `Process` handle spawns it: its parent (the handle's NodeLibScope's process), or null for none. */
  owner: ProcessToken | null;
  /** The program, as the caller named it: a path, a name, or the shell. */
  file: string;
  /** argv, the file first, as Node builds it. */
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  detached: boolean;
  /**
   * Where the child's fd 1 goes; null where nothing reads it. A pipe is a
   * byte stream: a chunk the child wrote as bytes arrives as those bytes, and
   * text only where the program that ran it produced text.
   */
  stdout: ((chunk: string | Uint8Array) => void) | null;
  /** Where the child's fd 2 goes; null where nothing reads it. */
  stderr: ((chunk: string | Uint8Array) => void) | null;
  /**
   * True when fd 2 is a pipe the parent holds. A run that ends uncaught or
   * with a nonzero `process.exit` on that pipe writes one receipt to the
   * host realm's console, because the parent may never read the pipe — the
   * tab's extension host dies this way, its stderr going into `@vscode/spdlog`
   * which does not load. Inherit and the host's own stdio are false.
   */
  stderrIsPipe: boolean;
  /** True when the child's fd 0 is a pipe whose writer has not closed. */
  stdinIsPipe: boolean;
  terminal?: TerminalState;
  /** The IPC channel the child is started with, where it has one. */
  channel?: RunChannel;
  /**
   * The child's pipes past fd 2 (`stdio: [..., 'pipe', 'pipe']`), each at the
   * number the child reads or writes it by, with the child's end of it.
   */
  descriptors: { fd: number; pipe: Pipe }[];
  /**
   * The child's descriptors as its own process is started with them, where the spawning process has socket calls
   * (ADR-0010 §1): each `fd` of the child's table is the parent's descriptor `from` (a socketpair's child end, an
   * inherited or named descriptor, a stream's, /dev/null), which the child's fork copies. Empty where the process has
   * none.
   */
  kernelDescriptors: { fd: number; from: number }[];
  /**
   * The child is started as its own process with `kernelDescriptors` (a host runs it, ADR-0010 §2): called by the
   * runner once the child is forked and before anything of it reaches its host. Each of its fds 0 to 2 and each pipe end
   * made for it becomes blocking, and the parent closes its copies of what it made for the child, so it serves none of
   * them. Absent where `kernelDescriptors` is empty.
   */
  handOver?(): void;
  /** Called once, when the run has ended. */
  exit(code: number, signal: string | null): void;
}

/** One run in flight, as the engine's process model hands it back. */
export interface StartedRun {
  /** The run's own name, so a handle it holds is counted as its own. */
  token: ProcessToken | null;
  /** The run's process number, made at its fork, which is what its own `process.pid` reports. */
  pid: number;
  /** libuv's `uv_process_kill`: 0, or `UV_ESRCH` for a run already over. */
  kill(signal: string): number;
  /** Bytes the parent wrote to the child's fd 0. */
  writeStdin(bytes: Uint8Array): void | Promise<void>;
  /** The parent closed the child's fd 0. */
  endStdin(): void;
  /**
   * The parent's handle on this child was ref'd or unref'd. A child another runs (a host's program) is waited for by
   * that host on the parent's behalf, and only while the handle is ref'd: `unref()` is how a program stops waiting.
   */
  setRef?(held: boolean): void;
}

/**
 * The engine's process model, installed by `initChildProcess`. Until it is
 * there is no engine to run anything, and a spawn answers `ENOENT`, which is
 * what a machine carrying no such program answers.
 */
export interface ProcessRunner {
  /** Whether the engine has a program under this name at all. */
  resolves(request: RunRequest): boolean;
  start(request: RunRequest): StartedRun;
}

let runner: ProcessRunner | null = null;

/** The engine's process model takes this door once, when the VFS is known. */
export function setProcessRunner(next: ProcessRunner): void {
  runner = next;
}

let nextAsyncId = 1;

/** The `open(2)` modes `uv__process_child_init` opens /dev/null with: read-only for fd 0, read-write for 1 and 2. */
const O_RDONLY = 0, O_RDWR = 2;

/** `envPairs` is `KEY=value` strings; the engine's shell takes a record. */
function environmentOf(envPairs: string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of envPairs ?? []) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return env;
}

/** A signal named by number, as the name libuv reports for it. */
const signalNames: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL',
  10: 'SIGUSR1', 12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
};
function signalNameOf(signal: number | string): string {
  if (typeof signal === 'string') return signal;
  return signalNames[signal] ?? 'SIGTERM';
}

/**
 * The directory a child starts in when the caller named none: its parent's.
 * `execve` keeps the calling process's working directory, and Node's `fork`
 * passes no `cwd` at all -- `fork('./child.js')` from a program running in
 * `/work` means `/work/child.js`, and resolved against the engine's shell's
 * own root it meant `/child.js` and a child that exited 1.
 */
// A shared realm's process global is whichever guest ran last. The spawning
// handle belongs to the parent: inherited stdio and cwd must come from that
// parent's process, even while a sibling starts or exits. A failed fork was
// replaying stderr into its own closed IPC-backed stream (write EBADF).
function parentProcess(token: ProcessToken | null) {
  return token !== null ? __runFor(token)?.process
    : (globalThis as unknown as { process?: { cwd?: () => string; stdout?: { write(chunk: string | Uint8Array): unknown }; stderr?: { write(chunk: string | Uint8Array): unknown } } }).process;
}

function spawningDirectory(token: ProcessToken | null): string | undefined {
  const realm = parentProcess(token);
  if (typeof realm?.cwd !== 'function') return undefined;
  try { return realm.cwd(); } catch { return undefined; }
}

/**
 * Where an `inherit` entry's bytes go: the spawning program's own stream. An entry that names a descriptor by
 * number is the same thing said another way, and `stdio: 'inherit'` is said that way: Node's
 * `stdioStringToArray` turns the string into `[0, 1, 2]`, which `getValidStdio` hands on as `{ type: 'fd' }`.
 * The synchronous binding asks here too, so a child's bytes go where they go whichever call started it.
 */
export function inheritedWriter(fd: number, token: ProcessToken | null): DescriptorWriter | null {
  // a descriptor of the parent's own (a log file it opened) is written as the file
  if (fd !== 1 && fd !== 2) return descriptorWriter(fd);
  // Inherit the descriptor's original sink, not a guest replacement of
  // process.stderr.write (a child commonly redirects its console over IPC).
  if (token !== null) {
    const parent = __runFor(token);
    return (fd === 1 ? parent?.stdout : parent?.stderr) ?? null;
  }
  const realm = parentProcess(token);
  const stream = fd === 1 ? realm?.stdout : realm?.stderr;
  if (!stream || typeof stream.write !== 'function') return null;
  return (chunk: string | Uint8Array) => {
    try { stream.write(chunk); } catch { /* a stream that refuses still lets the child run */ }
  };
}

/**
 * libuv's `uv_process_t`.
 *
 * The handle registers with the run that made it, as every handle here does,
 * so a parent waiting on a child is not idle: Node's loop holds a process
 * handle exactly that way, and `unref()` is how a program gives it up.
 */
const credentialsByHandle = new WeakMap<object, Readonly<ProcessCredentials>>();

export class Process implements OwnedHandle {
  /** Set by `internal/child_process.js`; the only way an end is reported. */
  onexit: ((exitCode: number, signalCode: string | null) => void) | null = null;
  /**
   * A process that never started has no pid, and `ChildProcess` copies this
   * one straight onto itself: a child whose `spawn` answered `ENOENT` reports
   * `pid === undefined`, as Node's does, rather than a number naming nothing.
   */
  pid: number | undefined = undefined;

  private run: StartedRun | null = null;
  private ended = false;
  private closed = false;
  /** The stdio entries this run was started with, and their far ends. */
  private stdio: StdioEntry[] = [];
  /** The child's ends this handle holds by number where they are no pairing's peer: a terminal's, a kernel channel's. */
  private farEnds = new Map<number, TTY | Pipe>();
  /** Writers holding their own reference to a parent's description (fd stdio), released at the child's end. */
  private heldDescriptions: DescriptorWriter[] = [];
  /** The /dev/null descriptors opened in the parent's table for the child's ignored fds 0 to 2, until its start. */
  private nullFiles: { files: TreeDescriptors; fd: number }[] = [];
  /** The file this process was spawned from, for the instrument below. */
  private spawned = '';
  private readonly asyncId = nextAsyncId++;

  constructor() {
    registerHandle(this);
  }

  getAsyncId(): number {
    return this.asyncId;
  }

  ref(): void {
    if (!nodeHandleIsInitialized(this)) return;
    refHandle(this);
    this.run?.setRef?.(true);
  }

  unref(): void {
    if (!nodeHandleIsInitialized(this)) return;
    unrefHandle(this);
    this.run?.setRef?.(false);
  }

  hasRef(): boolean {
    return nodeHandleHasRef(this);
  }

  /**
   * libuv's `uv_spawn`. Answers 0 for a run that started and a `UV_*` code for
   * one that could not, which is what `ChildProcess.prototype.spawn` turns
   * into an `error` event or a throw.
   */
  spawn(file: string, args: string[] | undefined, cwd: string | undefined,
    envPairs: string[] | undefined, stdio: StdioEntry[], flags: number,
    uid?: number, gid?: number): number {
    const options: ProcessSpawnOptions = {
      file, args, cwd, envPairs, stdio, uid, gid,
      detached: (flags & constants.kProcessFlagDetached) !== 0,
      windowsHide: (flags & constants.kProcessFlagWindowsHide) !== 0,
    };
    if (!runner) return UV_ENOENT;
    const parentCredentials = credentialsByHandle.get(this) ?? copyProcessCredentials();
    let credentials: Readonly<ProcessCredentials>;
    try { credentials = spawnedProcessCredentials(parentCredentials, uid, gid); }
    catch (cause) { return (cause as { code?: string })?.code === 'EPERM' ? UV_EPERM : UV_EINVAL; }
    const env = environmentOf(options.envPairs);
    this.stdio = options.stdio ?? [];
    this.spawned = options.file;

    // The spawning process's socket calls: where it has them its descriptors are a kernel's, and the child's stdio is
    // made in its table as libuv makes it.
    const sockets = callingSockets();
    const request: RunRequest = {
      credentials,
      ...(uid != null || gid != null ? { runAs: credentials } : {}),
      owner: ownerOfInstance(this),
      file: options.file,
      args: options.args ?? [options.file],
      cwd: options.cwd ?? spawningDirectory(ownerOf(this)),
      env,
      detached: options.detached === true,
      stdout: null,
      stderr: null,
      stderrIsPipe: false,
      stdinIsPipe: false,
      descriptors: [],
      kernelDescriptors: [],
      ...(sockets ? { handOver: () => { this.handOver(request.kernelDescriptors, sockets); } } : {}),
      exit: (code, signal) => { this.reportExit(code, signal); },
    };

    let stdinFar: LibuvStreamWrap | null = null;
    for (let index = 0; index < this.stdio.length; index += 1) {
      const entry = this.stdio[index];
      if (!entry) continue;
      if (index < 3 && !entry.ipc) {
        const descriptor = entry.type === 'fd' || entry.type === 'inherit'
          ? handleForFd(entry.fd ?? index) : entry.handle;
        if (descriptor instanceof TTY && descriptor.slave) {
          // Inherit an independent descriptor reference, never the parent's
          // wrapper. Failed spawn and child exit release only this copy.
          const inherited = descriptor.duplicate();
          __adoptHandle(inherited, null);
          this.farEnds.set(index, inherited);
          request.terminal = inherited.terminal;
          if (index === 0) { stdinFar = inherited; request.stdinIsPipe = true; }
          else if (index === 1) request.stdout = chunk => this.toPipe(index, chunk);
          else request.stderr = chunk => this.toPipe(index, chunk);
          continue;
        }
      }
      const far = this.pairFarEnd(entry, index, sockets);
      if (typeof far === 'number') {
        this.closeFarEnds();
        return far;
      }
      if (sockets) {
        const from = this.placedFrom(entry, index, far, sockets);
        if (from !== null && from < 0) {
          this.closeFarEnds();
          return from;
        }
        if (from !== null) request.kernelDescriptors.push({ fd: index, from });
      }
      if (entry.ipc) {
        if (far) {
          request.channel = {
            fd: index,
            pipe: far,
            serialization: env.NODE_CHANNEL_SERIALIZATION_MODE || 'json',
          };
        }
        continue;
      }
      if (index === 0) {
        stdinFar = far;
        request.stdinIsPipe = far !== null;
        continue;
      }
      if (index > 2) {
        // A pipe past fd 2 is the child's too, at its own number: libuv
        // hands a child every `UV_CREATE_PIPE` entry, not only stdio's three.
        if (far) request.descriptors.push({ fd: index, pipe: far });
        continue;
      }
      if (far) {
        const to = index;
        const write = (chunk: string | Uint8Array): void => { this.toPipe(to, chunk); };
        if (index === 1) request.stdout = write;
        else {
          request.stderr = write;
          request.stderrIsPipe = true;
        }
      } else if (entry.type === 'inherit' || entry.type === 'fd') {
        const inherited = inheritedWriter(entry.fd ?? index, ownerOf(this));
        // A descriptor the caller names and does not hold fails the spawn (`spawn EBADF`), as libuv's does.
        if (inherited === null && (entry.fd ?? index) > 2) {
          this.closeFarEnds();
          return UV_EBADF;
        }
        if (inherited?.release) this.heldDescriptions.push(inherited);
        if (index === 1) request.stdout = inherited;
        else request.stderr = inherited;
      }
    }

    // Node marks the process wrap initialized after the native spawn attempt,
    // including ENOENT; ChildProcess closes it from its existing error turn.
    observeNodeHandle(this);
    if (!runner.resolves(request)) {
      // An unresolved spawn reports ENOENT; tracing retains the original request.
      if (traceReadingRequested()) traceOutput('[boot-trace]', { event: 'spawn-not-resolved', at: Date.now(), file: request.file, args: request.args?.slice(0, 4), cwd: request.cwd ?? null });
      this.closeFarEnds();
      return UV_ENOENT;
    }

    try { this.run = runner.start(request); }
    catch (cause) {
      this.closeFarEnds();
      const code = (cause as { code?: string })?.code;
      // Keep the runner's refusal detail in the trace before mapping its errno.
      if (traceReadingRequested()) traceOutput('[boot-trace]', { event: 'spawn-start-refused', at: Date.now(), file: request.file, args: request.args?.slice(0, 6), cwd: request.cwd ?? null, code: code ?? null, message: cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300), stack: cause instanceof Error ? (cause.stack ?? '').split('\n').slice(0, 8).join(' | ') : null });
      if (code === 'EPERM') return UV_EPERM;
      if (code === 'EINVAL') return UV_EINVAL;
      throw cause;
    }
    // Reference changes after initialization also govern the owned child run.
    if (!handleHasRef(this)) this.run.setRef?.(false);
    this.closeNullFiles();
    // The number the parent reads off the handle is the child's own
    // `process.pid`, made at its fork, as it is in Node.
    this.pid = this.run.pid;
    // A child that reads its own fd 0 was handed its end at its hand-over, which closed it here.
    if (stdinFar && !stdinFar.closed) this.readStdinFrom(stdinFar);
    return 0;
  }

  /**
   * libuv's `uv_process_kill`: the run ends, or it was over already. Signal 0
   * is the question "is it still there?", which kills nothing and answers 0
   * for a run in flight and `ESRCH` for one that has ended.
   */
  kill(signal: number | string): number {
    if (this.ended || !this.run) return UV_ESRCH;
    if (signal === 0) return 0;
    return this.run.kill(signalNameOf(signal));
  }

  close(callback?: () => void): void {
    if (!this.closed) {
      this.closed = true;
      releaseHandle(this, true, 1);
    }
    if (callback) queueBindingTask(() => withGuestCallback(callback));
  }

  /**
   * The other half of a `pipe` entry: the end the child holds. It belongs to
   * no run -- the parent holds the handle Node gave it and the child holds the
   * one it opens; this is the wire between them. In a process with socket
   * calls it is the other end of a `socketpair` in the parent's table, which
   * the child's fork copies (uv_spawn's `UV_CREATE_PIPE`), whether the entry
   * is stdio or IPC; a failure to make it is the spawn's.
   */
  private pairFarEnd(entry: StdioEntry, index: number, sockets: TreeSockets | undefined): Pipe | number | null {
    if (entry.type !== 'pipe' && entry.type !== 'overlapped') return null;
    if (!entry.handle) return null;
    if (sockets && entry.handle instanceof Pipe) {
      const far = entry.ipc ? new Pipe(pipeConstants.IPC) : Pipe.forDescriptor();
      __adoptHandle(far, null);
      const status = entry.handle.socketpair(far);
      if (status !== 0) { far.close(); return status; }
      this.farEnds.set(index, far);
      return far;
    }
    const far = new Pipe(entry.ipc ? pipeConstants.IPC : pipeConstants.SOCKET);
    __adoptHandle(far, null);
    LibuvStreamWrap.pair(entry.handle, far);
    return far;
  }

  /**
   * The parent's descriptor the child's fd `index` is, as `uv__process_init_stdio` picks it (ADR-0010 §1): a
   * socketpair's child end; an `inherit` or numbered entry's descriptor (a number the parent's run was started with as
   * a kernel stream being that stream's), refused with its `EBADF` where the parent holds none; a kernel stream's
   * (`uv__stream_fd`); for an ignored fd 0 to 2, /dev/null opened for it (`uv__process_child_init`). Null where the
   * child is given nothing at `index`; a negative errno where the spawn fails.
   */
  private placedFrom(entry: StdioEntry, index: number, far: Pipe | null, sockets: TreeSockets): number | null {
    if (far) return far.kernelBacked ? far[kHandleFd] : null;
    if (entry.type === 'inherit' || entry.type === 'fd') {
      const fd = entry.fd ?? index;
      const held = handleForFd(fd);
      const from = held instanceof KernelStreamWrap && held.kernelBacked ? held[kHandleFd] : fd;
      const flags = sockets.fcntl(from, linux.F_GETFL, 0);
      return flags < 0 ? flags : from;
    }
    if (entry.type === 'wrap') {
      const handle = entry.handle;
      return handle instanceof KernelStreamWrap && handle.kernelBacked && handle[kHandleFd] >= 0 ? handle[kHandleFd] : null;
    }
    if (entry.type !== 'ignore' || index > 2) return null;
    const files = treeDescriptorsOf(callingTree());
    if (!files) return null;
    try {
      const fd = files.open('/dev/null', index === 0 ? O_RDONLY : O_RDWR, 0);
      this.nullFiles.push({ files, fd });
      return fd;
    } catch (cause) {
      const errno = (cause as { errno?: unknown } | null)?.errno;
      if (typeof errno !== 'number' || errno === 0) throw cause;
      return -Math.abs(errno);
    }
  }

  /**
   * The child is its own process, started with `placed` (ADR-0010 §2): each of its fds 0 to 2 and each socketpair end
   * made for it is made blocking, as `uv__process_child_init` and `uv_socketpair(..., 0, 0)` leave them, on the
   * parent's number for the description; then the parent closes the ends it made for the child, whose fork holds its
   * own copies, as libuv's parent closes a child's end after the fork.
   */
  private handOver(placed: readonly { fd: number; from: number }[], sockets: TreeSockets): void {
    const ends = [...this.farEnds.values()].filter((far): far is Pipe => far instanceof Pipe && far.kernelBacked);
    const endFds = new Set(ends.map(far => far[kHandleFd]));
    for (const { fd, from } of placed) {
      if (fd > 2 && !endFds.has(from)) continue;
      const flags = sockets.fcntl(from, linux.F_GETFL, 0);
      if (flags >= 0 && (flags & linux.O_NONBLOCK) !== 0) sockets.fcntl(from, linux.F_SETFL, flags & ~linux.O_NONBLOCK);
    }
    for (const far of ends) far.close();
  }

  /** The /dev/null descriptors opened for the child: its fork holds its copies once it has started. */
  private closeNullFiles(): void {
    for (const { files, fd } of this.nullFiles.splice(0)) {
      try { files.close(fd); } catch { /* a descriptor already gone is closed */ }
    }
  }

  /** The far end of fd `index`, whoever holds it now. */
  private farEndAt(index: number): LibuvStreamWrap | null {
    return this.farEnds.get(index) ?? this.stdio[index]?.handle?.peer ?? null;
  }

  private closeFarEnds(): void {
    // The child's own references to the parent's descriptions it wrote (fd stdio) end with it.
    for (const writer of this.heldDescriptions.splice(0)) writer.release?.();
    this.closeNullFiles();
    for (let index = 0; index < this.stdio.length; index += 1) {
      const far = this.farEndAt(index);
      if (!far) continue;
      try { far.close(); } catch { /* an end already closed is already given up */ }
    }
  }

  /** The child wrote to fd `index`; the parent's handle reads it. */
  private toPipe(index: number, chunk: string | Uint8Array): void {
    const far = this.farEndAt(index);
    if (!far || far.closed) return;
    if (typeof chunk === 'string') far.writeUtf8String(new WriteWrap(), chunk);
    else far.writeBuffer(new WriteWrap(), chunk);
  }

  /** Bytes the parent writes reach the child's fd 0; the parent's EOF ends it. */
  private readStdinFrom(far: LibuvStreamWrap): void {
    far.onread = (arrayBuffer: ArrayBuffer | null): void => {
      const length = streamBaseState[kReadBytesOrError];
      if (length <= 0 || arrayBuffer === null) { this.run?.endStdin(); return; }
      const run = this.run;
      const consumed = run?.writeStdin(new Uint8Array(arrayBuffer, streamBaseState[kArrayBufferOffset], length).slice());
      if (consumed) {
        far.readStop();
        void consumed.then(() => {
          if (this.run === run && !this.ended && !far.closed) far.readStart();
        }, () => {
          // A stopped receiver closes its input pipe. Do not resume a reader
          // or deliver its queued bytes to a later run.
          if (this.run === run && !this.ended) { far.close(); run?.endStdin(); }
        });
      }
    };
    far.readStart();
  }

  /**
   * The run has ended. The child's ends of the pairings close, so the parent's
   * streams read EOF as they do when a real child's descriptors go, and
   * `onexit` fires once, after them: Node's `flushStdio` runs on the tick
   * after `onexit` and must find the bytes already delivered.
   */
  private reportExit(code: number, signal: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.closeFarEnds();
    this.run = null;
    invokeOwned(this, 'onexit', code, signal);
    this.sayLateClose();
  }

  /**
   * An instrument. Node emits a child's `close` once it has exited and each of its piped stdio streams has closed
   * (lib/internal/child_process.js `maybeClose`: `_closesGot === _closesNeeded`), which here follows the far ends
   * closing above. A parent's pipe that has still not read end-of-file a moment after the exit is what keeps
   * `close` back (a World's `up` waited 507 ms on a fallback timer for it, Cal run 49); this says which pipe, and
   * what still holds its other end. It changes nothing.
   */
  private sayLateClose(): void {
    const file = this.spawned;
    const entries = this.stdio;
    const timer = setTimeout(() => {
      const late: unknown[] = [];
      entries.forEach((entry, index) => {
        if (index === 0 || (entry.type !== 'pipe' && entry.type !== 'overlapped') || !entry.handle) return;
        const handle = entry.handle as unknown as { closed?: boolean; reading?: boolean; eofDelivered?: boolean; streamEndpoint?: { eof?: boolean; inbound?: unknown[]; peer?: { handles?: { size: number } } | null } };
        if (handle.closed || handle.eofDelivered) return;
        late.push({ fd: index, native: nativeStreamFor(entry.handle as never) !== undefined, reading: handle.reading === true, endOfFileQueued: handle.streamEndpoint?.eof === true,
          unread: handle.streamEndpoint?.inbound?.length ?? null, otherEndHeldBy: handle.streamEndpoint?.peer ? handle.streamEndpoint.peer.handles?.size ?? null : 0 });
      });
      if (late.length > 0) traceOutput("[boot-trace]", { event: 'child-close-late', at: Date.now(), file, stdio: entries.map((entry) => entry.type), late });
    }, 100);
    (timer as { unref?: () => void }).unref?.();
  }
}

/** NodeLibScope supplies the parent even for a Runtime without a named run token. */
export function createProcessBinding(parent: object): { Process: typeof Process; constants: typeof constants } {
  class ScopedProcess extends Process {
    constructor() { super(); credentialsByHandle.set(this, processCredentialsOf(parent)); }
  }
  Object.defineProperty(ScopedProcess, 'name', { value: Process.name, configurable: true });
  return { Process: ScopedProcess, constants };
}

export default { Process, constants };
