/**
 * The engine's process model: what a run of a program IS here.
 *
 * `child_process` itself is Node's own file now, vendored in
 * `src/node-lib/child_process.js` and loaded over the binding in
 * `src/node-lib/binding/`. What is left here is everything that file does not
 * own and cannot know: the `node` command -- a guest program running as a run
 * of the engine, with its own process, its own timers, its own uncaught
 * exceptions and its own idea of when it is done -- the routing of a command
 * line to the host's process host or to the engine's shell, the streams and
 * the name a host gives one run, and the rule that decides a quiet program is
 * finished.
 *
 * `Process.spawn` in the binding reaches all of it through the one door
 * installed at the bottom of `initChildProcess`.
 */

// Polyfill process for just-bash (it expects Node.js environment)
if (typeof globalThis.process === 'undefined') {
  (globalThis as any).process = {
    env: {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    cwd: () => '/',
    platform: 'linux',
    version: 'v18.0.0',
    versions: { node: '18.0.0' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}

import { forGuestRealm, heldWork } from '../host-globals';
import { promiseOwner } from '../promise-ownership';
import { Bash, defineCommand } from 'just-bash';
import type { CommandContext, ExecResult as JustBashExecResult } from 'just-bash';
import { EventEmitter } from '../node-lib/events-module';
import { __substrateExitCode, __substrateUncaughtCapture } from './process';
import { Buffer } from '../node-lib/buffer-module';
import type { VirtualFS } from '../virtual-fs';
import { treeDescriptorsOf } from '../tree-descriptors';
import { VirtualFSAdapter } from './vfs-adapter';
import { __releaseOwnedServers, __ownedServerPorts } from '../node-lib/net-module';
import { __ownedHandleCount, __releaseOwnedHandles } from '../node-lib/net-module';
import { setProcessRunner, type RunRequest, type StartedRun } from '../node-lib/binding/process_wrap';
import { registerRunFd, releaseRunFds, inheritedRunFds } from '../node-lib/binding/fds';
import { StdinRingReader, kStdinRing } from '../stdin-ring';
import { nodeProcessHostFor, nodeProcessHostInstalled, nodeProcessRealmToken, nodeProcessInput, type NodeProcessHost, type NodeProcessLaunch } from '../node-process-host';
import { nativeStreamDescriptor } from '../native-stream-binding';
import { Pipe, constants as pipeConstants } from '../node-lib/binding/pipe_wrap';
import {
  WriteWrap, ShutdownWrap, streamBaseState, kReadBytesOrError, kArrayBufferOffset,
  type LibuvStreamWrap,
} from '../node-lib/binding/stream_wrap';
import { UV_ESRCH } from '../node-lib/binding/uv';
import { loadNodeLibFor } from '../node-lib/load';
import type { ChildProcessModule } from '../node-lib/child-process-module';
import { getCommandNames } from 'just-bash';
import { __substrateExecPath, __substrateProgramName, __substrateLineFor, __substrateArgvFor, __substrateShellLine, __substrateRunsNode, setProgramResolver, setHostRunsProgram } from './command-line';

import { __substrateChildrenOf, __onUncaughtException, __reportUncaughtException, __substrateSignalNames } from './process';

import { PROCESS_TOKEN_ENV, __recordRun, __runFor, __currentProcessToken, __stopOwnedProcess, enterRun, mintPid, setRunPid, claimRunPid, runPid, forgetRunPid, exitRunProcess, reapRunProcess, signalPid, installRunRegistry, type ProcessToken } from '../process-tokens';
import type { ProcessRegistry } from '../process-registry';
/** The host's own `process`, where it has one that emits, taken as the shim loads and before any guest's takes the global name. */
const __hostProcess: { on(event: string, listener: (reason: unknown) => void): unknown; off(event: string, listener: (reason: unknown) => void): unknown } | null =
  typeof process !== 'undefined' && process !== null && typeof (process as { on?: unknown }).on === 'function' && typeof (process as { off?: unknown }).off === 'function'
    ? (process as { on(event: string, listener: (reason: unknown) => void): unknown; off(event: string, listener: (reason: unknown) => void): unknown })
    : null;
import { Runtime, pendingGuestTimers, stopGuestTimers, __substratePendingOf } from '../runtime';
import { __nodeResolverFor } from '../node-resolver';
import { resolve as __resolvePath } from './path';
import { setSyncChildVfs, warmSyncChild } from './sync-child';
import { installShellJobs } from './shell-jobs';
import { unstreamedOutput } from './streamed-output';
import type { PackageJson } from '../types/package-json';

// Capture host capabilities before the guest's authority is restricted. These
// endpoints are private, carry no guest bytes, and close at each checkpoint.
const HostBroadcastChannel = globalThis.BroadcastChannel;
const hostChannelName = globalThis.crypto?.randomUUID.bind(globalThis.crypto);
const isWorkerRealm = typeof (globalThis as Record<string, unknown>).WorkerGlobalScope !== 'undefined';

async function settlePrintedEntry(): Promise<void> {
  await new Promise<void>(resolve => (globalThis.__browserRuntimeNativeSetTimeout ?? setTimeout).call(globalThis, resolve, 0));
  if (!isWorkerRealm || nodeProcessRealmToken() === null) return;
  if (!HostBroadcastChannel || !hostChannelName) throw new Error('Native process rejection checkpoint is unavailable.');
  // HTML queues rejection reporting after the microtask checkpoint on the
  // DOM manipulation task source. A timer alone can overtake that report.
  // BroadcastChannel uses the same source, ordering this acknowledgment
  // behind reports already queued before the timer turn above.
  const name = hostChannelName();
  const receiver = new HostBroadcastChannel(name);
  try {
    const sender = new HostBroadcastChannel(name);
    try {
      await new Promise<void>((resolve, reject) => {
        receiver.onmessage = () => resolve();
        receiver.onmessageerror = () => reject(new Error('Native process rejection checkpoint failed.'));
        sender.postMessage(null);
      });
    } finally { sender.close(); }
  } finally { receiver.close(); }
}

// Singleton bash instance - uses VFS adapter for two-way file sync
let bashInstance: Bash | null = null;
let vfsAdapter: VirtualFSAdapter | null = null;
let currentVfs: VirtualFS | null = null;
/**
 * One shell per tree. Two `createContainer` calls in one realm used to share
 * this module's `currentVfs` and `bashInstance`, so the first container's
 * `node /main.cjs` ran on the second's tree and printed SECOND. The first
 * tree still occupies `currentVfs` / `bashInstance` until a second arrives.
 */
const shells = new WeakMap<VirtualFS, { bash: Bash; adapter: VirtualFSAdapter }>();
let processRunnerInstalled = false;

/** The tree of the guest whose code is executing, else the last tree given to the engine. */
function treeForRun(): VirtualFS | null {
  // Same symbol Runtime hangs the tree on; named here so this file does not
  // import the fs binding (that import put constantsBinding in the
  // consumer bundle's cycle with crypto).
  const realm = globalThis as unknown as { process?: Record<symbol, unknown> };
  const found = realm.process?.[Symbol.for('tabnode.run.vfs')] as VirtualFS | undefined;
  return found ?? currentVfs;
}

function shellOf(tree: VirtualFS | null | undefined): { bash: Bash; adapter: VirtualFSAdapter } | null {
  if (tree) {
    const owned = shells.get(tree);
    if (owned) return owned;
  }
  return bashInstance && vfsAdapter ? { bash: bashInstance, adapter: vfsAdapter } : null;
}

// Track active forked child processes so the node command can detect when children exit.
// When the last child exits, the node command uses a shorter idle timeout.
let _activeForkedChildren = 0;
let _onForkedChildExit: (() => void) | null = null;

// Patch Object.defineProperty globally to force configurable: true on globalThis properties.
// In real Node.js, each process has its own globalThis. In our browser environment,
// all forks share globalThis, so libraries like vitest that define non-configurable
// properties (e.g. __vitest_index__) need them to be configurable for re-runs.
const _realDefineProperty = Object.defineProperty;
Object.defineProperty = function(target: object, key: PropertyKey, descriptor: PropertyDescriptor): object {
  if (target === globalThis && descriptor && !descriptor.configurable) {
    descriptor = { ...descriptor, configurable: true };
  }
  return _realDefineProperty.call(Object, target, key, descriptor) as object;
} as typeof Object.defineProperty;

/** The stdin of a held run's guest, as the run's own. */
type RunStdin = {
  emit: (event: string, ...args: unknown[]) => void;
  push: (chunk: string | Uint8Array | null) => boolean;
  /** A hosted sink acknowledges consumption before another pipe read. */
  writeAsync?: (chunk: string | Uint8Array | null) => Promise<void>;
};

/**
 * What a host gave one run: where its output goes, the handle that aborts it,
 * whether the host holds it open, and — while it lasts — its guest's stdin.
 *
 * This is per run and never a module global. A child a guest spawns is a
 * second run on the same engine, so a global here meant the later run took the
 * earlier one's stream, its signal and its stdin: a trivial child was read as
 * a watch (it arrived with an abort handle) and never ended, and its parent's
 * output went down the child's channel.
 */
/** Node options whose value may follow as the next word (`-r ./hook.js`, `--import tsx`). */
const NODE_VALUE_OPTIONS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title',
  '--inspect-port', '--debug-port', '--env-file', '--env-file-if-exists', '--redirect-warnings', '--diagnostic-dir',
  '--report-dir', '--report-directory', '--cpu-prof-dir', '--heap-prof-dir', '--experimental-default-type', '--watch-path',
  '--disable-warning', '--secure-heap', '--secure-heap-min', '--icu-data-dir', '--openssl-config', '--tls-cipher-list',
  '--unhandled-rejections', '--dns-result-order', '--trace-event-categories', '--trace-event-file-pattern',
]);

/**
 * What a run's standard fd is: a terminal, a pipe, a file (a `<` or `>`
 * redirect), or a character device that is not a terminal (`/dev/null`).
 */
export type StdioKind = 'tty' | 'pipe' | 'file' | 'char';

export interface RunStreams {
  stdinStream?: AsyncIterable<Uint8Array>;
  /** fd 0 as a shared ring a host writes from another thread (`stdin-ring.ts`); where given, fd 0's only source. */
  stdinShared?: SharedArrayBuffer;
  terminal?: { columns: number; rows: number; onResize?: (listener: (columns: number, rows: number) => void) => () => void };
  /** Which of fds 0, 1 and 2 is a terminal; absent, a held or terminal run is a terminal on all three. */
  stdioIsTTY?: readonly [boolean, boolean, boolean];
  /** What each of fds 0, 1 and 2 is; where given it decides, and `stdioIsTTY` is not read. */
  stdioKind?: readonly [StdioKind, StdioKind, StdioKind];
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /** fd 1 and fd 2 as the bytes the program wrote; where given, that fd is neither decoded nor kept as text. */
  onStdoutBytes?: (bytes: Uint8Array) => void;
  onStderrBytes?: (bytes: Uint8Array) => void;
  signal?: AbortSignal;
  /** The host keeps this run open; a run that is not held ends when its loop has nothing left. */
  held: boolean;
  /**
   * The run's fd 0 has a writer that has not closed it. A held run's prompt is
   * one; a spawned child whose `stdio[0]` is a pipe is the other, and its
   * writer is the parent, which may write long after the child has started.
   * Without it the child's standard input ended before the first write.
   */
  stdinOpen?: boolean;
  stdin?: RunStdin | null;
  /**
   * The run's fd 2 is a pipe the parent holds, not the host's own stdio and
   * not inherit. A run that ends uncaught or by `process.exit` with a
   * nonzero code on that pipe writes one line to the host realm's console.
   */
  stderrIsPipe?: boolean;
}

/**
 * The runs in flight, in the order they started. `container.run` registers one
 * before exec and releases it when the run ends.
 */
const _runStreams = new Map<ProcessToken, RunStreams>();

/** Submit before returning to a spawning parent; completion remains async. */
async function runHostedNode(host: NodeProcessHost, launch: Omit<NodeProcessLaunch, 'identity' | 'inherited' | 'stdinStream'>): Promise<CommandOutcome> {
  const { token, streams } = launch;
  // A run not yet numbered is forked here, and its end is reaped here: the run's end is its parent's wait.
  const forked = !runPid(token);
  if (forked) setRunPid(token, mintPid(), 0, { argv: [launch.argv0, ...launch.argv], cwd: launch.cwd });
  const own = runPid(token)!;
  let input: ReturnType<typeof nodeProcessInput> | undefined;
  let ran = false;
  try {
    streams?.signal?.throwIfAborted();
    const inherited = inheritedRunFds(token).map(({ fd, handle }) => {
      const descriptor = nativeStreamDescriptor(handle as LibuvStreamWrap);
      if (!descriptor) throw new Error(`Node descriptor ${fd} has no native owner for process isolation.`);
      return { fd, handle: descriptor };
    });
    input = nodeProcessInput(streams);
    // An fd the host streamed through its byte sink is whole already: its
    // total is empty by the host's contract, and is never replayed. The host
    // is handed this run's streams with the byte sinks watched; every other
    // field, and the run's stdin accessor, is the run's own by delegation. A
    // nested child shares its parent's streams object, so it is not changed.
    let bytesOut = false;
    let bytesErr = false;
    const watched = streams === undefined ? undefined : Object.create(streams, {
      ...(streams.onStdoutBytes ? { onStdoutBytes: { value: (bytes: Uint8Array) => { bytesOut = true; streams.onStdoutBytes!(bytes); } } } : {}),
      ...(streams.onStderrBytes ? { onStderrBytes: { value: (bytes: Uint8Array) => { bytesErr = true; streams.onStderrBytes!(bytes); } } } : {}),
    }) as RunStreams;
    const result = await host.run({ ...launch, ...(watched ? { streams: watched } : {}), identity: { ...runPid(token)! }, inherited,
      ...(input.stream ? { stdinStream: input.stream } : {}) });
    ran = true;
    // The host's realm ran it and reported its exit; the end is the one the process table holds.
    const ended = forked ? reapRunProcess(own.pid, own.ppid, result.exitCode, result.signal ?? null) : undefined;
    return { ...result, stdout: bytesOut ? '' : result.stdout, stderr: bytesErr ? '' : result.stderr,
      ...(ended ? { exitCode: ended.code, ...(ended.signal ? { signal: ended.signal } : {}) } : {}) };
  } finally {
    // A run the host failed to run (the runtime's failure, thrown to the caller) is killed, and reaped.
    if (forked && !ran) { exitRunProcess(own.pid, own.ppid, 0, 'SIGKILL'); reapRunProcess(own.pid, own.ppid, 0, 'SIGKILL'); }
    if (streams) streams.stdin = null;
    input?.dispose();
    // Adoption moves owner registration; only the source-local lookup remains.
    forgetRunPid(token);
  }
}

/**
 * One line on the host realm's console when a run the tab owns dies and
 * nobody is reading its stderr.
 *
 * Node prints an uncaught exception to that process's stderr. A parent that
 * pipes the fd and drops it — openvscode-server pipes the extension host
 * into `@vscode/spdlog`, a native module that does not load — loses the
 * reason, in Node too. The child's stderr still goes to its parent; this
 * is the one extra line the host realm can say, because the tab owns the
 * run. Inherit and the host's own stdio already show the reason and get
 * no duplicate. Article 6.
 */
function writePipedEndReceipt(
  pid: number,
  argv0: string,
  firstArg: string,
  kind: 'uncaught' | number,
  error: unknown,
): void {
  const who = firstArg.length > 0 ? `${argv0} ${firstArg}` : argv0;
  const ended = kind === 'uncaught' ? 'uncaught' : String(kind);
  let detail = '';
  if (error instanceof Error) {
    const stack = error.stack ?? `${error.name}: ${error.message}`;
    const lines = stack.split('\n');
    const head = (lines[0] ?? '').trimEnd();
    let frame = '';
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!.trim();
      if (line.startsWith('at ')) { frame = line; break; }
    }
    detail = frame.length > 0 ? `${head} ${frame}` : head;
  } else if (error !== undefined && error !== null) {
    detail = String(error).split('\n')[0] ?? '';
  }
  console.error(`[run ${pid}] ${who} ended ${ended}${detail.length > 0 ? `: ${detail}` : ''}`);
}

/** Register what the host gave this run, under the run's own name. */
export function registerRunStreams(token: ProcessToken, streams: RunStreams): void {
  _runStreams.delete(token);
  _runStreams.set(token, streams);
}

/** Forget a run that has ended. */
export function releaseRunStreams(token: ProcessToken): void {
  _runStreams.delete(token);
  shellRuns.delete(token);
  hostedNodes.delete(token);
}

/** Runs whose program is a shell or another non-node program: a `node` they run is their child. */
const shellRuns = new Set<ProcessToken>();
/** Runs that are themselves a hosted `node`: a further `node` under them is a child. */
const hostedNodes = new Set<ProcessToken>();

/** A child identity for a `node` a run's shell runs: its own token and pid under the run's, on the run's streams. */
function nestedNodeToken(parentToken: ProcessToken, args: readonly string[], cwd: string | undefined): ProcessToken {
  const token: ProcessToken = `child-${__nextChildRun++}`;
  const parentPid = runPid(parentToken)?.pid ?? 0;
  setRunPid(token, mintPid(parentPid, false, parentToken), parentPid, { argv: ['node', ...args], ...(cwd ? { cwd } : {}) }, parentToken);
  const parentStreams = runStreamsFor(parentToken);
  if (parentStreams) registerRunStreams(token, parentStreams);
  return token;
}

/** What the host gave the named run, while it lasts. */
function runStreamsFor(token: ProcessToken): RunStreams | undefined {
  return _runStreams.get(token);
}

/**
 * Send data to the stdin of one run's guest process.
 * Emits both 'data' and 'keypress' events (vitest uses readline keypress events).
 *
 * With a token, that run's stdin. Without one — the door a host that has no id
 * to give still has — the most recently started run the host holds, which is
 * the prompt a person is typing to; a run nobody holds has no prompt.
 */
export function sendStdin(data: string, token?: ProcessToken): void {
  let target: RunStdin | null | undefined;
  if (typeof token === 'string') {
    target = _runStreams.get(token)?.stdin;
  } else {
    // Insertion order is start order, so the last held run is the last match.
    for (const streams of _runStreams.values()) {
      if (streams.held && streams.stdin) target = streams.stdin;
    }
  }
  if (target) {
    // Bytes on the guest's fd 0 go through `push`, the way a pipe's arriving
    // bytes reach a Node stream: a reader in paused mode, an iterator, or a
    // `pipe` sees them, where a bare `emit('data')` reached only a listener
    // that happened to be in flowing mode.
    target.push(data);
    for (const ch of data) {
      target.emit('keypress', ch, {
        sequence: ch,
        name: ch,
        ctrl: false,
        meta: false,
        shift: false,
      });
    }
  }
}

/**
 * Initialize the child_process shim with a VirtualFS instance
 * Creates a single Bash instance with VirtualFSAdapter for efficient file access
 */
/**
 * The last resort, the way Node's `process._fatalException` is one.
 *
 * A guest's callbacks are entered from the realm's own loop through more doors
 * than the engine wraps — a `setImmediate`, a microtask, a host callback — and
 * an exception out of one of those reaches the realm's global `error` event.
 * In the tab that realm is a worker, and the substrate's container reads a
 * worker error as a dead host and disposes it: one program's throw ended every
 * program in the tab. Such an error still belongs to the program that was
 * running, so it is reported as that program's, and the event is cancelled so
 * the page's `Worker.onerror` never fires. An error with no program to own it
 * is left alone, so the host's own failure reporting still sees it.
 *
 * Only a realm that exists to run guests gets this: registered for the guest
 * realm, and installed in a worker. In a Node host the engine is a library and
 * the host reports its own failures.
 */
let __backstopInstalled = false;
forGuestRealm(() => {
  if (__backstopInstalled) return;
  if (typeof (globalThis as Record<string, unknown>).WorkerGlobalScope === 'undefined') return;
  if (typeof globalThis.addEventListener !== 'function') return;
  __backstopInstalled = true;
  globalThis.addEventListener('error', (event: Event) => {
    // A task's or an owned callback's throw was reported to its own run already (process-tokens.ts); what reaches here
    // is the realm process's own, or the run whose frame is current.
    const token = nodeProcessRealmToken() ?? __currentProcessToken();
    if (token === null) return;
    const raised = event as ErrorEvent;
    const error = raised.error ?? new Error(raised.message || 'uncaught exception');
    if (__runFor(token)?.reportUncaught(error)) event.preventDefault();
  });
});

/**
 * Hears a realm's unhandled promise rejections for the length of a run and
 * answers a detach. A browser realm raises `unhandledrejection` on its
 * global (the default, a console line, is prevented: the run reports it);
 * a Node host has no such event and reports through its own `process`,
 * the one the host had before any guest's took the global name.
 *
 * Both surfaces carry the promise that rejected, and the report is given it:
 * Node's `unhandledRejection` listener is called `(reason, promise)`, and a
 * listener that uses its second argument is ordinary. openvscode-server's
 * own (`out/server-main.js`) keeps the promise and calls `promise.catch` a
 * second later; under an engine that handed it `undefined` every rejection
 * of the server's became `TypeError: Cannot read properties of undefined
 * (reading 'catch')` inside a timer, 59 of them in one boot.
 */
const __listenForUnhandledRejections = (owner: object, report: (reason: unknown, promise?: Promise<unknown>) => void, ownsRealm: boolean): (() => void) => {
  if (typeof globalThis.addEventListener === 'function') {
    const target = globalThis as unknown as EventTarget;
    const listener = (event: Event) => {
      const rejection = event as PromiseRejectionEvent;
      // An admitted process worker has exactly one Node owner. Shared
      // embeddings still require provenance and never broadcast failures.
      if (!ownsRealm && promiseOwner(rejection.promise) !== owner) return;
      event.preventDefault();
      report(rejection.reason, rejection.promise);
    };
    target.addEventListener('unhandledrejection', listener);
    return () => target.removeEventListener('unhandledrejection', listener);
  }
  const host = __hostProcess;
  if (host) {
    const listener = (reason: unknown, promise?: Promise<unknown>) => {
      if (ownsRealm || promiseOwner(promise) === owner) report(reason, promise);
    };
    host.on('unhandledRejection', listener);
    return () => host.off('unhandledRejection', listener);
  }
  return () => {};
};

/** One start of the engine's Node, however it was asked for. */
export interface NodeLaunch {
  /** The whole vector, as `execve` takes it: `argv[0]` is the program's own name (`process.argv0`), and Node's options, the script and its arguments follow. */
  argv: readonly string[];
  cwd: string;
  /** The process's environment, exactly; nothing of the engine's is added. */
  env: Record<string, string>;
  /** Bytes already on fd 0 when the process begins: a shell's text, or a parent's pipe's bytes. */
  stdin?: string | Uint8Array;
  /** The run this process is, or the run whose shell started it; its streams and signal are registered under it. */
  token: ProcessToken | null;
}

/**
 * The engine's Node, started from an argv vector: Node's option parser, the
 * process host's admission where a page installed one, and the guest's
 * bootstrap, its loop and its exit. The shell's `node` command is one caller
 * and a host's `container.runNode` is the other, so a kernel that has already
 * decided to exec `node` reaches the same process a shell line does without a
 * command string being rebuilt from the vector and parsed again by a shell
 * that does not have the program in its tree.
 */
async function launchNode(tree: VirtualFS, launch: NodeLaunch): Promise<CommandOutcome> {
  const args = launch.argv.slice(1);
  // Capture this run's name, streams and cancellation before another Node
  // entry can start. Forks and shell entries reach this same dispatch seam.
  const parentToken = launch.token;
  // A `node` a shell runs is a process of its own unless it is the run
  // itself: the first `node` of a run that is not a shell's child is the
  // run (the CMD `node server.js`, the page's `node -e`), and every other
  // one, a line of a start script, the second command of a `-c` line, a
  // step of a `sh file` child, gets a child token under the run's pid,
  // the run's streams, and its own admission at the host. Admitted under
  // the shell's own token, its exit was read as the shell's: a script
  // ended at its first `node` line with nothing after it (measured
  // 2026-09-28: `sh start.sh` printed its first step and stopped).
  const nested = parentToken !== null && (shellRuns.has(parentToken) || hostedNodes.has(parentToken));
  const runToken = nested ? nestedNodeToken(parentToken!, args, launch.cwd) : parentToken;
  const streams = runToken === null ? undefined : runStreamsFor(runToken);
  const processHost = nodeProcessHostFor(runToken);
  if (processHost && runToken !== null) {
    if (!nested) hostedNodes.add(runToken);
    // A nested node is its parent run's child: the host's realm reports its exit, and its end is the parent's wait.
    const own = nested ? runPid(runToken)! : undefined;
    let ran = false;
    try {
      const result = await runHostedNode(processHost, {
        token: runToken, argv0: launch.argv[0] ?? 'node', argv: [...args], cwd: launch.cwd, filesystem: tree, env: { ...launch.env },
        ...(launch.stdin !== undefined ? { stdin: launch.stdin } : {}), ...(streams ? { streams } : {}),
      });
      ran = true;
      if (!own) return result;
      const ended = reapRunProcess(own.pid, own.ppid, result.exitCode, result.signal ?? null, parentToken);
      return { ...result, exitCode: ended.code, ...(ended.signal ? { signal: ended.signal } : {}) };
    } finally {
      // One the host failed to run (thrown to the caller) is killed, and reaped by its parent.
      if (own && !ran) {
        exitRunProcess(own.pid, own.ppid, 0, 'SIGKILL', parentToken);
        reapRunProcess(own.pid, own.ppid, 0, 'SIGKILL', parentToken);
      }
      if (nested) releaseRunStreams(runToken);
    }
  }

  // Node reads its own options before the script: `node --turbo-fast-api-calls
  // file.js a b` runs file.js with `a b`, and the options it were given are
  // its `execArgv`. Node's own suite spawns children that way, and the
  // engine took the first option for the script and died on
  // "Cannot find module '--turbo-fast-api-calls'".
  //
  // An option may also take its value as the next word (`node --conditions
  // node child.js`); NODE_VALUE_OPTIONS names those, so the option loop
  // consumes the value and the script is the first word after the options,
  // as Node's parser has it. `node missing.js` says which module it cannot
  // find.
  //
  // The path on a `node` command line is a path, and it is resolved as
  // `require` resolves one: the file itself, then `.js`, `.mjs`, `.cjs`,
  // `.json`, then a directory's `package.json` `main` or its `index.js`.
  // `fork` used to do this for itself; `fork` is Node's own file now and
  // hands the module path straight to `node`, so the resolution belongs
  // where a path on a command line is read. Opened literally, the path
  // openvscode-server forks its pty host with, `<server>/out/bootstrap-fork`
  // for the file `bootstrap-fork.js`, was ENOENT and the pty host died at
  // its first fork.
  const execArgv: string[] = [];
  let first = 0;
  // `-e`/`--eval` and `-p`/`--print` carry the program itself as their
  // value: there is no script, and every word after the source is the
  // program's argument. Taken for an option, the source was read as the
  // script's path ("Cannot find module '/workspace/console.log(1+1)'").
  let evaluated: { source: string; print: boolean } | null = null;
  while (first < args.length && args[first]!.startsWith('-') && args[first] !== '-' && args[first] !== '--') {
    const option = args[first]!;
    const inline = /^(--eval|--print)=([\s\S]*)$/.exec(option);
    if (inline) {
      evaluated = { source: inline[2]!, print: inline[1] === '--print' };
      execArgv.push(option);
      first += 1;
      break;
    }
    if (option === '-e' || option === '--eval' || option === '-p' || option === '--print' || option === '-pe') {
      if (first + 1 >= args.length) return { stdout: '', stderr: `node: ${option} requires an argument\n`, exitCode: 9 };
      evaluated = { source: args[first + 1]!, print: option.includes('p') };
      execArgv.push(option, args[first + 1]!);
      first += 2;
      break;
    }
    // An option that takes its value as the next word consumes it here, as Node's option parser does.
    if (NODE_VALUE_OPTIONS.has(option) && first + 1 < args.length) {
      execArgv.push(option, args[first + 1]!);
      first += 2;
      continue;
    }
    execArgv.push(option);
    first += 1;
  }
  if (args[first] === '--') first += 1;
  const resolver = __nodeResolverFor(tree, 'runtime');
  const fileNamed = (word: string): string | null => {
    const requested = __resolvePath(launch.cwd, word);
    const found = resolver.resolve(requested, launch.cwd);
    if (found !== null && tree.existsSync(found)) return found;
    return tree.existsSync(requested) ? requested : null;
  };
  // The script is the first word after the options, as in Node; a later word that happens to name a file is an
  // argument (`node <next-bin> start apps/web` ran the directory apps/web when the bin did not resolve).
  const script = first;
  const resolvedPath: string | null = evaluated === null && args[script] ? fileNamed(args[script]!) : null;
  if (evaluated === null && !args[script]) {
    return { stdout: '', stderr: 'Usage: node <script.js> [args...]\n', exitCode: 1 };
  }
  if (evaluated === null && resolvedPath === null) {
    return { stdout: '', stderr: `Error: Cannot find module '${__resolvePath(launch.cwd, args[script]!)}'\n`, exitCode: 1 };
  }

  let stdout = '';
  let stderr = '';

  // Track whether process.exit() was called
  let exitCalled = false;
  let exitCode = 0;
  let syncExecution = true;
  let exitResolve: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => { exitResolve = resolve; });

  // Helper to append to stdout, also streaming if configured
  // A process that has exited writes nothing more, as Node's cannot: a
  // continuation of the guest that runs on after its exit keeps its output
  // to itself.
  //
  // A host that takes an fd as bytes gets each write's bytes as the program
  // wrote them, as a file or a pipe on that fd would, and nothing of that fd
  // is decoded or kept as text: the run answers it empty. `printed` counts
  // what the program has written on either fd, which is how the loop below
  // tells a program that printed from one still quiet.
  let printed = 0;
  const stdinRing = streams?.stdinShared ? new StdinRingReader(streams.stdinShared) : undefined;
  const stdoutBytes = streams?.onStdoutBytes;
  const stderrBytes = streams?.onStderrBytes;
  const outputEncoder = new TextEncoder();
  // One decoder per fd, streaming: a character whose bytes arrive in two
  // writes reaches a text sink whole.
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const appendStdout = (data: string | Uint8Array) => {
    if (exitCalled) return;
    printed += data.length;
    if (stdoutBytes) { stdoutBytes(typeof data === 'string' ? outputEncoder.encode(data) : data); return; }
    const text = typeof data === 'string' ? data : stdoutDecoder.decode(data, { stream: true });
    stdout += text;
    streams?.onStdout?.(text);
  };
  const appendStderr = (data: string | Uint8Array) => {
    if (exitCalled) return;
    printed += data.length;
    if (stderrBytes) { stderrBytes(typeof data === 'string' ? outputEncoder.encode(data) : data); return; }
    const text = typeof data === 'string' ? data : stderrDecoder.decode(data, { stream: true });
    stderr += text;
    streams?.onStderr?.(text);
  };
  // What each of fds 0, 1 and 2 is. A host that says per fd is taken at its
  // word (`node x > out.log` at a terminal: fd 1 is a file), by kind, else by
  // terminal; a held or terminal run that says neither is a terminal on all
  // three, as it was, and any other run a pipe on all three.
  const stdioKinds: readonly [StdioKind, StdioKind, StdioKind] = streams?.stdioKind
    ?? (streams?.stdioIsTTY
      ? [streams.stdioIsTTY[0] ? 'tty' : 'pipe', streams.stdioIsTTY[1] ? 'tty' : 'pipe', streams.stdioIsTTY[2] ? 'tty' : 'pipe']
      : streams?.held || streams?.terminal ? ['tty', 'tty', 'tty'] : ['pipe', 'pipe', 'pipe']);
  const ttyFds: readonly [boolean, boolean, boolean] = [stdioKinds[0] === 'tty', stdioKinds[1] === 'tty', stdioKinds[2] === 'tty'];

  // A child started with an IPC channel is told its descriptor in its
  // environment, exactly as Node tells one; the variables are taken out
  // before the guest sees them, as Node's own bootstrap deletes them, so a
  // grandchild does not inherit a channel that is not its own.
  const guestEnv = { ...launch.env };
  const channelFd = Number.parseInt(guestEnv.NODE_CHANNEL_FD ?? '', 10);
  const channelSerialization = guestEnv.NODE_CHANNEL_SERIALIZATION_MODE || 'json';
  delete guestEnv.NODE_CHANNEL_FD;
  delete guestEnv.NODE_CHANNEL_SERIALIZATION_MODE;

  // A named run not yet numbered is a process its realm forks now (as runHostedNode's is), runs here and reaps at its
  // end; only a run nobody names is the realm's own process.
  const forkedHere = runToken !== null && !runPid(runToken);
  if (forkedHere) setRunPid(runToken, mintPid(), 0, { argv: [...launch.argv], cwd: launch.cwd });
  // Whose wait its end is: a nested node's parent run, a run forked here the realm's; any other run's parent is
  // elsewhere (the kernel's exec'd node: its own channel reports its exit) or is the host's.
  const reaper: ProcessToken | null | undefined = nested ? parentToken : forkedHere ? null : undefined;
  let runEnd: number | undefined;
  // Create a runtime with output capture for both console.log AND process.stdout.write
  const runtime = new Runtime(tree, {
    cwd: launch.cwd,
    env: guestEnv,
    onConsole: (method, consoleArgs) => {
      const msg = consoleArgs.map(a => String(a)).join(' ') + '\n';
      if (method === 'error') {
        appendStderr(msg);
      } else {
        appendStdout(msg);
      }
    },
    onStdout: (data: string) => {
      appendStdout(data);
    },
    onStderr: (data: string) => {
      appendStderr(data);
    },
    ...(stdoutBytes ? { onStdoutBytes: (bytes: Uint8Array) => appendStdout(bytes) } : {}),
    ...(stderrBytes ? { onStderrBytes: (bytes: Uint8Array) => appendStderr(bytes) } : {}),
    // The guest's standard input is what the shell put on its fd 0: the text
    // left of a pipe, or the `stdin` a host gave `container.run`. A held run
    // (one the host streams and can still feed with `sendStdin`) leaves it
    // open, as a pipe whose writer has not closed.
    // A run given a shared ring reads fd 0 from it alone.
    stdin: stdinRing ? '' : launch.stdin ?? '',
    ...(stdinRing || streams?.held || streams?.stdinOpen ? { stdinHeld: true } : {}),
    ...(ttyFds.some(Boolean) ? { tty: ttyFds } : {}),
    // The numbers this run was started with, so the guest's `process.pid`
    // is the one its parent's handle carries.
    ...(runPid(runToken) ? { pid: runPid(runToken)!.pid, ppid: runPid(runToken)!.ppid } : {}),
  });

  // Override process.exit to resolve the completion promise
  const proc = runtime.getProcess();
  // What fds 0, 1 and 2 are, where the fs binding's fstat reads them (the
  // symbol is the binding's `kStdioKinds`, named here so this file does not
  // import the fs binding).
  (proc as unknown as Record<symbol, unknown>)[Symbol.for('tabnode.run.stdioKinds')] = stdioKinds;
  // This run's numbers, recorded under its name: a child it spawns reads
  // them for its own `ppid`, and `process.kill(pid, 0)` asks this registry
  // whether a pid is a live process.
  if (runToken !== null) setRunPid(runToken, proc.pid, proc.ppid, { argv: [...launch.argv], cwd: launch.cwd });
  const releaseRun = runToken === null ? null : __recordRun(runToken, {
    process: proc,
    stdout: appendStdout,
    stderr: appendStderr,
    pendingTimers: () => pendingGuestTimers(proc),
    stopTimers: () => stopGuestTimers(proc),
    reportUncaught: (error: unknown) => __reportUncaughtException(proc, error),
  });
  let hostReceiptWritten = false;
  let lastUncaught: unknown;
  const writeHostReceipt = (kind: 'uncaught' | number, error?: unknown): void => {
    if (hostReceiptWritten || streams?.stderrIsPipe !== true) return;
    hostReceiptWritten = true;
    writePipedEndReceipt(proc.pid, proc.argv0 || 'node', proc.argv[1] ?? '', kind, error);
  };
  proc.exit = ((code = 0) => {
    if (!exitCalled) {
      exitCalled = true;
      // As Node takes one: a string from a command line becomes its number.
      exitCode = __substrateExitCode(code);
      code = exitCode;
      // A handled uncaught that then `process.exit(1)` is a normal exit
      // with code 1. The receipt still names the error the handler saw:
      // VS Code's host installs `uncaughtException` and exits 1, and the
      // previous line was `ended 1` with no reason.
      if (exitCode !== 0) writeHostReceipt(exitCode, lastUncaught);
      // Node runs a program's `exit` listeners while everything it holds is
      // still open, and closes the loop's handles after them. Releasing
      // first closed a forked child's IPC channel before its own exit
      // listeners ran, and VS Code's file-watcher child -- which pipes its
      // console over `process.send` and dies of a failed require -- wrote on
      // the closed channel and took `write EBADF` as its last act.
      proc.emit('exit', code);
      exitResolve!(code);
    }
    // `process.exit()` ends a Node process and everything it holds; a named
    // run's servers and timers go with it.
    if (runToken !== null) { __releaseOwnedServers(runToken); __releaseOwnedHandles(runToken); }
    // In sync context, throw to stop execution (like real process.exit)
    // In async context, return silently to avoid unhandled rejections
    if (syncExecution) {
      throw new Error(`Process exited with code ${code}`);
    }
  }) as (code?: number) => never;

  // Set up process.argv for the script. Node fills argv[0] with the
  // executable's path, the same value `process.execPath` reports; `argv0`
  // keeps the original argv[0], the plain word.
  // An evaluated program has no script: its argv is the executable and the
  // words after the source, as Node's is.
  proc.argv = evaluated !== null
    ? [__substrateExecPath, ...args.slice(first)]
    : [__substrateExecPath, resolvedPath!, ...args.slice(script + 1)];
  proc.argv0 = launch.argv[0] ?? 'node';
  proc.execArgv = execArgv;

  // Whoever writes to this run's fd 0 writes here: a person typing at a held
  // run's prompt, through `sendStdin`, or a parent writing to the stdin pipe
  // of a child it spawned.
  // A run whose fd 0 is a shared ring has no other writer.
  if (streams && !stdinRing) streams.stdin = proc.stdin;
  if (stdinRing) (proc as unknown as Record<symbol, unknown>)[kStdinRing] = stdinRing;

  // For long-running commands (watch mode), report as TTY so tools like
  // vitest set up interactive features (file watching, stdin commands). A
  // spawned child's stdio is a pipe, as Node's is, and gets none of this.
  // Each fd is a terminal only where the host said so.
  if (ttyFds[0]) {
    proc.stdin.isTTY = true;
    proc.stdin.setRawMode = () => proc.stdin;
  }
  if (ttyFds[1]) proc.stdout.isTTY = true;
  if (ttyFds[2]) proc.stderr.isTTY = true;
  const terminal = streams?.terminal;
  // A window change reaches the output streams that are the terminal; one
  // redirected to a file has no size.
  const resize = (columns: number, rows: number): void => {
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream.isTTY) continue;
      stream.columns = columns;
      stream.rows = rows;
      stream.emit('resize');
    }
  };
  let stopResize: (() => void) | undefined;
  let inputActive = true;
  let inputIterator: AsyncIterator<Uint8Array> | undefined;
  const readableInput = proc.stdin as unknown as { listenerCount(event: string): number; readableLength: number; readableHighWaterMark: number; readableFlowing: boolean | null; readableEnded?: boolean; _readableState?: { reading?: boolean; needReadable?: boolean } };
  const inputReading = () => readableInput.readableFlowing === true || readableInput._readableState?.reading === true
    || readableInput._readableState?.needReadable === true || readableInput.listenerCount('data') > 0 || readableInput.listenerCount('readable') > 0;
  // Whether the guest is consuming its stdin stream, which keeps a Node
  // process alive until the stream ends: a 'data' or 'readable' listener, or
  // flowing mode. A read the engine began (a drain parked for bytes) is not
  // the guest's: `fs.readSync(0)` never touches process.stdin in Node, and a
  // program that read its input that way and returned is done, whether or
  // not the writer has closed.
  // A guest's own `read()` counts as well: Node starts reading fd 0 then and
  // the process lives until the stream ends. The engine's reads do not.
  const inputConsumed = () => readableInput.readableFlowing === true
    || readableInput.listenerCount('data') > 0 || readableInput.listenerCount('readable') > 0
    || ((proc.stdin as unknown as { __substrateGuestRead?: boolean }).__substrateGuestRead === true && readableInput.readableEnded !== true);

  // A child started with a channel wires its own end of it before its
  // module runs, which is what `lib/internal/process/pre_execution.js` does
  // in Node and `_forkChild` is the body of. Inside the run, so the pipe is
  // this run's handle and the descriptor is read against this run's table.
  if (Number.isInteger(channelFd) && channelFd >= 0 && runToken !== null) {
    enterRun(runToken, () => { attachChannel(proc, channelFd, channelSerialization); });
  }

  // A promise rejection nobody handles ends the program, as it ends one in
  // Node (since 15 an unhandled rejection is an uncaught exception): a guest
  // listener for `unhandledRejection` on its process takes it, else one for
  // `uncaughtException` with origin 'unhandledRejection', else the error is
  // printed to stderr and the program exits 1. It was reported only while
  // the runner waited on a quiet program, only through a realm's
  // `unhandledrejection` event (a Node host has none; it reports through
  // `process`), and never ended the program: vue-pure-admin's mock loader
  // died in a rejection and the program ended silently with exit 0, where
  // Node prints the error and exits 1. The report is attached for the whole
  // run, on whichever surface the realm has.
  const onUnhandledRejection = (reason: unknown, promise?: Promise<unknown>): void => {
    if (reason instanceof Error && reason.message.startsWith('Process exited with code')) return;
    lastUncaught = reason;
    if (proc.listenerCount('unhandledRejection') > 0) { proc.emit('unhandledRejection', reason, promise); return; }
    if (proc.listenerCount('uncaughtException') > 0) { proc.emit('uncaughtException', reason, 'unhandledRejection'); return; }
    const errorMsg = reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason);
    appendStderr(`Error: ${errorMsg}\n`);
    writeHostReceipt('uncaught', reason);
    if (exitCalled) return;
    const wasSync = syncExecution;
    syncExecution = false;
    try { proc.exit(1); } finally { syncExecution = wasSync; }
  };
  const detachRejections = __listenForUnhandledRejections(proc, onUnhandledRejection,
    runToken !== null && nodeProcessRealmToken() === runToken);

  // An exception nobody caught ends the program it was thrown in, as it ends
  // one in Node: a guest listener for `uncaughtException` on its process
  // takes it, else the stack is printed to this program's stderr and the
  // program exits 1. Nothing of it reaches the realm. Unreported, a throw
  // from a timer callback of openvscode-server's reached the worker's global
  // `error` event, the substrate's container read that as a dead host and
  // disposed the worker, and every run's writes failed from then on.
  const onUncaughtException = (error: unknown): void => {
    if (error instanceof Error && error.message.startsWith('Process exited with code')) return;
    lastUncaught = error;
    // A program that set a capture callback takes every uncaught exception
    // itself, before any listener, which is Node's own order.
    const capture = __substrateUncaughtCapture();
    if (capture) { capture(error); return; }
    if (proc.listenerCount('uncaughtException') > 0) { proc.emit('uncaughtException', error, 'uncaughtException'); return; }
    appendStderr(`${error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)}\n`);
    writeHostReceipt('uncaught', error);
    if (exitCalled) return;
    const wasSync = syncExecution;
    syncExecution = false;
    try { proc.exit(1); } finally { syncExecution = wasSync; }
  };
  const detachUncaught = __onUncaughtException(proc, onUncaughtException);
  try {
  // The host's pipe delivers bytes after the entry has attached its reader.
  // EOF closes that same run's stream, never the most recently started run.
  // A shared ring is drained into the guest's stdin when the stream asks for
  // more (its `_read`), and waits for the producer with `Atomics.waitAsync`:
  // no timer, and nothing read that the guest has not asked for. A blocking
  // `fs.readSync(0)` takes from the same ring, after what the stream holds.
  if (stdinRing) {
    const ring = stdinRing;
    let draining = false;
    const push = (chunk: Uint8Array | null): boolean => (runToken === null ? proc.stdin.push(chunk) : enterRun(runToken, () => proc.stdin.push(chunk)));
    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        for (;;) {
          if (!inputActive || streams?.signal?.aborted) return;
          const chunk = ring.takeAll();
          if (chunk === null) { await ring.whenWritten(); continue; }
          if (chunk.length === 0) { push(null); if (streams) streams.stdinOpen = false; return; }
          if (!push(chunk)) return;
        }
      } catch (error) {
        if (inputActive) onUncaughtException(error);
      } finally { draining = false; }
    };
    (proc.stdin as unknown as { _read(): void })._read = () => { void drain(); };
  }
  if (streams?.stdinStream && !stdinRing) {
    inputIterator = streams.stdinStream[Symbol.asyncIterator]();
    const input = inputIterator;
    void (async () => {
      const push = (chunk: Uint8Array | null) => {
        if (runToken === null) proc.stdin.push(chunk);
        else enterRun(runToken, () => proc.stdin.push(chunk));
      };
      try {
        while (inputActive && !streams.signal?.aborted) {
          // A pipe is read on demand. Bound queued bytes by the Readable's
          // high-water mark and do not pull a producer nobody consumes.
          while (inputActive && !streams.signal?.aborted && (!inputReading()
            || readableInput.readableLength >= readableInput.readableHighWaterMark)) {
            await new Promise(resolve => (globalThis.__browserRuntimeNativeSetTimeout ?? setTimeout).call(globalThis, resolve, 10));
          }
          if (!inputActive || streams.signal?.aborted) break;
          const next = await input.next();
          if (next.done) break;
          if (!inputActive || streams.signal?.aborted) break;
          push(next.value);
        }
        if (inputActive && !streams.signal?.aborted) push(null);
      } catch (error) {
        if (inputActive) onUncaughtException(error);
      } finally { streams.stdinOpen = false; }
    })();
  }
  if (terminal) resize(terminal.columns, terminal.rows);
  stopResize = terminal?.onResize?.((columns, rows) => {
    if (runToken === null) resize(columns, rows);
    else enterRun(runToken, () => resize(columns, rows));
  });

  let entrySettling: Promise<unknown> | undefined;
  try {
    // Run the script (synchronous part)
    // The entry runs AS this run: the token a `spawn` inside it reads is
    // this program's, not whichever run started last. The engine's storage
    // carries it into the timers, microtasks and `then` callbacks the entry
    // schedules from here, so a child spawned later still names its parent.
    // `-p` prints the completion value of the source, which a direct `eval`
    // in the module body yields with the body's own `require` in scope.
    const runEntry = () => evaluated !== null
      ? runtime.evaluate(
        evaluated.print ? `console.log(eval(${JSON.stringify(evaluated.source)}));` : evaluated.source,
        __resolvePath(launch.cwd, '[eval]'),
      )
      : runtime.runFile(resolvedPath!);
    entrySettling = __substratePendingOf(
      (runToken === null ? runEntry() : enterRun(runToken, runEntry)).exports,
    );
  } catch (error) {
    // process.exit() throws to stop sync execution — this is expected
    if (error instanceof Error && error.message.startsWith('Process exited with code')) {
      return { stdout, stderr, exitCode };
    }
    // A throw out of the entry is this program's uncaught exception and
    // goes through the same door as any other: the guest's own
    // `uncaughtException` listeners, else its stderr and exit 1 -- which
    // runs its `exit` listeners. Returning a result straight from here
    // skipped them, and VS Code's file-watcher child, which pipes its
    // console over IPC and dies of a failed require, never sent the lines
    // that say why.
    syncExecution = false;
    onUncaughtException(error);
    return { stdout, stderr, exitCode: exitCalled ? exitCode : 1 };
  } finally {
    // After runFile returns, switch to async mode (no more throwing from process.exit)
    syncExecution = false;
  }

  // If process.exit was called synchronously (but didn't throw for some reason), return
  if (exitCalled) {
    return { stdout, stderr, exitCode };
  }

  // An entry still settling, a top-level `await` in it or in what it
  // imports, has run when it has settled; one that fails there fails the
  // program, as Node prints the error and exits 1.
  // The program may exit before the entry settles, by `process.exit` or a
  // fatal rejection in the meantime; the run ends at the exit, as Node's
  // does, and what the entry does after is its own.
  if (entrySettling) {
    const settling = entrySettling;
    try { await Promise.race([settling, exitPromise]); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Process exited with code')) return { stdout, stderr, exitCode };
      const errorMsg = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
      // Printed on the program's stderr, as Node prints it, so a host that
      // reads the fd (as text or as bytes) sees why the program ended.
      appendStderr(`Error: ${errorMsg}\n`);
      return { stdout, stderr, exitCode: 1 };
    }
    if (exitCalled) { settling.catch(() => {}); return { stdout, stderr, exitCode }; }
  }

  // Script returned without calling process.exit().
  // Heuristic: if we already captured output, the script likely finished synchronously
  // (e.g. a simple "console.log('hello')" script). Return immediately.
  // A program that printed and still holds a timer, or a build, is working:
  // the timers are the engine's own count for this guest, where this asked
  // an adapter that is gone through an ambient name nothing ever installed.
  // An active handle keeps Node's loop alive, so a run that owns one is not
  // idle however long it has been quiet. The engine registers a guest's
  // servers under this run's name as it opens them, and releases them when
  // the run ends; counting them here is what a `vite` a guest spawned needs,
  // which listened, printed, and was cut half a second later with its server
  // still up. A connected socket is such a handle too, and counting only the
  // listening ones settled VS Code's extension host — a program whose only
  // handle is one socket back to the server that forked it and which sets no
  // timer — as idle, with exit 0, three times over.
  const __ownsHandles = () => runToken !== null && (__ownedServerPorts(runToken).length > 0 || __ownedHandleCount(runToken) > 0);
  const __printedThenWorking = () => (streams?.stdinOpen === true && inputConsumed()) || pendingGuestTimers(proc) > 0 || heldWork().count > 0 || __ownsHandles();
  if (printed > 0 && !__printedThenWorking()) {
    // Settling the command is host work. Killing guest timers must not
    // cancel this continuation and leave the command's promise unresolved.
    await settlePrintedEntry();
    // Work that began during that tick is the program's still: a build
    // reached through a dynamic import's chain, a timer the entry set.
    // vue-pure-admin's mock loader, `import('bundle-import').then(...)`
    // after one printed line, was cut here with exit 0 before its build
    // began, where Node's loop runs until nothing is left. Such a program
    // waits below with the others.
    if (exitCalled) return { stdout, stderr, exitCode };
    // A run a host holds under a signal is the host's to end: it reads the
    // program's servers and work through doors of its own and keeps the
    // program open by them. Such a run reports settled here, as it did,
    // once nothing is held; holding it for a pending timer instead made
    // the substrate's loop take a `vite` quiet during its start for a
    // finished run and abort it before it listened. A run nobody holds
    // waits for its timers below, as Node's loop does.
    if (streams?.held || (!__printedThenWorking() && pendingGuestTimers(proc) === 0)) {
      return { stdout, stderr, exitCode: typeof proc !== 'undefined' && typeof proc.exitCode === 'number' ? proc.exitCode : 0 };
    }
  }

  // No output yet — script likely has async work (e.g. vitest test runner).
  // Wait for process.exit() or until output stabilizes.

  // Listen for forked child exits to shorten the idle timeout.
  // Many CLI tools (vitest, jest, etc.) fork workers and exit shortly after
  // all children complete. We use a shorter timeout once children are done.
  let childrenExited = false;
  const prevChildExitHandler = _onForkedChildExit;
  _onForkedChildExit = () => {
    if (_activeForkedChildren <= 0) childrenExited = true;
    prevChildExitHandler?.();
  };

  try {
    // Poll until process.exit is called, output stabilizes, or we time out
    const MAX_TOTAL_MS = 60000;
    const IDLE_TIMEOUT_MS = 500;
    const SILENT_IDLE_TIMEOUT_MS = 2000;
    const POST_CHILD_EXIT_IDLE_MS = 100; // short timeout after children finish
    const CHECK_MS = 50;
    const startTime = Date.now();
    let lastOutputLen = printed;
    let idleMs = 0;
    // A timer the guest still holds is work in Node's loop, whether or not
    // the program has printed; so is a handle it has open.
    const stillWorking = (): boolean => (streams?.stdinOpen === true && inputConsumed()) || pendingGuestTimers(proc) > 0 || __ownsHandles();

    // When an abort signal is present (e.g. watch mode), don't apply idle timeout —
    // only exit when aborted or process.exit is called.
    const isLongRunning = !!streams?.held;

    while (!exitCalled) {
      // Check abort signal for long-running commands (watch mode)
      if (streams?.signal?.aborted) break;

      // Check if exitPromise resolved (non-blocking)
      const raceResult = await Promise.race([
        exitPromise.then(() => 'exit' as const),
        new Promise<'tick'>(r => (globalThis.__browserRuntimeNativeSetTimeout ?? setTimeout).call(globalThis, () => r('tick'), CHECK_MS)),
      ]);

      if (raceResult === 'exit' || exitCalled) break;
      if (streams?.signal?.aborted) break;

      const currentLen = printed;
      if (currentLen > lastOutputLen) {
        // New output — reset idle timer
        lastOutputLen = currentLen;
        idleMs = 0;
      } else {
        idleMs += CHECK_MS;
      }

      // Use shorter idle timeout once all forked children have exited
      // Skip idle timeout for long-running commands (watch mode)
      if (!isLongRunning) {
        const effectiveIdle = childrenExited ? POST_CHILD_EXIT_IDLE_MS : IDLE_TIMEOUT_MS;
        if (heldWork().count > 0) idleMs = 0;
        // A program ends when its loop has nothing left, in Node whether or
        // not it printed. The break waited for output, so a program that
        // wrote nothing, a passing test of Node's own suite, waited the
        // whole minute. A silent program that has been idle for a while,
        // with no build held and no timer of its own pending, is done; the
        // longer wait is for a start that is quiet while it fetches, which
        // the engine cannot yet see as work.
        const silentIdle = SILENT_IDLE_TIMEOUT_MS;
        if (lastOutputLen > 0 && !stillWorking() && idleMs >= effectiveIdle) break;
        if (lastOutputLen === 0 && !stillWorking() && idleMs >= silentIdle) break;
      }

      // The hard timeout is for a program whose work the engine cannot see:
      // a start that is quiet while it fetches, a loop with nothing in the
      // engine's own registries. A run that still holds a handle or a timer
      // is not that -- Node's loop runs while one is open, for as long as it
      // is open -- and cutting it at a minute ended a forked child that was
      // a server, which is every extension host and every pty host. Work the
      // host holds for it (a build, a pre-bundle) is seen work too: a dev
      // server whose start passed a minute mid pre-bundle was cut with exit 0.
      if (!isLongRunning && !stillWorking() && heldWork().count === 0 && Date.now() - startTime >= MAX_TOTAL_MS) break;
    }

    return { stdout, stderr, exitCode: runEnd = exitCalled ? exitCode : (typeof proc !== 'undefined' && typeof proc.exitCode === 'number' ? proc.exitCode : 0) };
  } finally {
    if (streams) streams.stdin = null;
    _onForkedChildExit = prevChildExitHandler;
  }
  } finally {
    detachRejections();
    detachUncaught();
    inputActive = false;
    try { void Promise.resolve(inputIterator?.return?.()).catch(() => {}); } catch { /* producer cleanup cannot prevent process cleanup */ }
    try { stopResize?.(); } catch { /* host cleanup cannot prevent handle release */ }
    // A process that ends releases its listening sockets, whatever ended it:
    // a return from the entry, a throw, an exit. Only `process.exit` released
    // them here, so `vite --host` — which opened 5173 and then died at startup
    // with an ESLint error, exit 1 — left 5173 in the registry with nothing
    // behind it, and the page went on previewing a port no process held.
    // Safe twice: a run that exited already emptied its own entries.
    if (runToken !== null) { __releaseOwnedServers(runToken, false); __releaseOwnedHandles(runToken); }
    // A run this realm forked for itself exits with its end and, its end being its parent's wait, is reaped. One whose
    // launch threw (the runtime's failure, thrown to the caller) passed no code: it is killed.
    if (reaper !== undefined) {
      const own = runPid(runToken)!;
      const [code, signal] = runEnd === undefined ? [0, 'SIGKILL'] : [runEnd, null];
      exitRunProcess(own.pid, own.ppid, code, signal, reaper);
      reapRunProcess(own.pid, own.ppid, code, signal, reaper);
    }
    // A run that has ended is no longer a process: the number it wrote into
    // a lock file answers ESRCH from here on, which is how a stale lock is
    // stolen rather than waited on.
    if (runToken !== null) forgetRunPid(runToken);
    // A program that has ended holds no timers, as an ended Node process
    // holds none. `process.exit` asked for them to be stopped on a tick of
    // its own, and the run was taken out of the registry here before that
    // tick came, so the stop found nothing: an `setInterval` whose callback
    // threw ended its program and then went on firing forever, into a run
    // that no longer had anywhere to report an exception, and out to the
    // realm. The run's own timers stop here, while the process is still in
    // hand; the scheduled stop then finds nothing left to do.
    stopGuestTimers(proc);
    releaseRun?.();
  }
}

/**
 * The trees the engine made itself (`createContainer` with no `vfs`). A tree a
 * host hands the engine is the host's: what is at a path in it is the host's
 * to put there, and the engine writes nothing into it on its own account.
 */
const engineTrees = new WeakSet<VirtualFS>();

/** Record a tree the engine made, which it may furnish as a machine is furnished. */
export function adoptEngineTree<T extends VirtualFS>(tree: T): T {
  engineTrees.add(tree);
  return tree;
}

export function initChildProcess(vfs: VirtualFS): void {
  const existing = shells.get(vfs);
  if (existing) {
    currentVfs = vfs;
    bashInstance = existing.bash;
    vfsAdapter = existing.adapter;
    setSyncChildVfs(vfs);
    return;
  }
  // This tree's own shell. The `node` and `npm` commands close over it, so a
  // later `initChildProcess` of another tree cannot redirect them.
  const tree = vfs;
  currentVfs = tree;
  // A synchronous child runs on a thread over this same tree. In a browser
  // realm the thread cannot start inside the synchronous call that needs it —
  // a worker is started by the realm's own loop — so it is warmed here, while
  // the loop still runs. A Node host starts its threads itself, and is not
  // given one it may never use.
  setSyncChildVfs(tree);
  // Node's `process.execPath` names a program that exists. Every tool that
  // re-runs itself, and every one of Node's own tests that spawns a child,
  // writes the path rather than the name — `execSync('"' + process.execPath +
  // '" file')` — and the engine's shell answered "No such file or directory",
  // because its node was a command with no file anywhere. The shell runs its
  // own `node` for a path whose file exists and is named `node`, so a file at
  // execPath is all it needs.
  //
  // In a tree the engine made, the engine puts one there, executable. A tree a
  // host supplied is the host's: the engine creates and changes nothing in it,
  // and a host whose tree has no program at execPath answers "No such file or
  // directory" by that path, which is the host's to fix. Written into a host's
  // tree, the engine's line replaced what the host's own owner kept at the path
  // (the kernel's executable marker for `node` became a 10-byte 0644 file after
  // the first `node app.js`, whenever a realm did not see the kernel's file,
  // and the next lookup was EACCES).
  if (engineTrees.has(tree)) {
    try {
      if (!tree.existsSync(__substrateExecPath)) {
        tree.mkdirSync(__substrateExecPath.slice(0, __substrateExecPath.lastIndexOf('/')), { recursive: true });
        tree.writeFileSync(__substrateExecPath, 'node "$@"\n');
        tree.chmodSync(__substrateExecPath, 0o755);
      }
    } catch { /* a tree that refuses the write keeps the command under its plain name */ }
  }
  if (typeof (globalThis as Record<string, unknown>).WorkerGlobalScope !== 'undefined' || typeof (globalThis as Record<string, unknown>).document !== 'undefined') warmSyncChild();
  vfsAdapter = new VirtualFSAdapter(tree);

  // The shell's `node` is the engine's Node started from the words the shell
  // parsed; `launchNode` is the one start, which `container.runNode` shares.
  const nodeCommand = defineCommand('node', (args, ctx) => launchNode(tree, {
    argv: ['node', ...args],
    cwd: ctx.cwd,
    env: guestEnvironmentOf(ctx),
    ...(typeof ctx.stdin === 'string' ? { stdin: ctx.stdin } : {}),
    token: runTokenOf(ctx),
  }));

  // Create custom 'npm' command that runs scripts from package.json
  const npmCommand = defineCommand('npm', async (args, ctx) => {
    if (!tree) {
      return { stdout: '', stderr: 'VFS not initialized\n', exitCode: 1 };
    }

    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help') {
      return {
        stdout: 'Usage: npm <command>\n\nCommands:\n  run <script>   Run a script from package.json\n  start          Run the start script\n  test           Run the test script\n  install [pkg]  Install packages\n  ls             List installed packages\n',
        stderr: '',
        exitCode: 0,
      };
    }

    switch (subcommand) {
      case 'run':
      case 'run-script':
        return handleNpmRun(args.slice(1), ctx);
      case 'start':
        return handleNpmRun(['start'], ctx);
      case 'test':
      case 't':
      case 'tst':
        return handleNpmRun(['test'], ctx);
      case 'install':
      case 'i':
      case 'add':
        return handleNpmInstall(args.slice(1), ctx);
      case 'ls':
      case 'list':
        return handleNpmList(ctx);
      case 'init':
      case 'create':
      case 'innit':
        return handleNpmInit(args.slice(1), ctx);
      default:
        return {
          stdout: '',
          stderr: `npm ERR! Unknown command: "${subcommand}"\n`,
          exitCode: 1,
        };
    }
  });

  bashInstance = new Bash({
    fs: vfsAdapter,
    cwd: '/',
    env: {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/local/bin:/usr/bin:/bin:/node_modules/.bin',
    },
    customCommands: [nodeCommand, npmCommand],
  });
  // A statement ending in `&` runs in the background, with `$!`, `wait` and
  // `kill` over the engine's process table (`shell-jobs.ts` says how).
  installShellJobs(bashInstance, { runTokenOf, runStreamsFor, registerRunStreams, releaseRunStreams });
  shells.set(tree, { bash: bashInstance, adapter: vfsAdapter });

  if (processRunnerInstalled) return;
  processRunnerInstalled = true;

  // What a `Process` handle runs. Node's own `child_process.js` starts, ends
  // and pipes a child through the binding; the binding asks this.
  setProgramResolver(engineProgramFor);
  // The rule `startChildRun` applies below, as one answer for a synchronous child (the spawn_sync binding): with a
  // host published, a shell and `env` are the host's, the engine's Node is the engine's, and any other program is
  // the host's unless the engine carries it.
  setHostRunsProgram((file, cwd, env) => {
    if (hostExecutor() === null || __substrateRunsNode(file, cwd)) return false;
    const program = engineProgramFor(file, cwd);
    return SHELL_PROGRAMS.has(program) || program === 'env' || !programExists(file, cwd, env);
  });
  setProcessRunner({
    resolves: (request: RunRequest): boolean => {
      if (!bashInstance) return false;
      // A directory that is not there is `ENOENT` before the program is even
      // looked for, as it is for `execve`: `spawn(cmd, { cwd: 'nope' })`
      // reports a child that never started, and `child.pid` is undefined.
      if (typeof request.cwd === 'string' && request.cwd.length > 0 && !existsInTree(request.cwd)) return false;
      // A `{ shell: true }` spawn is `/bin/sh -c <line>`, and the shell is
      // always there; what the line names is the line's own business, as it
      // is on a machine.
      if (__substrateShellLine(request.file, request.args) !== null) return true;
      // A page that published a process host carries programs the engine
      // cannot enumerate -- a registered command, a WALI pack -- so the host
      // is asked by running it, and reports its own absence.
      if (hostExecutor() !== null) return true;
      return programExists(request.file, request.cwd, request.env);
    },
    start: startChildRun,
  });
}

/**
 * The child's end of an IPC channel, wired onto its own process before its
 * module runs. This is `lib/internal/process/pre_execution.js`'s
 * `setupChildProcessIpcChannel` and `child_process._forkChild`'s body, over
 * the engine's own process object rather than the realm's `process`, because
 * a realm here holds many programs and the channel belongs to one of them.
 */
function attachChannel(proc: ReturnType<Runtime['getProcess']>, fd: number, serialization: string): void {
  // With a process-bound loader, Node's own bootstrap now owns this too.
  // The host setupChannel built received sockets from the host net graph;
  // process.send and every received socket must use the child's graph.
  (loadNodeLibFor(proc, 'child_process') as ChildProcessModule)._forkChild(fd, serialization);
}

/** The shell's environment as a record: just-bash hands a command a Map. */
function environmentOf(ctx: CommandContext): Record<string, string> {
  const env: unknown = ctx.env;
  if (env instanceof Map) return Object.fromEntries(env as Map<string, string>);
  return { ...((env ?? {}) as Record<string, string>) };
}

/**
 * The environment a guest process sees. The name its run travels under is the
 * shell's business, not the program's: Node's `process.env` carries no name
 * for the process, so the variable is taken out here while the shell keeps it
 * for a `node` a script of its own goes on to run.
 */
function guestEnvironmentOf(ctx: CommandContext): Record<string, string> {
  const env = environmentOf(ctx);
  delete env[PROCESS_TOKEN_ENV];
  return env;
}

/** The name the host gave the run this command belongs to, where it named one. */
function runTokenOf(ctx: CommandContext): ProcessToken | null {
  const value = ctx.env instanceof Map ? ctx.env.get(PROCESS_TOKEN_ENV) : (ctx.env as Record<string, string> | undefined)?.[PROCESS_TOKEN_ENV];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read and parse package.json from the VFS
 */
function readPackageJson(cwd: string): { pkgJson: PackageJson; error?: undefined } | { pkgJson?: undefined; error: JustBashExecResult } {
  const pkgJsonPath = `${cwd}/package.json`.replace(/\/+/g, '/');

  if (!currentVfs!.existsSync(pkgJsonPath)) {
    return {
      error: {
        stdout: '',
        stderr: 'npm ERR! no package.json found\n',
        exitCode: 1,
      },
    };
  }

  try {
    const pkgJson = JSON.parse(currentVfs!.readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
    return { pkgJson };
  } catch {
    return {
      error: {
        stdout: '',
        stderr: 'npm ERR! Failed to parse package.json\n',
        exitCode: 1,
      },
    };
  }
}

/**
 * Handle `npm run [script]` — execute a script from package.json
 */
async function handleNpmRun(args: string[], ctx: CommandContext): Promise<JustBashExecResult> {
  // npm's own options come before the script's name and are npm's
  // (`npm run --silent vgai -- mcp .`, as a project's `.mcp.json` launches its
  // server); what follows the name goes to the script, everything after `--`
  // untouched. The name used to be `args[0]`, so `--silent` was looked up as a
  // script, and the script's own arguments were dropped.
  let scriptName: string | undefined;
  let silent = false;
  let ifPresent = false;
  const passed: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') { if (scriptName !== undefined) passed.push(...args.slice(index + 1)); break; }
    if (arg.startsWith('-') && arg !== '-') {
      if (arg === '--silent' || arg === '-s' || arg === '--quiet' || arg === '-q' || arg === '--loglevel=silent') silent = true;
      else if (arg === '--if-present') ifPresent = true;
      continue;
    }
    if (scriptName === undefined) scriptName = arg;
    else passed.push(arg);
  }

  // "npm run" with no script name: list available scripts
  if (!scriptName) {
    return listScripts(ctx);
  }

  const result = readPackageJson(ctx.cwd);
  if (result.error) return result.error;
  const pkgJson = result.pkgJson;

  const scripts = pkgJson.scripts || {};
  const scriptCommand = scripts[scriptName];

  if (!scriptCommand) {
    if (ifPresent) return { stdout: '', stderr: '', exitCode: 0 };
    const available = Object.keys(scripts);
    let msg = `npm ERR! Missing script: "${scriptName}"\n`;
    if (available.length > 0) {
      msg += '\nnpm ERR! Available scripts:\n';
      for (const name of available) {
        msg += `npm ERR!   ${name}\n`;
        msg += `npm ERR!     ${scripts[name]}\n`;
      }
    }
    return { stdout: '', stderr: msg, exitCode: 1 };
  }

  if (!ctx.exec) {
    return {
      stdout: '',
      stderr: 'npm ERR! Script execution not available in this context\n',
      exitCode: 1,
    };
  }

  // Set up npm-specific environment variables
  const npmEnv: Record<string, string> = {
    ...environmentOf(ctx),
    npm_lifecycle_event: scriptName,
  };
  if (pkgJson.name) npmEnv.npm_package_name = pkgJson.name;
  if (pkgJson.version) npmEnv.npm_package_version = pkgJson.version;

  let allStdout = '';
  let allStderr = '';
  const label = `${pkgJson.name || ''}@${pkgJson.version || ''}`;

  // Run pre<script> if it exists
  const preScript = scripts[`pre${scriptName}`];
  if (preScript) {
    if (!silent) allStderr += `\n> ${label} pre${scriptName}\n> ${preScript}\n\n`;
    const preResult = await ctx.exec(preScript, { cwd: ctx.cwd, env: npmEnv });
    allStdout += preResult.stdout;
    allStderr += preResult.stderr;
    if (preResult.exitCode !== 0) {
      return { stdout: allStdout, stderr: allStderr, exitCode: preResult.exitCode };
    }
  }

  // Run the main script, with the arguments npm passes it, each quoted.
  const command = passed.length > 0
    ? `${scriptCommand} ${passed.map((arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')}`
    : scriptCommand;
  if (!silent) allStderr += `\n> ${label} ${scriptName}\n> ${command}\n\n`;
  // The script reads npm's standard input: a `.mcp.json` server launched as
  // `npm run … -- serve` speaks JSON-RPC on it.
  const mainResult = await ctx.exec(command, { cwd: ctx.cwd, env: npmEnv, ...(typeof ctx.stdin === 'string' ? { stdin: ctx.stdin } : {}) });
  allStdout += mainResult.stdout;
  allStderr += mainResult.stderr;

  if (mainResult.exitCode !== 0) {
    return { stdout: allStdout, stderr: allStderr, exitCode: mainResult.exitCode };
  }

  // Run post<script> if it exists
  const postScript = scripts[`post${scriptName}`];
  if (postScript) {
    if (!silent) allStderr += `\n> ${label} post${scriptName}\n> ${postScript}\n\n`;
    const postResult = await ctx.exec(postScript, { cwd: ctx.cwd, env: npmEnv });
    allStdout += postResult.stdout;
    allStderr += postResult.stderr;
    if (postResult.exitCode !== 0) {
      return { stdout: allStdout, stderr: allStderr, exitCode: postResult.exitCode };
    }
  }

  return { stdout: allStdout, stderr: allStderr, exitCode: 0 };
}

/**
 * List available scripts from package.json (when `npm run` is called with no args)
 */
function listScripts(ctx: CommandContext): JustBashExecResult {
  const result = readPackageJson(ctx.cwd);
  if (result.error) return result.error;
  const pkgJson = result.pkgJson;

  const scripts = pkgJson.scripts || {};
  const names = Object.keys(scripts);

  if (names.length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  const lifecycle = ['prestart', 'start', 'poststart', 'pretest', 'test', 'posttest', 'prestop', 'stop', 'poststop'];
  const lifecyclePresent = names.filter(n => lifecycle.includes(n));
  const customPresent = names.filter(n => !lifecycle.includes(n));

  let output = `Lifecycle scripts included in ${pkgJson.name || ''}:\n`;
  for (const name of lifecyclePresent) {
    output += `  ${name}\n    ${scripts[name]}\n`;
  }
  if (customPresent.length > 0) {
    output += '\navailable via `npm run-script`:\n';
    for (const name of customPresent) {
      output += `  ${name}\n    ${scripts[name]}\n`;
    }
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Handle `npm install [pkg]` — bridge to PackageManager
 */
async function handleNpmInstall(args: string[], ctx: CommandContext): Promise<JustBashExecResult> {
  const { PackageManager } = await import('../npm/index');
  const pm = new PackageManager(currentVfs!, { cwd: ctx.cwd });

  let stdout = '';

  try {
    const pkgArgs = args.filter(a => !a.startsWith('-'));
    if (pkgArgs.length === 0) {
      // npm install (no package name) -> install from package.json.
      // npm installs devDependencies unless told not to: `--omit=dev`,
      // `--production`, `--prod`, or `NODE_ENV=production`. A bare install that
      // left them out made a project whose build script runs `tsc` or `tsup`
      // install cleanly and then find no such command.
      const __omitDev = args.includes('--omit=dev') || args.includes('--production') || args.includes('--prod') || (environmentOf(ctx).NODE_ENV === 'production');
      const installResult = await pm.installFromPackageJson({
        includeDev: !__omitDev,
        onProgress: (msg: string) => { stdout += msg + '\n'; },
      });
      stdout += `added ${installResult.added.length} packages\n`;
    } else {
      // npm install <pkg> [<pkg> ...]
      for (const arg of pkgArgs) {
        const installResult = await pm.install(arg, {
          save: true,
          onProgress: (msg: string) => { stdout += msg + '\n'; },
        });
        stdout += `added ${installResult.added.length} packages\n`;
      }
    }
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    return { stdout, stderr: `npm ERR! ${msg}\n`, exitCode: 1 };
  }
}

/**
 * `npm init -y`: npm's defaults written to package.json, the fields a
 * package.json already has kept, and the file printed as npm prints it. The
 * questionnaire without `-y` needs a person at npm's prompts; it is refused by
 * name, as is an initializer (`npm init <pkg>`), which runs another package.
 */
async function handleNpmInit(args: string[], ctx: CommandContext): Promise<JustBashExecResult> {
  const yes = args.includes('-y') || args.includes('--yes');
  // a flag's value is not an initializer: `--scope @x`, `-w pkg`, `--init-license MIT`
  const takesValue = (flag: string) => !flag.includes('=') && (flag === '--scope' || flag === '-w' || flag === '--workspace' || flag.startsWith('--init-'));
  const valueOf = (flag: string) => {
    const at = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (at < 0) return undefined;
    return args[at].includes('=') ? args[at].slice(args[at].indexOf('=') + 1) : args[at + 1];
  };
  const initializer = args.find((a, i) => !a.startsWith('-') && !(i > 0 && takesValue(args[i - 1]!)));
  if (initializer) {
    return { stdout: '', stderr: `npm ERR! npm init ${initializer} runs an initializer package, which this engine's npm does not; write package.json, or run \`npm init -y\`.\n`, exitCode: 1 };
  }
  if (!yes) {
    return { stdout: '', stderr: 'npm ERR! npm init asks its questions at a prompt, which this engine\'s npm does not; `npm init -y` writes the defaults.\n', exitCode: 1 };
  }
  const vfs = currentVfs!;
  const file = __resolvePath(ctx.cwd, 'package.json');
  let existing: Record<string, unknown> = {};
  if (vfs.existsSync(file)) {
    try { existing = JSON.parse(String(vfs.readFileSync(file, 'utf8'))) as Record<string, unknown>; }
    catch { return { stdout: '', stderr: `npm ERR! ${file} is not valid JSON\n`, exitCode: 1 }; }
  }
  const base = ctx.cwd.split('/').filter(Boolean).pop() ?? 'package';
  const bare = base.toLowerCase().replace(/^[._]+/, '').replace(/[^a-z0-9._~-]+/g, '-') || 'package';
  const scope = valueOf('--scope')?.replace(/^@?/, '@');
  const name = scope ? `${scope}/${bare}` : bare;
  const manifest = {
    name,
    version: '1.0.0',
    description: '',
    main: 'index.js',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    keywords: [],
    author: '',
    license: 'ISC',
    ...existing,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  vfs.writeFileSync(file, text);
  return { stdout: `Wrote to ${file}:\n\n${text}\n\n`, stderr: '', exitCode: 0 };
}

/**
 * Handle `npm ls` — list installed packages
 */
async function handleNpmList(ctx: CommandContext): Promise<JustBashExecResult> {
  const { PackageManager } = await import('../npm/index');
  const pm = new PackageManager(currentVfs!, { cwd: ctx.cwd });
  const packages = pm.list();
  const entries = Object.entries(packages);

  if (entries.length === 0) {
    return { stdout: '(empty)\n', stderr: '', exitCode: 0 };
  }

  let output = `${ctx.cwd}\n`;
  for (const [name, version] of entries) {
    output += `+-- ${name}@${version}\n`;
  }
  return { stdout: output, stderr: '', exitCode: 0 };
}

/** What a host asks of `runCommand`, the engine's own door onto its shell. */
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** What the shell reads on stdin, so a builtin reads what was piped to it. */
  stdin?: string;
  /**
   * A name for this run, which the `node` command records its guest process
   * under and the container answers `pendingTimers`, `processPorts` and
   * `stopProcess` about. It travels in the shell's environment so that two
   * runs in flight at once each reach their own command.
   */
  processToken?: string;
  /** The tree this command runs on, so two containers in one realm keep theirs. */
  vfs?: VirtualFS;
}

/** What `runCommand` answers with, in the shape a shell answers. */
export type ExecCallback = (
  error: (Error & { code?: number }) | null,
  stdout: string,
  stderr: string
) => void;

/**
 * The one host hook Tabnode lacks: a child process can execute through the
 * embedding runtime's shared process host instead of this module's private
 * just-bash instance. The host publishes an executor on a well-known global
 * symbol; when none is published every call falls through to just-bash. This
 * is the door a page-registered program and a WALI pack are reached by, and
 * it is what a `Process` handle runs when the host has taken it.
 */
/** What the embedding runtime's process host answers when a command finishes. */
interface ChildProcessHostResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  /** The signal that ended the program, where one did (a name, or its Linux number). */
  signal?: string | number;
}

/**
 * One of a child's pipes past fd 2, as the host's program holds it: the
 * parent's handle for that fd is the other end.
 */
interface ChildProcessHostDescriptor {
  /** Bytes the parent writes to this fd, in order; ends when the parent closes it. */
  input: AsyncIterable<Uint8Array>;
  /** Bytes the child writes on this fd; they are reads on the parent's handle. */
  write(bytes: Uint8Array): void;
  /** The child closed this fd: EOF on the parent's handle. */
  end(): void;
}

/** How a command is handed to that host. */
interface ChildProcessHostRequest {
  /**
   * The command as the list a guest's `spawn` gave, where it gave one: the
   * program, then its words. A host that starts programs from a list starts
   * this one from it, and no shell reads the words a second time; the line
   * beside it says the same run for a host that has only a shell.
   */
  argv?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Bytes already on fd 0 when the command begins, as Node delivers them. */
  stdin?: string;
  stdinStream: AsyncIterable<Uint8Array>;
  terminal?: RunStreams['terminal'];
  signal: AbortSignal;
  /**
   * Whether the parent still waits for this child: false once its handle is unref'd, true again if ref'd. `changed`
   * is the host's to set, and is called after each change, for a host that must tell another realm.
   */
  hold: { value: boolean; changed?: () => void };
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  /**
   * fd 1 and fd 2 as the bytes the program wrote, where the caller takes
   * bytes. A host that can, writes a program's output here; a text-only host
   * keeps writing `onStdout`/`onStderr`. An fd that streamed any bytes here
   * has an empty total in the result: nothing of it is replayed or decoded.
   */
  onStdoutBytes?: (bytes: Uint8Array) => void;
  onStderrBytes?: (bytes: Uint8Array) => void;
  /** The child's pipes past fd 2, by number; only where it was started with any. */
  descriptors?: Record<number, ChildProcessHostDescriptor>;
}

/** The executor a host publishes on the well-known global symbol. */
interface ChildProcessHost {
  run(command: string, request: ChildProcessHostRequest): Promise<ChildProcessHostResult>;
  /** Runs the host leaves to just-bash instead, one per count. */
  bypass: number;
  parentSignal?: AbortSignal;
}

const __browserRuntimeChildProcessExecutorSymbol = Symbol.for("@volter/browser-runtime/child-process-executor");

/** The host's executor, where one is published and has not bypassed this run. */
function hostExecutor(): ChildProcessHost | null {
  const bridge = (globalThis as unknown as Record<symbol, ChildProcessHost | undefined>)[__browserRuntimeChildProcessExecutorSymbol];
  if (!bridge || typeof bridge.run !== 'function') return null;
  return bridge;
}

/** What a run of a command answers, however it was routed. */
interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

/** What a caller gives one run of a command line. */
interface CommandRun {
  command: string;
  /** The same run as its words, where the caller had a list (`ChildProcessHostRequest.argv`). */
  argv?: readonly string[];
  /**
   * Whether the engine's own shell answers for this command before the host's
   * process host is asked. A run the HOST asked for is the host's first: that
   * is how a page-registered program and a WALI pack are reached. A child a
   * GUEST spawned is the engine's first, because the engine has a command for
   * it and because a host that takes the child over reports it as a run of its
   * own -- which is why every line a forked child printed reached the tab's
   * terminal twice, once as the child's run and once down its parent's
   * inherited stdout. The host is still asked for what the engine does not
   * carry.
   */
  engineFirst?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Bytes a writer still holds the run's fd 0 open with, as they arrive. */
  stdinStream?: AsyncIterable<Uint8Array>;
  terminal?: RunStreams['terminal'];
  signal?: AbortSignal;
  /** fd 1 and fd 2 as bytes, for a host that streams them so. */
  onStdoutBytes?: (bytes: Uint8Array) => void;
  onStderrBytes?: (bytes: Uint8Array) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  vfs?: VirtualFS;
  /** The child's ends of its pipes past fd 2, for a host that runs it. */
  descriptors?: { fd: number; pipe: Pipe }[];
  /** Told when the host's process host takes the run: its end is then the host's, not the engine's. */
  onHostRun?: () => void;
  /** The parent's wait for this run, as its handle's ref state has it (`ChildProcessHostRequest.hold`). */
  hold?: { value: boolean; changed?: () => void };
}

/**
 * One command line, run by whichever door answers for it: the host's own
 * process host where the page published one (a registered program, a WALI
 * pack), else the engine's shell, whose `node` and `npm` are its own commands.
 * This is the whole of the engine's routing, and it is what a `Process`
 * handle, a `runCommand` and a synchronous child all reach the world through.
 */
async function routeCommand(run: CommandRun): Promise<CommandOutcome> {
  const tree = run.vfs ?? treeForRun();
  const shell = shellOf(tree);
  if (tree && shell) {
    currentVfs = tree;
    bashInstance = shell.bash;
    vfsAdapter = shell.adapter;
  }
  const bash = shell?.bash ?? bashInstance;
  const bridge = run.engineFirst === true && bash !== null ? null : hostExecutor();
  if (bridge !== null && bridge.bypass > 0) bridge.bypass -= 1;
  else if (bridge !== null) {
    const controller = new AbortController();
    const abortWithParent = (): void => {
      if (!controller.signal.aborted) controller.abort(bridge.parentSignal?.reason);
    };
    if (run.signal) {
      if (run.signal.aborted) controller.abort(run.signal.reason);
      else run.signal.addEventListener('abort', () => controller.abort(run.signal?.reason), { once: true });
    }
    if (bridge.parentSignal) {
      if (bridge.parentSignal.aborted) abortWithParent();
      else bridge.parentSignal.addEventListener('abort', abortWithParent, { once: true });
    }
    run.onHostRun?.();
    let streamedOut = '';
    let streamedErr = '';
    const onStdout = (data: string): void => { streamedOut += String(data); run.onStdout?.(String(data)); };
    const onStderr = (data: string): void => { streamedErr += String(data); run.onStderr?.(String(data)); };
    // An fd the host streamed as bytes is whole already: its total is empty
    // by the host's contract and is never replayed, whatever the host says.
    let bytesOut = false;
    let bytesErr = false;
    const byteSinks = {
      ...(run.onStdoutBytes ? { onStdoutBytes: (bytes: Uint8Array): void => { bytesOut = true; run.onStdoutBytes!(bytes); } } : {}),
      ...(run.onStderrBytes ? { onStderrBytes: (bytes: Uint8Array): void => { bytesErr = true; run.onStderrBytes!(bytes); } } : {}),
    };
    // This token routes the engine's own shell, not a program's environment.
    // If a host shell inherits it, a later Node launch can override its new
    // stream identity with the ancestor's and deliver output to both runs.
    // Host ancestry is already carried by the current process context.
    const hostEnv = run.env === undefined ? undefined : { ...run.env };
    if (hostEnv) delete hostEnv[PROCESS_TOKEN_ENV];
    // The host's program is the one holding the child's pipes past fd 2; the
    // run's end is its end of them, whatever it did not close itself.
    const opened = (run.descriptors ?? []).map(({ fd, pipe }) => ({ fd, ...descriptorOver(pipe) }));
    try {
      const result = await bridge.run(run.command, {
        ...(run.argv ? { argv: [...run.argv] } : {}),
        cwd: run.cwd,
        env: hostEnv,
        ...(typeof run.stdin === 'string' ? { stdin: run.stdin } : {}),
        stdinStream: run.stdinStream ?? emptyStdinStream(),
        ...(run.terminal ? { terminal: run.terminal } : {}),
        signal: controller.signal,
        hold: run.hold ?? { value: true },
        onStdout,
        onStderr,
        ...byteSinks,
        ...(opened.length > 0
          ? { descriptors: Object.fromEntries(opened.map(({ fd, descriptor }) => [fd, descriptor])) }
          : {}),
      });
      const stdout = bytesOut ? '' : result.stdout || streamedOut;
      const stderr = bytesErr ? '' : result.stderr || streamedErr;
      if (!bytesOut && !streamedOut && result.stdout) run.onStdout?.(result.stdout);
      if (!bytesErr && !streamedErr && result.stderr) run.onStderr?.(result.stderr);
      const signal = typeof result.signal === 'number' ? __substrateSignalNames[result.signal] : result.signal;
      return { stdout, stderr, exitCode: result.exitCode, ...(signal ? { signal } : {}) };
    } finally {
      if (bridge.parentSignal) bridge.parentSignal.removeEventListener('abort', abortWithParent);
      for (const { release } of opened) release();
    }
  }

  if (!bash) throw new Error('child_process not initialized');
  const result = await bash.exec(run.command, {
    cwd: run.cwd,
    env: run.env,
    ...(typeof run.stdin === 'string' ? { stdin: run.stdin } : {}),
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exitCode };
}

/**
 * A child's pipe past fd 2, held by a program the host runs: the parent's
 * writes on its handle are the program's input, read the way the handle's fd 0
 * is read, and the program's writes are reads on the parent's handle, as bytes.
 * `release` is the run's end: reading stops and the input ends.
 */
function descriptorOver(pipe: Pipe): { descriptor: ChildProcessHostDescriptor; release(): void } {
  const queued: Uint8Array[] = [];
  let waiting: ((result: IteratorResult<Uint8Array>) => void) | null = null;
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    pipe.readStop();
    pipe.onread = null;
    if (waiting) { const wake = waiting; waiting = null; wake({ value: undefined, done: true }); }
  };
  pipe.onread = (arrayBuffer: ArrayBuffer | null): void => {
    const length = streamBaseState[kReadBytesOrError];
    if (length <= 0 || arrayBuffer === null) { finish(); return; }
    const bytes = new Uint8Array(arrayBuffer, streamBaseState[kArrayBufferOffset], length).slice();
    if (waiting) { const wake = waiting; waiting = null; wake({ value: bytes, done: false }); }
    else queued.push(bytes);
  };
  pipe.readStart();
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          const next = queued.shift();
          if (next) return Promise.resolve({ value: next, done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiting = resolve; });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return {
    descriptor: {
      input,
      write(bytes: Uint8Array): void {
        if (pipe.closed) return;
        pipe.writeBuffer(new WriteWrap(), bytes);
      },
      end(): void {
        finish();
        if (!pipe.closed) pipe.shutdown(new ShutdownWrap());
      },
    },
    release: finish,
  };
}

/** A child whose stdin nobody writes to still needs a stream the host can read. */
function emptyStdinStream(): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { /* nothing is ever written */ } };
}

/**
 * The host's door onto the engine's shell: one named run of a command line,
 * with the host's streams and its abort handle. This is `container.run`'s
 * half, not Node's `child_process.exec` -- Node's is its own file's, over the
 * binding, and it knows nothing of a run's name.
 */
export function runCommand(command: string, options: ExecOptions, callback?: ExecCallback): void {
  void (async () => {
    try {
      const outcome = await routeCommand({
        command,
        cwd: options.cwd,
        env: typeof options.processToken === 'string'
          ? { ...(options.env ?? {}), [PROCESS_TOKEN_ENV]: options.processToken }
          : options.env,
        stdin: options.stdin,
        signal: typeof options.processToken === 'string' ? _runStreams.get(options.processToken)?.signal : undefined,
        vfs: options.vfs,
      });
      if (!callback) return;
      if (outcome.exitCode !== 0) {
        const error = Object.assign(new Error(`Command failed: ${command}`), { code: outcome.exitCode });
        callback(error, outcome.stdout, outcome.stderr);
      } else {
        callback(null, outcome.stdout, outcome.stderr);
      }
    } catch (error) {
      callback?.(error as Error & { code?: number }, '', '');
    }
  })();
}

/** What a host gives one argv start of the engine's Node. */
export interface NodeRunOptions {
  /** The process's working directory; `/` when absent, as the shell's. */
  cwd?: string;
  /** The process's whole environment, as `execve` takes it; empty when absent. */
  env?: Record<string, string>;
  /** Bytes already on fd 0 when the process begins. */
  stdin?: string | Uint8Array;
  /** The run's name, under which the host registered its streams and signal. */
  processToken: string;
  /** The container's tree. */
  vfs: VirtualFS;
  /** The tree this run's process reads and writes instead, where the host gives one. */
  filesystem?: VirtualFS;
  /** The numbers the host already gave this process, a kernel's. */
  process?: { pid: number; ppid: number };
  /** The run's own process registry, its kernel connection's (installRunRegistry). */
  registry?: ProcessRegistry;
}

/**
 * The shell over a tree one run was given (`RunOptions.filesystem`), made as
 * a container's is, without making that tree the container's: the module's
 * notion of the current tree, and the tree a synchronous child of a run
 * without its own falls back to, are what they were.
 */
function shellForRunTree(tree: VirtualFS): void {
  const before = { vfs: currentVfs, bash: bashInstance, adapter: vfsAdapter };
  initChildProcess(tree);
  if (before.vfs) {
    currentVfs = before.vfs;
    bashInstance = before.bash;
    vfsAdapter = before.adapter;
    setSyncChildVfs(before.vfs);
  }
}

/**
 * The host's door onto the engine's Node by argv: `["node", "server.js"]`
 * starts the process `node server.js` names, through `launchNode` as the
 * shell's `node` does, with no command line and no shell between. A kernel
 * that resolved `node` itself and execs it has a vector, not a line; handed
 * to `runCommand` the line went to the engine's shell, which looked the
 * program up in its own tree and answered "node: command not found".
 */
export async function runNode(argv: readonly string[], options: NodeRunOptions): Promise<CommandOutcome> {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((word) => typeof word !== 'string')) {
    throw new TypeError('runNode: argv must be a non-empty array of strings');
  }
  const tree = options.filesystem ?? options.vfs;
  if (options.filesystem && !shells.has(options.filesystem)) shellForRunTree(options.filesystem);
  const shell = shells.get(tree);
  if (!shell) throw new Error('child_process not initialized for this tree');
  currentVfs = tree;
  bashInstance = shell.bash;
  vfsAdapter = shell.adapter;
  const env = { ...(options.env ?? {}) };
  delete env[PROCESS_TOKEN_ENV];
  if (options.registry) installRunRegistry(options.processToken, options.registry);
  if (options.process) claimRunPid(options.processToken, options.process.pid, options.process.ppid, { argv: [...argv], cwd: options.cwd ?? '/' });
  return launchNode(tree, {
    argv: [...argv],
    cwd: options.cwd ?? '/',
    env,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    token: options.processToken,
  });
}

/**
 * The engine's own names for the programs it carries, for the one question
 * libuv answers before a child exists: is there such a program at all?
 * `spawn('nope')` is an `ENOENT` on the child, not a shell's 127 reported as
 * an exit status, and Node's `ChildProcess` can only tell the two apart if
 * `Process.spawn` says so when it is called.
 */
let __shellCommandNames: Set<string> | null = null;
function shellCommandNames(): Set<string> {
  if (__shellCommandNames === null) __shellCommandNames = new Set([...getCommandNames(), 'node', 'npm']);
  return __shellCommandNames;
}

/** Whether a path names something the engine has. */
function existsInTree(path: string): boolean {
  const tree = treeForRun();
  if (!tree) return false;
  try { return tree.existsSync(path); } catch { return false; }
}

/**
 * The program the engine will actually run for the path a caller named.
 *
 * The engine's shell carries its commands under their plain names, and a
 * machine carries them at `/bin` and `/usr/bin`: `spawn('/usr/bin/env', …)`
 * means the shell's `env`, and that is what Node's own `test-child-process-env`
 * spawns. A file that really is in the tree at the path wins, because that is
 * a program the engine can run; the engine's own `node`, written to
 * `/usr/local/bin/node` when the shim is initialized, is one of those.
 */
/** The shells a script or a `-c` line runs under; a child of these goes to the host when there is one. */
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'dash', '/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash']);

function engineProgramFor(file: string, cwd?: string): string {
  const name = __substrateProgramName(file);
  if (!name.includes('/')) return name;
  if (existsInTree(__resolvePath(cwd ?? '/', name))) return name;
  const bare = name.slice(name.lastIndexOf('/') + 1);
  return shellCommandNames().has(bare) ? bare : name;
}

/** Whether the engine's shell can find a program under this name. */
function programExists(file: string, cwd: string | undefined, env: Record<string, string>): boolean {
  const name = __substrateProgramName(file);
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  // The engine's shell carries its commands under their plain names and at
  // the paths a machine carries them at: `/usr/bin/env` is `env`, which is
  // what `spawn('/usr/bin/env', …)` means and what a Dockerfile's shebang
  // reaches. A file in the tree is a program too, and so is one on PATH.
  if (shellCommandNames().has(bare)) return true;
  if (name.includes('/')) {
    const path = __resolvePath(cwd ?? '/', name);
    return existsInTree(path) && runsInEngine(path);
  }
  for (const dir of (env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/node_modules/.bin').split(':')) {
    const path = `${dir}/${name}`.replace(/\/+/gu, '/');
    if (dir.length > 0 && existsInTree(path) && runsInEngine(path)) return true;
  }
  return false;
}

/**
 * Whether a file in the tree is this engine's to run when a host could run it.
 * Linux's execve runs a script through the interpreter its `#!` line names and
 * a binary through its loader. This engine's own interpreters are Node (its
 * `node` command) and just-bash; a Node script stays here, where its `node` is
 * the engine's. Any other file goes to the host, whose kernel execs it: a shell
 * script spawned by path (Prisma's execa spawning a wrapper) ran in just-bash,
 * whose `exec node` found the host's `node` stub on PATH and ran the stub as
 * a script ("bash: \0Volter-host-executable-v1: command not found"). With no
 * host, every file but a registered stub stays here, as before.
 */
function runsInEngine(path: string): boolean {
  if (hostExecutor() === null) return !isRegisteredProgramStub(path);
  return isNodeScript(path);
}

/** A script whose `#!` line names node (directly, or through env): what npm's bins are. */
const NODE_INTERPRETER = /^#![ \t]*(?:\S*\/)?(?:env[ \t]+(?:-S[ \t]+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*)?node(?:[ \t]|$)/u;
function isNodeScript(path: string): boolean {
  if (!currentVfs) return false;
  try {
    if (!currentVfs.statSync(path).isFile()) return false;
    const bytes = fileHead(path);
    const end = bytes.indexOf(10);
    return NODE_INTERPRETER.test(new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)));
  } catch { return false; }
}

/** What a spawn reads to tell a file's kind (Linux's binfmt reads a bounded first block too). */
const FILE_HEAD_BYTES = 256;

/**
 * A file's first bytes, and no more: through the tree's own descriptors where
 * it has them (the kernel's tree, where a whole read is a read of every
 * byte), otherwise from the tree's file, which an in-memory tree holds whole.
 * Reading the whole file to see its first line read a multi-megabyte binary
 * on every spawn by path.
 */
function fileHead(path: string): Uint8Array {
  const door = treeDescriptorsOf(currentVfs);
  if (door) {
    const fd = door.open(path, 0, 0);
    try {
      const head = new Uint8Array(FILE_HEAD_BYTES);
      return head.subarray(0, door.read(fd, head, 0, FILE_HEAD_BYTES, 0));
    } finally { door.close(fd); }
  }
  return (currentVfs!.readFileSync(path) as Uint8Array).subarray(0, FILE_HEAD_BYTES);
}

/**
 * A program the page registered is not a file, so a host places a stub where
 * a loader looks for it (`#!/bin/sh` then `# <name>: runtime-registered
 * program`), for a caller that checks the path exists or walks PATH. The stub
 * is the page's program, not a script of this engine's: it is relayed to the
 * host, whose process host maps the pathname to the program by its basename.
 * The substrate's host executable (its ADR-0122 binfmt: a NUL, the format
 * line, then the handle's `sha256:` identity) is the same kind of file: as
 * `execve` would, it goes to the host that holds the handle, never to this
 * engine's shell, which read it as a script and ran its two lines as commands.
 */
const REGISTERED_PROGRAM_STUB = /^(?:#!\/bin\/sh\n# [\w.+-]+: runtime-registered program\n|\0Volter-host-executable-v1\nsha256:[a-f0-9]{64}\n)/u;
function isRegisteredProgramStub(path: string): boolean {
  if (!currentVfs) return false;
  try {
    const stat = currentVfs.statSync(path);
    if (!stat.isFile()) return false;
    const head = fileHead(path);
    if (stat.size <= FILE_HEAD_BYTES && REGISTERED_PROGRAM_STUB.test(new TextDecoder().decode(head))) return true;
    return isBinaryImage(head);
  } catch { return false; }
}

/**
 * A binary image (a NUL among its first bytes: WebAssembly's `\0asm`, ELF's
 * header, the host-executable format) is a program for `execve`, never a
 * script: this engine's shell parsed a 2.6 MB BusyBox image as one and
 * refused it ("Parse error at 1:1: Input too large"), where Linux's kernel
 * runs it. The host that holds the kernel runs it here too. Linux's
 * binfmt_script reads a script's first line; a NUL there is not a script.
 */
function isBinaryImage(bytes: Uint8Array): boolean {
  const head = Math.min(bytes.byteLength, 128);
  for (let index = 0; index < head; index += 1) if (bytes[index] === 0) return true;
  return false;
}

/** The runs a `Process` handle started, so a later name never lands on a live one. */
let __nextChildRun = 1;

/**
 * What a `Process` handle runs: a named run of the engine, with its streams
 * wired to the handle's pipes and its end reported once.
 *
 * A killed run reports its end at once. The engine has no signal to deliver:
 * a command already inside the shell cannot always be interrupted, and a
 * parent that called `kill` has no process left to wait for -- so the abort
 * goes out, the run's timers and handles are released as ending a process
 * releases them, and `onexit` carries the signal. Whatever the command does
 * afterwards is nobody's.
 */
function startChildRun(request: RunRequest): StartedRun {
  const token: ProcessToken = `child-${__nextChildRun++}`;
  // A child is a process and has its own number, which its parent reads off
  // the handle and the child itself reports as `process.pid`; `ppid` is the
  // number of the run that spawned it. `src/process-tokens.ts` says what
  // reads them.
  // In a process realm the admitted guest is always the spawning parent.
  // Async bookkeeping for a routed child must not make that child its parent.
  // The parent is the run whose `Process` handle spawned it (its NodeLibScope's process, the request's owner), never a
  // frame or a global; a spawn no run owns is the realm process's own.
  const parentPid = runPid(nodeProcessRealmToken() ?? request.owner)?.pid ?? 0;
  const pid = mintPid(parentPid, request.detached === true, request.owner);
  setRunPid(token, pid, parentPid,
    { detached: request.detached, argv: request.args.length ? request.args : [request.file], ...(request.cwd ? { cwd: request.cwd } : {}) }, request.owner);
  const controller = new AbortController();
  const pendingStdin: Array<Uint8Array | null> = [];
  // A host terminal consumes input incrementally. The old string-only
  // route dropped every keystroke that arrived after a child was launched.
  const nodeChild = __substrateRunsNode(request.file, request.cwd);
  const admittedNode = nodeProcessHostInstalled() && nodeChild;
  const hostTerminal = request.terminal !== undefined && hostExecutor() !== null && !admittedNode;
  // A `node` child the engine runs itself is started from its argv by the one
  // Node launch, as `execve` starts it, and is the run itself: its pid is the
  // one its parent's handle carries, its fds are the ones registered under
  // it, and its fd 0, 1 and 2 are bytes. Rebuilt into a command line for the
  // engine's shell, it was a second process under a shell run, and every
  // chunk it wrote was decoded to text on the way to its parent's pipe.
  const directNode = nodeChild && !admittedNode && !hostTerminal;
  if (!admittedNode && !directNode) shellRuns.add(token);
  let wakeInput: (() => void) | undefined;
  /**
   * A piped fd 0 that stays open for a program the host runs (a program pack,
   * not a builtin of the engine's shell): what the parent writes reaches it
   * as it is written, through the same live stream a terminal gets. A
   * builtin reads its input once, before it runs; a server that speaks
   * JSON-RPC over stdio (`supercode harness serve`) read that one string,
   * saw EOF and exited before its client's first request.
   */
  let liveInput = false;
  const hostInput: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      while (!finished && !controller.signal.aborted) {
        if (pendingStdin.length) {
          const bytes = pendingStdin.shift();
          if (bytes === null) return;
          if (bytes) yield bytes;
        } else await new Promise<void>((resolve) => { wakeInput = resolve; });
      }
    },
  };
  controller.signal.addEventListener('abort', () => { wakeInput?.(); }, { once: true });
  let stdinSink: RunStdin | null = null;
  let finished = false;
  let started = false;
  let killedBy: string | null = null;
  // Whether the child runs on the process host, in a realm of its own.
  let hosted = false;
  /** The host's process host runs this child (a program pack, a WALI image): it says when the child ends. */
  let hostRun = false;
  // The parent's wait for a child a host runs, read by that host: its handle's ref state (`Process.ref`, `unref`).
  const hold: { value: boolean; changed?: () => void } = { value: true };
  /** What the parent wrote to the child's fd 0 before the command began. */
  const initialStdin: Uint8Array[] = [];

  let flushingInput: Promise<void> | undefined;
  const flushStdin = (): void | Promise<void> => {
    if (flushingInput) return flushingInput;
    if (!stdinSink || finished) return;
    while (pendingStdin.length > 0) {
      const chunk = pendingStdin.shift() as Uint8Array | null;
      if (stdinSink.writeAsync) {
        const waiting = stdinSink.writeAsync(chunk);
        flushingInput = waiting.then(() => {
          flushingInput = undefined;
          return flushStdin();
        }, cause => { flushingInput = undefined; throw cause; });
        return flushingInput;
      }
      stdinSink.push(chunk);
    }
  };

  const streamedOut: string[] = [];
  const streamedErr: string[] = [];
  // A Node child's fd 1 and 2 reach the parent's pipe as the bytes it wrote,
  // with no text kept of them; a program that writes text (a shell builtin,
  // a host program) still arrives through the text sinks.
  const streams: RunStreams = {
    onStdout: (data: string) => { streamedOut.push(data); request.stdout?.(data); },
    onStderr: (data: string) => { streamedErr.push(data); request.stderr?.(data); },
    onStdoutBytes: (bytes: Uint8Array) => { request.stdout?.(bytes); },
    onStderrBytes: (bytes: Uint8Array) => { request.stderr?.(bytes); },
    signal: controller.signal,
    held: false,
    stdinOpen: request.stdinIsPipe,
    stderrIsPipe: request.stderrIsPipe,
    terminal: request.terminal,
    get stdin(): RunStdin | null | undefined { return stdinSink; },
    set stdin(sink: RunStdin | null | undefined) {
      stdinSink = sink ?? null;
      if (stdinSink) {
        const pending = flushStdin();
        if (pending) void pending.catch(cause => {
          // Normal child exit detaches the sink before cancelling its writer.
          // That cancellation must not turn a successful exit into failure.
          if (!finished && stdinSink === sink) { controller.abort(cause); end(1, null); }
        });
      }
    },
  };
  registerRunStreams(token, streams);
  // The child is started with the descriptors its parent wired: an IPC channel
  // is at the number its `NODE_CHANNEL_FD` will name, under this run's name,
  // because every child is told the same number.
  if (request.channel) registerRunFd(token, request.channel.fd, 'PIPE', request.channel.pipe);
  // Its pipes past fd 2 are there the same way, at the numbers it was given.
  for (const { fd, pipe } of request.descriptors) registerRunFd(token, fd, 'PIPE', pipe);

  const end = (code: number, signal: string | null): void => {
    if (finished) return;
    finished = true;
    wakeInput?.();
    wakeInput = undefined;
    _activeForkedChildren -= 1;
    releaseRunStreams(token);
    releaseRunFds(token);
    // The child's end is the kernel's: a child this realm ran itself (or that never started) exits here; one the host
    // or a realm of its own ran reported its own exit. Its parent's wait takes the end the process table holds.
    if (!started || (!hosted && !hostRun)) exitRunProcess(pid, parentPid, code, signal, request.owner);
    const ended = reapRunProcess(pid, parentPid, code, signal, request.owner);
    // A run that has ended is no longer a process: its number answers ESRCH.
    forgetRunPid(token);
    __substrateChildrenOf(request.owner).delete(pid);
    _onForkedChildExit?.();
    request.exit(ended.code, ended.signal);
  };

  /**
   * The command begins here, once, with whatever its standard input already
   * holds. The engine's shell takes a run's standard input as one string
   * given before the command runs -- `cat` and every other builtin read
   * `ctx.stdin` and nothing after it -- so a child whose fd 0 is a pipe waits
   * for the turn in which it was spawned to finish: `spawn('cat')`,
   * `stdin.write(...)`, `stdin.end()` is one synchronous block in every
   * program that does it, and the writes have landed by the time the realm's
   * own loop comes back. A write after that reaches a `node` run, whose fd 0
   * is a real stream, and is lost on a builtin, which has already read.
   */
  const begin = (): void => {
    if (started || finished) return;
    started = true;
    // A shell a hosted program spawns (`sh start.sh`, `sh -c '…'`) runs at
    // the host when there is one, not in this worker's own bash: the host is
    // where the programs the page registered live (`npx` under /usr/bin),
    // and where a `node` inside the script is given a named run. Run here,
    // the script's `node` found no name and was refused, and its `npx` was
    // not found at all.
    const shellChild = SHELL_PROGRAMS.has(engineProgramFor(request.file, request.cwd)) && hostExecutor() !== null;
    // env executes another program. The host owns installed package-bin
    // resolution, just as it owns shell dispatch; treating this wrapper as
    // an engine-only utility strands its operand in the private shell and
    // bypasses the admitted child-process door. Keep env's own interpreter
    // and options in the host, with the original cwd and environment.
    const environmentChild = engineProgramFor(request.file, request.cwd) === 'env' && hostExecutor() !== null;
    const engineFirst = !hostTerminal && !shellChild && !environmentChild && programExists(request.file, request.cwd, request.env);
    liveInput = !hostTerminal && !admittedNode && !directNode && request.stdinIsPipe && !engineFirst;
    if (liveInput) {
      pendingStdin.unshift(...initialStdin);
      initialStdin.length = 0;
    }
    // What the parent wrote before the command began: bytes for a Node child,
    // text only for the engine's shell, which reads its input as a string.
    const stdinBytes = initialStdin.length > 0 ? new Uint8Array(Buffer.concat(initialStdin)) : undefined;
    const stdin = stdinBytes !== undefined ? Buffer.from(stdinBytes).toString('utf8') : undefined;
    void (async () => {
      let outcome: CommandOutcome;
      try {
        const processHost = admittedNode ? nodeProcessHostFor(token) : undefined;
        hosted = processHost !== undefined;
        const env = { ...request.env };
        delete env[PROCESS_TOKEN_ENV];
        outcome = processHost ? await runHostedNode(processHost, {
          token, argv0: request.args[0] ?? request.file, argv: request.args.slice(1), cwd: request.cwd ?? '/',
          filesystem: currentVfs!, env, streams, ...(stdinBytes !== undefined ? { stdin: stdinBytes } : {}),
        }) : directNode ? await enterRun(token, () => launchNode(treeForRun() ?? currentVfs!, {
          argv: request.args.length > 0 ? request.args : [request.file],
          cwd: request.cwd ?? '/',
          env,
          ...(stdinBytes !== undefined ? { stdin: stdinBytes } : {}),
          token,
        })) : await enterRun(token, () => routeCommand({
          command: __substrateLineFor(request.file, request.args, request.cwd),
          ...(((argv) => argv ? { argv } : {})(__substrateArgvFor(request.file, request.args, request.cwd))),
          engineFirst,
          cwd: request.cwd,
          env: { ...request.env, [PROCESS_TOKEN_ENV]: token },
          stdin,
          ...(hostTerminal ? { stdinStream: hostInput, terminal: request.terminal } : liveInput ? { stdinStream: hostInput } : {}),
          signal: controller.signal,
          onStdout: streams.onStdout,
          onStderr: streams.onStderr,
          onStdoutBytes: streams.onStdoutBytes,
          onStderrBytes: streams.onStderrBytes,
          descriptors: request.descriptors,
          onHostRun: () => { hostRun = true; },
          hold,
        }));
      } catch (error) {
        outcome = { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
      // A command the engine's shell ran to the end and did not stream --
      // every builtin -- delivers its output here; the `node` command streamed
      // its own as it went, and only what it has not already sent is left
      // (`streamed-output.ts` says why that is not a cut at a length).
      const restOut = unstreamedOutput(outcome.stdout, streamedOut);
      const restErr = unstreamedOutput(outcome.stderr, streamedErr);
      if (restOut) request.stdout?.(restOut);
      if (restErr) request.stderr?.(restErr);
      end(outcome.exitCode, outcome.signal ?? null);
    })();
  };

  _activeForkedChildren += 1;
  if (request.stdinIsPipe && !admittedNode) (globalThis.__browserRuntimeNativeSetTimeout ?? setTimeout).call(globalThis, begin, 0);
  else begin();

  const control: StartedRun = {
    token,
    pid,
    kill(signal: string): number {
      if (finished) return UV_ESRCH;
      // A child in a realm of its own takes a catchable signal as a machine's
      // process does: its listeners run, else its default action ends it, and
      // it ends by its own outcome. Only when nothing there receives it does
      // the parent end it here.
      if (hosted && signal !== 'SIGKILL' && signal !== 'SIGSTOP' && signalPid(pid, signal, request.owner)) return 0;
      // A child the host runs takes the signal there (the abort carries it) and ends when the program does,
      // as a Linux child stays live and waitable until it exits: a postmaster's SIGINT is its fast shutdown,
      // which still writes a checkpoint, and a handler may survive the signal. Its end is the host's result.
      if (hostRun) {
        controller.abort(signal);
        return 0;
      }
      killedBy = signal;
      controller.abort(signal);
      __releaseOwnedServers(token, false);
      __releaseOwnedHandles(token);
      __stopOwnedProcess(token);
      end(0, killedBy);
      return 0;
    },
    writeStdin(bytes: Uint8Array): void | Promise<void> {
      if (hostTerminal || liveInput) { pendingStdin.push(bytes); wakeInput?.(); wakeInput = undefined; return; }
      if (!started) { initialStdin.push(bytes); return; }
      pendingStdin.push(bytes);
      return flushStdin();
    },
    setRef(held: boolean): void {
      if (hold.value === held) return;
      hold.value = held;
      hold.changed?.();
    },
    endStdin(): void {
      if (hostTerminal || liveInput) { pendingStdin.push(null); wakeInput?.(); wakeInput = undefined; return; }
      if (!started) {
        // The writer closed before the command began: the run's fd 0 is the
        // string already collected and nothing more, so it is not held open.
        streams.stdinOpen = false;
        begin();
        // A live pipe closed before it began still ends where it was closed.
        if (liveInput) { pendingStdin.push(null); wakeInput?.(); wakeInput = undefined; }
        return;
      }
      pendingStdin.push(null);
      const sink = stdinSink;
      const pending = flushStdin();
      if (pending) void pending.catch(cause => {
        if (!finished && stdinSink === sink && sink) { controller.abort(cause); end(1, null); }
      });
    },
  };
  // A pid is signalable before spawn returns, including cancellation in
  // the same turn. A diagnostics-channel microtask registered it too late.
  __substrateChildrenOf(request.owner).set(pid, {
    exitCode: null, signalCode: null,
    kill: (signal = 'SIGTERM') => control.kill(signal) === 0,
  });
  return control;
}


export default {
  initChildProcess,
  registerRunStreams,
  releaseRunStreams,
  runCommand,
  runNode,
  sendStdin,
};
