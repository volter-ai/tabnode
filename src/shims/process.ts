/**
 * Node.js process shim
 * Provides minimal process object for browser environment
 * Process is an EventEmitter in Node.js
 */

import { EventEmitter } from '../node-lib/events-module';
import type { EventListener } from '../node-lib/events-module';
import { Readable } from '../node-lib/stream-module';
import { loadNodeLibFor } from '../node-lib/load';
import { constantsBinding } from './constants';
import ttyWrapBinding from '../node-lib/binding/tty_wrap';
import { mintPid, pidIsLive, signalPid, __recordTermination } from '../process-tokens';
import { NODE_LTS_VERSION, nodeVersions } from '../node-lib/node-versions';
import { freemem as osFreemem } from './os';

export interface ProcessEnv {
  [key: string]: string | undefined;
}

// Stream-like interface with EventEmitter methods
interface ProcessStream {
  isTTY: boolean;
  on: (event: string, listener: EventListener) => ProcessStream;
  once: (event: string, listener: EventListener) => ProcessStream;
  off: (event: string, listener: EventListener) => ProcessStream;
  emit: (event: string, ...args: unknown[]) => boolean;
  addListener: (event: string, listener: EventListener) => ProcessStream;
  removeListener: (event: string, listener: EventListener) => ProcessStream;
  removeAllListeners: (event?: string) => ProcessStream;
  setMaxListeners: (n: number) => ProcessStream;
  getMaxListeners: () => number;
  listenerCount: (event: string) => number;
  listeners: (event: string) => EventListener[];
  rawListeners: (event: string) => EventListener[];
  prependListener: (event: string, listener: EventListener) => ProcessStream;
  prependOnceListener: (event: string, listener: EventListener) => ProcessStream;
  eventNames: () => (string | symbol)[];
  pause?: () => ProcessStream;
  resume?: () => ProcessStream;
  // nodemon pipes the parent's stdin into its fork and unpipes it on exit; a
  // stream without these was no stream at all. A pipe hands the destination
  // back, as Node's does, and carries nothing.
  pipe: (destination: unknown) => unknown;
  unpipe: () => ProcessStream;
  isPaused: () => boolean;
  unshift: () => void;
  setEncoding?: (encoding: string) => ProcessStream;
  // The cursor calls a terminal-minded logger makes, answered the way a
  // non-TTY stream answers them on Node: Vite's build clears its progress line
  // without asking, and a stream without these died in every `vite build`.
  columns: number;
  rows: number;
  clearLine: (direction: number | (() => void), callback?: () => void) => boolean;
  cursorTo: (x: number, y?: number | (() => void), callback?: () => void) => boolean;
  moveCursor: (dx: number, dy: number, callback?: () => void) => boolean;
  getWindowSize: () => [number, number];
  hasColors: () => boolean;
  getColorDepth: () => number;
}

interface ProcessWritableStream extends ProcessStream {
  write: (data: string | Buffer, ...rest: unknown[]) => boolean;
  end?: (...args: unknown[]) => void;
}

/**
 * `process.stdin` is a readable stream on Node -- a `net.Socket` when fd 0 is
 * a pipe, an `fs.ReadStream` when it is a file, a `tty.ReadStream` when it is
 * a terminal -- and the engine's was a plain object carrying `on` and `pipe`.
 * A program that treats it as one refused it: byline, which Prisma's own code
 * generator reads its JSON-RPC requests through, checks `instanceof
 * stream.Readable` and throws; so does anything that pipes it, iterates it,
 * asks it to `read()`, or waits on 'readable' or 'end'.
 *
 * A tab has no terminal, so the case this models is Node's pipe: the guest's
 * standard input is whatever the shell put on fd 0 -- the text left of a pipe,
 * or `container.run(..., { stdin })` -- and it is complete when the guest
 * starts, so the stream carries those bytes and then ends, exactly as
 * `node script.js < file` does. Where a runner can still feed the guest
 * (a held run the host writes to with `sendStdin`), it leaves the stream open
 * instead, which is Node's pipe whose writer has not closed. A terminal is
 * not invented: `isTTY` stays false unless a runner says otherwise, and there
 * is no `setRawMode` that does anything, because there is no raw mode to set.
 */
/**
 * The guest's fd 0: a `Readable` the engine pushes into.
 *
 * Built the first time a process is made, not when this module is evaluated:
 * `Readable` is Node's own class out of a vendored file, and `extends` reads
 * the superclass at class-definition time, which is before the loader that
 * builds it exists. See `node-lib/lazy.ts`.
 */
export interface ProcessStdin extends Readable {
  readonly fd: number;
  isTTY: boolean;
  setRawMode(mode: boolean): ProcessStdin;
  __substrateStdinWrite(data: string | Uint8Array): void;
  __substrateStdinEnd(): void;
}

// eslint-disable-next-line no-var, vars-on-top
var StdinClasses: WeakMap<object, new () => ProcessStdin> | undefined;
function processStdinClass(ReadableClass: typeof Readable): new () => ProcessStdin {
  StdinClasses ??= new WeakMap();
  const cached = StdinClasses.get(ReadableClass);
  if (cached) return cached;
  const StdinClass = class ProcessStdin extends (ReadableClass as unknown as new () => Readable) {
    /** Node's fd for standard input. */
    readonly fd = 0;

    /** Node's `Readable` asks for this; the engine pushes, so there is nothing to pull. */
    _read(): void {}
    /** False: there is no terminal in a tab. A runner that drives an interactive program sets it. */
    isTTY = false;

    /** Node's `tty.ReadStream.setRawMode`, which a tab has no terminal to put in raw mode. */
    setRawMode(_mode: boolean): this {
      return this;
    }

    /** Bytes arrived on the guest's fd 0. */
    __substrateStdinWrite(data: string | Uint8Array): void {
      if (data === undefined || data === null || (typeof data === 'string' && data.length === 0)) return;
      this.push(data);
    }

    /** Whatever was writing to the guest's fd 0 closed: the stream ends. */
    __substrateStdinEnd(): void {
      this.push(null);
    }
  } as unknown as new () => ProcessStdin;
  StdinClasses.set(ReadableClass, StdinClass);
  return StdinClass;
}

type ProcessReadableStream = ProcessStdin;

export interface Process {
  env: ProcessEnv;
  title: string;
  cwd: () => string;
  chdir: (directory: string) => void;
  platform: string;
  version: string;
  versions: { node: string; v8: string; uv: string; webcontainer?: string; openssl?: string };
  arch?: string;
  argv: string[];
  argv0: string;
  execPath: string;
  execArgv: string[];
  /** Node's `process.config`: how the binary was built. */
  config: { target_defaults: Record<string, unknown>; variables: Record<string, unknown> };
  /** Node's `process.features`: what the binary was built with. */
  features: Record<string, boolean | string | undefined>;
  /**
   * Node's `process.moduleLoadList`: every builtin this process has loaded,
   * in the order it first loaded each, as `NativeModule <id>`. A program reads
   * it to tell whether a module is already in memory before it does something
   * that would pull it in; Node's own tests read it that way.
   */
  moduleLoadList: string[];
  /**
   * Node's uncaught-exception capture pair. A program that sets a callback
   * takes every uncaught exception instead of the `uncaughtException` event,
   * and `domain` asks whether one is set before it installs its own handling.
   */
  setUncaughtExceptionCaptureCallback: (callback: ((error: unknown) => void) | null) => void;
  hasUncaughtExceptionCaptureCallback: () => boolean;
  /** Node's `process.umask()`: the file-mode mask this process creates with. */
  umask: (mask?: number | string) => number;
  pid: number;
  ppid: number;
  exit: (code?: number) => never;
  /** What a script that returned without calling `exit` exits with. */
  exitCode?: number;
  /** Node's `process.kill`, raising a signal on the guest's own process. */
  kill: (pid: number, signal?: string | number) => boolean;
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
  /** Node's deprecated `process.binding`, which bundles still feature-detect through. */
  binding: (name: string) => unknown;
  /** Node's deprecated `process.assert`: assert.ok. */
  assert: (value: unknown, message?: string) => void;
  /** Node's `process.emitWarning`, which fs-extra calls on its way into every
   *  React Router build; a warning goes to stderr the way Node prints one. */
  emitWarning: (warning: string | Error, ...rest: unknown[]) => void;
  stdout: ProcessWritableStream;
  stderr: ProcessWritableStream;
  stdin: ProcessReadableStream;
  hrtime: {
    (time?: [number, number]): [number, number];
    bigint: () => bigint;
  };
  memoryUsage: () => { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  /** Node's `process.constrainedMemory`: a cgroup's limit, 0 when there is none. */
  constrainedMemory: () => number;
  /** Node's `process.availableMemory`: the memory still free, from the same place `os.freemem` reads. */
  availableMemory: () => number;
  uptime: () => number;
  cpuUsage: () => { user: number; system: number };
  // EventEmitter methods
  on: (event: string, listener: EventListener) => Process;
  once: (event: string, listener: EventListener) => Process;
  off: (event: string, listener: EventListener) => Process;
  emit: (event: string, ...args: unknown[]) => boolean;
  addListener: (event: string, listener: EventListener) => Process;
  removeListener: (event: string, listener: EventListener) => Process;
  removeAllListeners: (event?: string) => Process;
  listeners: (event: string) => EventListener[];
  listenerCount: (event: string) => number;
  prependListener: (event: string, listener: EventListener) => Process;
  prependOnceListener: (event: string, listener: EventListener) => Process;
  eventNames: () => (string | symbol)[];
  setMaxListeners: (n: number) => Process;
  getMaxListeners: () => number;
  // IPC support (used by child_process.fork)
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  connected?: boolean;
}

// Helper to create a stream-like object with EventEmitter methods.
// `process.stdout` and `process.stderr` only: `process.stdin` is a real
// readable stream, as Node's is, and is built by `ProcessStdin` above.
function createProcessStream(
  isWritable: boolean,
  writeImpl?: (data: string) => boolean
): ProcessWritableStream {
  const emitter = new EventEmitter();

  const stream: ProcessWritableStream = {
    isTTY: false,
    columns: 80,
    rows: 24,
    clearLine(direction, callback) { if (typeof direction === 'function') direction(); else if (typeof callback === 'function') callback(); return true; },
    cursorTo(x, y, callback) { if (typeof y === 'function') y(); else if (typeof callback === 'function') callback(); return true; },
    moveCursor(dx, dy, callback) { if (typeof callback === 'function') callback(); return true; },
    getWindowSize() { return [80, 24]; },
    hasColors() { return false; },
    getColorDepth() { return 1; },

    on(event: string, listener: EventListener) {
      emitter.on(event, listener);
      return stream;
    },
    once(event: string, listener: EventListener) {
      emitter.once(event, listener);
      return stream;
    },
    off(event: string, listener: EventListener) {
      emitter.off(event, listener);
      return stream;
    },
    emit(event: string, ...args: unknown[]) {
      return emitter.emit(event, ...args);
    },
    addListener(event: string, listener: EventListener) {
      emitter.addListener(event, listener);
      return stream;
    },
    removeListener(event: string, listener: EventListener) {
      emitter.removeListener(event, listener);
      return stream;
    },
    removeAllListeners(event?: string) {
      emitter.removeAllListeners(event);
      return stream;
    },
    setMaxListeners(n: number) {
      emitter.setMaxListeners(n);
      return stream;
    },
    getMaxListeners() {
      return emitter.getMaxListeners();
    },
    listenerCount(event: string) {
      return emitter.listenerCount(event);
    },
    listeners(event: string) {
      return emitter.listeners(event);
    },
    rawListeners(event: string) {
      return emitter.rawListeners(event);
    },
    prependListener(event: string, listener: EventListener) {
      emitter.prependListener(event, listener);
      return stream;
    },
    prependOnceListener(event: string, listener: EventListener) {
      emitter.prependOnceListener(event, listener);
      return stream;
    },
    eventNames() {
      return emitter.eventNames();
    },
    pause() {
      return stream;
    },
    resume() {
      return stream;
    },
    setEncoding(_encoding: string) {
      return stream;
    },
    // Default write implementation (no-op for readable streams)
    write(_data: string | Buffer, ...rest: unknown[]) {
      const callback = trailingCallback(rest);
      if (callback) queueMicrotask(callback);
      return true;
    },
    end(...rest: unknown[]) {
      const callback = trailingCallback(rest);
      if (callback) queueMicrotask(callback);
    },
    pipe(destination: unknown) {
      return destination;
    },
    unpipe() {
      return stream;
    },
    isPaused() {
      return false;
    },
    unshift() {
    },
  };

  // Override write for actual writable streams
  if (isWritable && writeImpl) {
    stream.write = (data: string | Buffer, ...rest: unknown[]) => {
      const result = writeImpl(typeof data === 'string' ? data : data.toString());
      const callback = trailingCallback(rest);
      if (callback) queueMicrotask(callback);
      return result;
    };
    stream.end = (...args: unknown[]) => {
      const data = args[0];
      if (typeof data === 'string') writeImpl(data);
      else if (data instanceof Uint8Array) writeImpl(data.toString());
      const callback = trailingCallback(args);
      if (callback) queueMicrotask(callback);
    };
  }

  return stream;
}

/**
 * Node's `write(chunk[, encoding][, callback])` and `end([chunk][, encoding][, callback])`:
 * the callback is whichever argument is a function. `stdout.write('', done)`
 * is how a program waits for its output to be flushed before it exits, and a
 * callback read only from the third place never ran.
 */
function trailingCallback(args: readonly unknown[]): (() => void) | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const value = args[index];
    if (typeof value === 'function') return value as () => void;
  }
  return undefined;
}

/** The signal numbers a guest sees, and the signals a tab must ignore. */
const __substrateSignals: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGWINCH: 28 };
const __substrateSignalNames: Record<number, string> = Object.fromEntries(Object.entries(__substrateSignals).map(([name, number]) => [number, name]));
// Node prints the `process.binding` deprecation once per process; the engine
// runs many guests in one realm, so the record is per guest, not per load.
const __substrateBindingWarned = new WeakSet<object>();
const __substrateIgnoredSignals = new Set(["SIGCHLD", "SIGCONT", "SIGURG", "SIGWINCH"]);

/**
 * The guest's children are processes it can see. `process.kill(pid, 0)`
 * answered ESRCH for every pid but the guest's own, so a program that keeps its
 * children's pids and asks whether they still run judged every live child dead.
 * src/shims/child_process.ts fills this table as it spawns.
 */
export const __substrateChildren = new Map<number, { exitCode: number | null; signalCode: string | null; kill(signal?: string): boolean }>();

/**
 * A guest's `process.version` is the version its image names. The engine said
 * v20.0.0 to every guest, and Astro refused to build under it, asking for
 * 22.12; the `node` image sets `NODE_VERSION` in its environment and the guest
 * reports that version, or the current LTS where nothing named one. What the
 * rest of `versions` says is `src/node-lib/node-versions.ts`.
 */
function __browserRuntimeNodeVersion(env: { NODE_VERSION?: string }): string {
  const named = env && typeof env.NODE_VERSION === "string" ? env.NODE_VERSION.replace(/^v/, "") : "";
  return /^\d+\.\d+\.\d+$/.test(named) ? named : NODE_LTS_VERSION;
}
/** The file-mode mask a guest has set, Node's own default until it sets one. */
let __substrateUmask = 0o022;

/**
 * Where an exception nobody caught goes: the process it happened in.
 *
 * Node hands an exception no `try` caught to that process — its
 * `uncaughtException` listeners, else the stack on its stderr and that
 * process exiting 1 — and no other process hears it. The engine ran a guest's
 * callbacks on the realm's own loop, so a `throw` from a guest's timer left
 * the guest's frames entirely and reached the realm's global `error` event; in
 * the tab that realm is a worker, and the substrate's container reads a worker
 * error as a dead host and disposes it. openvscode-server's extension host,
 * and every other program in the tab, died of one guest's uncaught throw.
 *
 * The `node` command records a run's report here, because only it holds that
 * run's stderr and its guarded exit; the callers are the places a guest's
 * callback is entered from the loop.
 */
const __substrateUncaughtReports = new WeakMap<object, (error: unknown) => void>();

/** Record how a running program reports an exception nobody caught; answers a release. */
export function __onUncaughtException(process: object, report: (error: unknown) => void): () => void {
  __substrateUncaughtReports.set(process, report);
  return () => { if (__substrateUncaughtReports.get(process) === report) __substrateUncaughtReports.delete(process); };
}

/**
 * Report an exception as the named process's own. False when no program owns
 * it — the engine imported as a library into a Node host, where the host's own
 * failure reporting is the right one and the caller rethrows.
 */
export function __reportUncaughtException(process: object | null | undefined, error: unknown): boolean {
  const report = process ? __substrateUncaughtReports.get(process) : undefined;
  if (!report) return false;
  report(error);
  return true;
}

/**
 * An exit code as Node takes one. `process.exit(process.argv[2])` is how a
 * script takes its code from its command line, and argv is strings: Node
 * coerces, so `process.exit("23")` exits 23. The engine passed the string
 * through and a parent watching for `code === 23` was handed `"23"`.
 * Undefined and null mean 0, and a value no number can be made of is 0 too.
 */
/**
 * The callback a program set to take every uncaught exception, which is what
 * `process.setUncaughtExceptionCaptureCallback` installs. The engine's
 * uncaught door asks for it before it looks for listeners, as Node does.
 */
// eslint-disable-next-line no-var, vars-on-top
var __substrateCaptureCallback: ((error: unknown) => void) | null = null;
export function __substrateUncaughtCapture(): ((error: unknown) => void) | null {
  return __substrateCaptureCallback;
}

export function __substrateExitCode(code: unknown): number {
  if (code === undefined || code === null) return 0;
  const asNumber = Number(code);
  return Number.isNaN(asNumber) ? 0 : asNumber;
}

export function createProcess(options?: {
  cwd?: string;
  env?: ProcessEnv;
  /** This process's own number and its parent's, as Node gives every process. */
  pid?: number;
  ppid?: number;
  onExit?: (code: number) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /** What the runner put on the guest's fd 0, as a shell puts the left of a pipe there. */
  stdin?: string;
  /**
   * The runner can still write to the guest's fd 0 (a held run fed with
   * `sendStdin`), so standard input does not end when the guest starts. Node's
   * pipe whose writer has not closed: the stream stays open and empty.
   */
  stdinHeld?: boolean;
  /**
   * The run was given a TTY. A pipe (a spawned child, a cell that is not
   * held) is not one: Node does not inherit FORCE_COLOR onto a pipe, and
   * `util.inspect` of an Error would colorize a stack and then ask
   * `BuiltinModule.exists` of every `node:` frame.
   */
  tty?: boolean;
}): Process {
  let currentDir = options?.cwd || '/';
  // Node sets no NODE_ENV and neither does the `node` image, so an app that
  // reads it to choose its shape took its development path under a Dockerfile
  // that never asked for it. A guest sees NODE_ENV only where the image, the
  // Dockerfile, or the command set it.
  const env: ProcessEnv = {
    // The engine's shell reads a project's own binaries from
    // `/node_modules/.bin`, and a child a guest spawns is started with the
    // guest's environment, not the shell's: a PATH that left the directory out
    // meant `spawn('vite')` found nothing that `npm run dev` finds.
    PATH: '/usr/local/bin:/usr/bin:/bin:/node_modules/.bin',
    HOME: '/',
    ...options?.env,
  };
  // A run that was not given a TTY is a pipe. The host's FORCE_COLOR would
  // make `util.inspect` colorize `console.log(6)` on that pipe; Node does
  // not, and a cell that printed a number would wrap it in CSI 33m. stdin
  // being held open is a pipe whose writer has not closed, not a TTY --
  // child_process tests hand pipes to children that way.
  if (!options?.tty) {
    delete env.FORCE_COLOR;
  }

  // Create an EventEmitter for process events
  const emitter = new EventEmitter();
  const startTime = Date.now();
  // The guest's fd 0: the bytes the runner put there, then the end of them.
  // Nothing more can arrive unless the runner says it holds the input open.
  let stdinStream: ProcessStdin | undefined;

  const proc: Process = {
    env,
    // Node exposes a writable title even before application code sets it.
    // Packages use its presence when distinguishing Node from a browser.
    title: 'node',

    cwd() {
      return currentDir;
    },

    chdir(directory: string) {
      console.log('[process] chdir called:', directory, 'from:', currentDir);
      if (!directory.startsWith('/')) {
        directory = currentDir + '/' + directory;
      }
      currentDir = directory;
      console.log('[process] chdir result:', currentDir);
    },

    platform: 'linux', // Pretend to be linux for better compatibility
    version: 'v' + __browserRuntimeNodeVersion(env),
    versions: nodeVersions(__browserRuntimeNodeVersion(env)),
    arch: 'x64',

    argv: ['node', '/index.js'],
    argv0: 'node',
    execPath: '/usr/local/bin/node',
    execArgv: [],

    // How the binary was built and what it was built with. Node's own test
    // helper reads `process.config.variables` in its first ten lines and every
    // program behind it died on `undefined`; `features` and `umask` are read
    // next to it. A runtime that is not a build of Node still answers, as one
    // built with nothing optional does.
    config: { target_defaults: {}, variables: { node_shared: false, node_use_openssl: false, v8_enable_i18n_support: 0 } },
    moduleLoadList: [],
    setUncaughtExceptionCaptureCallback(callback: ((error: unknown) => void) | null) {
      if (callback === null) { __substrateCaptureCallback = null; return; }
      if (typeof callback !== 'function') {
        throw Object.assign(new TypeError('The "fn" argument must be of type function or null.'), { code: 'ERR_INVALID_ARG_TYPE' });
      }
      if (__substrateCaptureCallback !== null) {
        throw Object.assign(new Error('`process.setUncaughtExceptionCaptureCallback()` was called while a capture callback was already active'), { code: 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET' });
      }
      __substrateCaptureCallback = callback;
    },
    hasUncaughtExceptionCaptureCallback() { return __substrateCaptureCallback !== null; },
    features: { debug: false, inspector: false, tls: false, cached_builtins: true, ipv6: true, require_module: true, tls_alpn: false, tls_ocsp: false, tls_sni: false, typescript: false, uvwasi: true },
    // The tab's tree carries no mode mask; Node's own default is what a
    // process that has not set one reports, and setting one answers the mask
    // it replaced, as Node's does.
    umask(mask?: number | string) {
      const previous = __substrateUmask;
      if (mask !== undefined) __substrateUmask = typeof mask === 'string' ? parseInt(mask, 8) : mask;
      return previous;
    },

    // Every process has its own number, and `ppid` names the one that
    // started it: `src/process-tokens.ts` says what reads them and what it
    // cost when they were 1 and 0 for everyone.
    pid: options?.pid ?? mintPid(),
    ppid: options?.ppid ?? 0,

    exit(code: number | string | null | undefined = 0) {
      code = __substrateExitCode(code);
      emitter.emit('exit', code);
      if (options?.onExit) {
        options.onExit(code);
      }
      throw new Error(`Process exited with code ${code}`);
    },

    kill(pid: number, signal: string | number = "SIGTERM") {
      const name = (typeof signal === "number" && signal !== 0 ? __substrateSignalNames[signal] : signal) as string;
      if (signal !== 0 && (typeof name !== "string" || __substrateSignals[name] === void 0)) {
        throw Object.assign(new TypeError("Unknown signal: " + signal), { code: "ERR_UNKNOWN_SIGNAL" });
      }
      // A signal to the guest's own pid is raised on its own process object
      // the way Node raises one; its children take theirs through their
      // handles, other live processes of the container through the process
      // registry, and every other pid is ESRCH rather than a silent success.
      if (pid !== proc.pid) {
        const child = __substrateChildren.get(Math.abs(pid));
        if (child === void 0 || child.exitCode !== null || child.signalCode !== null) {
          // Signal 0 is the question "is that process there?", and a program
          // asks it about processes that are not its own children: a pid out
          // of a lock file, a parent's. A live run answers yes and carries no
          // signal; anything else is `ESRCH`, as it is on a machine.
          if (signal === 0 && pidIsLive(Math.abs(pid))) return true;
          // Any other live process of the container takes the signal too,
          // including one whose parent has exited; otherwise nothing could
          // ever end it.
          if (signal !== 0 && child === void 0 && pid > 0 && signalPid(pid, name)) return true;
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", errno: -3, syscall: "kill" });
        }
        if (signal === 0) return true;
        child.kill(name);
        return true;
      }
      if (signal === 0) return true;
      if (name !== "SIGKILL" && name !== "SIGSTOP" && emitter.listenerCount(name) > 0) {
        emitter.emit(name, name);
        return true;
      }
      if (__substrateIgnoredSignals.has(name)) return true;
      __recordTermination(proc as never, name);
      proc.exit(128 + __substrateSignals[name]);
      return true;
    },

    /**
     * `process.binding(name)` is a function on Node, deprecated since v10.9
     * and still there, and a bundle that feature-detects through it reads it
     * before it reads anything public: the Prisma CLI asks for `constants`,
     * `buffer` and `tty_wrap` on its way in. The engine had no such function,
     * so the call was `undefined is not a function` -- a TypeError where Node
     * answers. `constants` is the one binding a tab can serve honestly, and it
     * is the engine's own table, the same numbers `require("constants")` hands
     * out; every other name gets the error Node raises for a module it does
     * not have, because a binding a tab cannot back is a surface that answers
     * and then cannot act. Node prints the DEP0111 warning only under
     * `--pending-deprecation`, and only once, so this does the same.
     */
    binding(name: string): unknown {
      if (!__substrateBindingWarned.has(proc) && (proc.execArgv || []).includes("--pending-deprecation")) {
        __substrateBindingWarned.add(proc);
        proc.emitWarning("process.binding() is deprecated. Please use public APIs instead.", "DeprecationWarning", "DEP0111");
      }
      if (name === "constants") return constantsBinding();
      if (name === "tty_wrap") return ttyWrapBinding;
      throw new Error("No such module: " + name);
    },

    nextTick(callback, ...args) {
      const run = typeof globalThis.__substrateCarried === "function" ? globalThis.__substrateCarried(callback) : callback;
      // A throw from a tick callback is this process's uncaught exception in
      // Node. Out of a microtask it would be the realm's instead, and in the
      // tab the worker's, which the substrate takes for a dead host.
      queueMicrotask(() => {
        try { run(...args); }
        catch (error) { if (!__reportUncaughtException(proc, error)) throw error; }
      });
    },

    // Node's `process.assert`, deprecated (DEP0100) and still exported: assert.ok.
    assert(value: unknown, message?: string) {
      if (value) return;
      const error = new Error(message === undefined ? 'assertion error' : String(message));
      error.name = 'AssertionError';
      (error as Error & { code?: string }).code = 'ERR_ASSERTION';
      throw error;
    },

    emitWarning(warning, ...rest) {
      const text = warning instanceof Error ? warning.message : String(warning);
      const options = rest[0] && typeof rest[0] === 'object' ? (rest[0] as { type?: string; code?: string }) : undefined;
      const type = typeof rest[0] === 'string' ? rest[0] : options?.type ? options.type : 'Warning';
      const printedCode = typeof rest[1] === 'string' ? rest[1] : options?.code;
      // Node prints an Error warning under its own `name`, and names the code
      // in brackets before it: `(node:123) [MYCODE] MyWarning: a message`. The
      // engine printed the computed type and dropped the code, so a warning
      // that carried either lost it.
      const printedType = warning instanceof Error ? warning.name : type;
      const line = '(node) ' + (printedCode === undefined ? '' : '[' + printedCode + '] ') + printedType + ': ' + text + '\n';
      if (this && this.stderr && typeof this.stderr.write === 'function') this.stderr.write(line);
      else console.warn(line);
      // Node raises the warning as an Error on the process's 'warning' event on
      // the next tick, which is how a program (and Node's own test helper,
      // `common.expectWarning`) observes it; the engine only printed it.
      const code = printedCode;
      const raised = warning instanceof Error ? warning : Object.assign(new Error(text), { name: type as string }, code === undefined ? {} : { code });
      queueMicrotask(() => { emitter.emit('warning', raised); });
    },

    stdout: createProcessStream(true, (data: string) => {
      if (options?.onStdout) {
        options.onStdout(data);
      } else {
        console.log(data);
      }
      return true;
    }) as ProcessWritableStream,

    stderr: createProcessStream(true, (data: string) => {
      if (options?.onStderr) {
        options.onStderr(data);
      } else {
        console.error(data);
      }
      return true;
    }) as ProcessWritableStream,

    get stdin() {
      if (!stdinStream) {
        stdinStream = new (processStdinClass(loadNodeLibFor(proc, 'stream').Readable))();
        if (typeof options?.stdin === 'string') stdinStream.__substrateStdinWrite(options.stdin);
        if (!options?.stdinHeld) stdinStream.__substrateStdinEnd();
      }
      return stdinStream;
    },

    hrtime: Object.assign(
      function hrtime(time?: [number, number]): [number, number] {
        const now = performance.now();
        const seconds = Math.floor(now / 1000);
        const nanoseconds = Math.floor((now % 1000) * 1e6);
        if (time) {
          const diffSeconds = seconds - time[0];
          const diffNanos = nanoseconds - time[1];
          return [diffSeconds, diffNanos];
        }
        return [seconds, nanoseconds];
      },
      {
        bigint: (): bigint => BigInt(Math.floor(performance.now() * 1e6)),
      }
    ),

    memoryUsage() {
      // Return mock values since we can't access real memory in browser
      return {
        rss: 50 * 1024 * 1024,
        heapTotal: 30 * 1024 * 1024,
        heapUsed: 20 * 1024 * 1024,
        external: 1 * 1024 * 1024,
        arrayBuffers: 0,
      };
    },

    /**
     * Node's `process.constrainedMemory`, which reports a cgroup's limit on
     * the process and returns 0 when there is none. A tab is not in a cgroup,
     * so 0 is both Node's own answer for an unconstrained process and the
     * truthful one here. A library that sizes a pool from it already has to
     * handle 0, because that is what it reads on any ordinary machine.
     */
    constrainedMemory(): number {
      return 0;
    },

    /**
     * Node's `process.availableMemory`, the memory still free to the process.
     * It answers from `os.freemem` so the engine has one answer about memory
     * rather than two that can drift: a guest that asks the operating system
     * and a guest that asks its own process must not be told different things.
     */
    availableMemory(): number {
      return osFreemem();
    },

    uptime() {
      return (Date.now() - startTime) / 1000;
    },

    cpuUsage() {
      return { user: 0, system: 0 };
    },

    // EventEmitter methods - delegate to emitter but return proc for chaining
    on(event: string, listener: EventListener): Process {
      emitter.on(event, listener);
      return proc;
    },

    once(event: string, listener: EventListener): Process {
      emitter.once(event, listener);
      return proc;
    },

    off(event: string, listener: EventListener): Process {
      emitter.off(event, listener);
      return proc;
    },

    /**
     * A listener on this process is called with THIS process as `this`, as
     * Node's is: `process` IS the emitter there, where here it holds one.
     * Node's own `setupChannel` keeps a child's IPC channel on a symbol of the
     * process object and reads it back off `this` inside an `internalMessage`
     * listener; called with the held emitter instead, it found no channel and
     * a socket sent to the child arrived at nothing.
     */
    emit(event: string, ...args: unknown[]): boolean {
      const listeners = emitter.listeners(event);
      if (listeners.length === 0) return emitter.emit(event, ...args);
      for (const listener of listeners) {
        try { listener.apply(proc, args); }
        catch (error) { console.error('Error in event listener:', error); }
      }
      return true;
    },

    addListener(event: string, listener: EventListener): Process {
      emitter.addListener(event, listener);
      return proc;
    },

    removeListener(event: string, listener: EventListener): Process {
      emitter.removeListener(event, listener);
      return proc;
    },

    removeAllListeners(event?: string): Process {
      emitter.removeAllListeners(event);
      return proc;
    },

    listeners(event: string): EventListener[] {
      return emitter.listeners(event);
    },

    listenerCount(event: string): number {
      return emitter.listenerCount(event);
    },

    prependListener(event: string, listener: EventListener): Process {
      emitter.prependListener(event, listener);
      return proc;
    },

    prependOnceListener(event: string, listener: EventListener): Process {
      emitter.prependOnceListener(event, listener);
      return proc;
    },

    eventNames(): (string | symbol)[] {
      return emitter.eventNames();
    },

    setMaxListeners(n: number): Process {
      emitter.setMaxListeners(n);
      return proc;
    },

    getMaxListeners(): number {
      return emitter.getMaxListeners();
    },
  };

  return proc;
}

// There is no default process: a process is made for a run, by the `node`
// command, and making one when this module is evaluated built the guest's
// `stdin` -- a `Readable` out of a vendored Node file -- before the loader
// that builds Node's streams existed. Nothing read it.
