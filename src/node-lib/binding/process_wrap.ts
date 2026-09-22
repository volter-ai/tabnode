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
 * `UV_CREATE_PIPE` is.
 */
import {
  LibuvStreamWrap, WriteWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset,
} from './stream_wrap';
import { Pipe, constants as pipeConstants } from './pipe_wrap';
import { UV_ENOENT, UV_ESRCH } from './uv';
import {
  registerHandle, refHandle, unrefHandle, handleHasRef, releaseHandle, __adoptHandle,
  ownerOf, type OwnedHandle,
} from './handles';
import { __runFor, type ProcessToken } from '../../process-tokens';

/** One entry of Node's `options.stdio`, as `getValidStdio` builds it. */
export interface StdioEntry {
  type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap';
  handle?: LibuvStreamWrap;
  fd?: number;
  ipc?: boolean;
  readable?: boolean;
  writable?: boolean;
}

/** What `ChildProcess.prototype.spawn` hands `Process.spawn`. */
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
  /** The program, as the caller named it: a path, a name, or the shell. */
  file: string;
  /** argv, the file first, as Node builds it. */
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  detached: boolean;
  /** Where the child's fd 1 goes; null where nothing reads it. */
  stdout: ((text: string) => void) | null;
  /** Where the child's fd 2 goes; null where nothing reads it. */
  stderr: ((text: string) => void) | null;
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
  /** The IPC channel the child is started with, where it has one. */
  channel?: RunChannel;
  /** Called once, when the run has ended. */
  exit(code: number, signal: string | null): void;
}

/** One run in flight, as the engine's process model hands it back. */
export interface StartedRun {
  /** The run's own name, so a handle it holds is counted as its own. */
  token: ProcessToken | null;
  /** The run's process number, which is what its own `process.pid` reports. */
  pid?: number;
  /** libuv's `uv_process_kill`: 0, or `UV_ESRCH` for a run already over. */
  kill(signal: string): number;
  /** Bytes the parent wrote to the child's fd 0. */
  writeStdin(bytes: Uint8Array): void;
  /** The parent closed the child's fd 0. */
  endStdin(): void;
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

let nextPid = 1001 + Math.floor(Math.random() * 30000);
let nextAsyncId = 1;

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
    : (globalThis as unknown as { process?: { cwd?: () => string; stdout?: { write(text: string): unknown }; stderr?: { write(text: string): unknown } } }).process;
}

function spawningDirectory(token: ProcessToken | null): string | undefined {
  const realm = parentProcess(token);
  if (typeof realm?.cwd !== 'function') return undefined;
  try { return realm.cwd(); } catch { return undefined; }
}

/** Where an `inherit` entry's bytes go: the spawning program's own stream. */
function inheritedWriter(fd: number, token: ProcessToken | null): ((text: string) => void) | null {
  if (fd !== 1 && fd !== 2) return null;
  // Inherit the descriptor's original sink, not a guest replacement of
  // process.stderr.write (a child commonly redirects its console over IPC).
  if (token !== null) {
    const parent = __runFor(token);
    return (fd === 1 ? parent?.stdout : parent?.stderr) ?? null;
  }
  const realm = parentProcess(token);
  const stream = fd === 1 ? realm?.stdout : realm?.stderr;
  if (!stream || typeof stream.write !== 'function') return null;
  return (text: string) => {
    try { stream.write(text); } catch { /* a stream that refuses still lets the child run */ }
  };
}

/**
 * libuv's `uv_process_t`.
 *
 * The handle registers with the run that made it, as every handle here does,
 * so a parent waiting on a child is not idle: Node's loop holds a process
 * handle exactly that way, and `unref()` is how a program gives it up.
 */
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
  private readonly asyncId = nextAsyncId++;

  constructor() {
    registerHandle(this);
  }

  getAsyncId(): number {
    return this.asyncId;
  }

  ref(): void {
    refHandle(this);
  }

  unref(): void {
    unrefHandle(this);
  }

  hasRef(): boolean {
    return handleHasRef(this);
  }

  /**
   * libuv's `uv_spawn`. Answers 0 for a run that started and a `UV_*` code for
   * one that could not, which is what `ChildProcess.prototype.spawn` turns
   * into an `error` event or a throw.
   */
  spawn(options: ProcessSpawnOptions): number {
    if (!runner) return UV_ENOENT;
    const env = environmentOf(options.envPairs);
    this.stdio = options.stdio ?? [];

    const request: RunRequest = {
      file: options.file,
      args: options.args ?? [options.file],
      cwd: options.cwd ?? spawningDirectory(ownerOf(this)),
      env,
      detached: options.detached === true,
      stdout: null,
      stderr: null,
      stderrIsPipe: false,
      stdinIsPipe: false,
      exit: (code, signal) => { this.reportExit(code, signal); },
    };

    let stdinFar: Pipe | null = null;
    for (let index = 0; index < this.stdio.length; index += 1) {
      const entry = this.stdio[index];
      if (!entry) continue;
      const far = this.pairFarEnd(entry);
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
      if (index !== 1 && index !== 2) continue;
      if (far) {
        const to = index;
        const write = (text: string): void => { this.toPipe(to, text); };
        if (index === 1) request.stdout = write;
        else {
          request.stderr = write;
          request.stderrIsPipe = true;
        }
      } else if (entry.type === 'inherit' || entry.type === 'fd') {
        const inherited = inheritedWriter(entry.fd ?? index, ownerOf(this));
        if (index === 1) request.stdout = inherited;
        else request.stderr = inherited;
      }
    }

    if (!runner.resolves(request)) {
      this.closeFarEnds();
      return UV_ENOENT;
    }

    this.run = runner.start(request);
    // The number the parent reads off the handle is the child's own
    // `process.pid`, as it is in Node; a runner that names none is given one.
    this.pid = this.run.pid ?? nextPid++;
    if (stdinFar) this.readStdinFrom(stdinFar);
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
      releaseHandle(this);
    }
    if (callback) queueMicrotask(callback);
  }

  /**
   * The other half of a `pipe` entry: the end the child holds. It belongs to
   * no run -- the parent holds the handle Node gave it and the child holds the
   * one it opens; this is the wire between them.
   */
  private pairFarEnd(entry: StdioEntry): Pipe | null {
    if (entry.type !== 'pipe' && entry.type !== 'overlapped') return null;
    if (!entry.handle) return null;
    const far = new Pipe(entry.ipc ? pipeConstants.IPC : pipeConstants.SOCKET);
    __adoptHandle(far, null);
    LibuvStreamWrap.pair(entry.handle, far);
    return far;
  }

  /** The far end of fd `index`, whoever holds it now. */
  private farEndAt(index: number): LibuvStreamWrap | null {
    return this.stdio[index]?.handle?.peer ?? null;
  }

  private closeFarEnds(): void {
    for (let index = 0; index < this.stdio.length; index += 1) {
      const far = this.farEndAt(index);
      if (!far) continue;
      try { far.close(); } catch { /* an end already closed is already given up */ }
    }
  }

  /** The child wrote to fd `index`; the parent's handle reads it. */
  private toPipe(index: number, text: string): void {
    const far = this.farEndAt(index);
    if (!far || far.closed) return;
    far.writeUtf8String(new WriteWrap(), text);
  }

  /** Bytes the parent writes reach the child's fd 0; the parent's EOF ends it. */
  private readStdinFrom(far: Pipe): void {
    far.onread = (arrayBuffer: ArrayBuffer | null): void => {
      const length = streamBaseState[kReadBytesOrError];
      if (length <= 0 || arrayBuffer === null) { this.run?.endStdin(); return; }
      this.run?.writeStdin(new Uint8Array(arrayBuffer, streamBaseState[kArrayBufferOffset], length).slice());
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
    const report = this.onexit;
    this.run = null;
    if (report) report(code, signal);
  }
}

export default { Process };
