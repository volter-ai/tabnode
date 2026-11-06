import { processCredentialsOf, copyProcessCredentials, spawnedProcessCredentials, type ProcessCredentials } from '../../process-credentials';
/**
 * `internalBinding('spawn_sync')`: a child run to its end before the call
 * returns.
 *
 * libuv's `uv_spawn_sync` answers one record -- a status, a signal, the bytes
 * each descriptor produced, and an error where the child never started -- and
 * `internal/child_process.js`'s `spawnSync` is four lines over it. That
 * record is what this file answers, over `src/shims/sync-child.ts`: a thread
 * of its own running a second engine, with every filesystem call crossing
 * back to the caller. Where a realm cannot block at all, the error is
 * `UV_ENOSYS`, which is what Node reports for a child it could not start.
 * In a process with socket calls, a child its host runs is given its stdio
 * as kernel descriptors, and this realm reads and writes its own ends with
 * blocking `poll` until they close, as libuv's SyncProcessRunner loops over
 * them (ADR-0010 §4).
 */
import { libRequire } from '../require-hook';
import { UV_EPERM, UV_EINVAL, UV_ENOSYS, UV_ENOENT, UV_EACCES, UV_ENOBUFS, UV_ETIMEDOUT, UV_EBADF } from './uv';
import { runSyncChild, syncChildRefusal } from '../../shims/sync-child';
import { __substrateArgvFor, __substrateHostRuns, __substrateLineFor, __substrateRunsNode, __substrateShellLine, __substrateShellWord } from '../../shims/command-line';
import { inheritedWriter } from './process_wrap';
import { __currentProcessToken, enterRun, exitRunProcess, forgetRunPid, mintPid, reapRunProcess, runPidOf, setRunPid, signalPid, type ProcessToken } from '../../process-tokens';
import { callingSockets, callingTree, linux, type PollDescriptor, type TreeSockets } from '../../host-sockets';
import { prepareChildStdio, type ChildStdioEntry, type PreparedChildStdio } from './child_stdio';
import { treeDescriptorsOf, type TreeDescriptors } from '../../tree-descriptors';
import { __substrateSignalNames } from '../../shims/process';

/** One entry of Node's `options.stdio`, as `getValidStdio(stdio, true)` builds it. */
interface SyncStdioEntry {
  type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap';
  fd?: number;
  input?: Uint8Array;
  /** The child reads the pipe (Node's `UV_READABLE_PIPE`). */
  readable?: boolean;
  /** The child writes the pipe (`UV_WRITABLE_PIPE`). */
  writable?: boolean;
}

/** What `child_process.js`'s `spawnSync` hands the binding. */
interface SyncSpawnOptions {
  file: string;
  uid?: number;
  gid?: number;
  args?: string[];
  cwd?: string;
  envPairs?: string[];
  stdio?: SyncStdioEntry[];
  maxBuffer?: number;
  killSignal?: number;
  timeout?: number;
}

/**
 * A host's door for a synchronous child it runs (a program its kernel holds): the twin of its `run`. It blocks this
 * realm until the child has ended, handing each fd's bytes to `onStdout`/`onStderr` as they arrive, and answers
 * the child's end. A host that cannot (a realm that may not block, a host with no such door here) answers a
 * `refusal` that says why and starts nothing.
 */
interface SyncChildHost {
  /** The embedding owns every child of the current run, including Node and
   * image scripts the engine can also resolve. This is a trusted host choice,
   * not a request to recover a raw Worker constructor in a restricted realm. */
  readonly ownsAllSyncChildren?: boolean;
  runSync?(command: string, request: {
    argv?: readonly string[];
    /** The actual exec selector, independent of a caller's custom argv[0]. */
    executablePath?: string;
    cwd?: string;
    env?: Record<string, string>;
    credentials?: ProcessCredentials;
    input?: Uint8Array;
    /** Which of fd 1 and fd 2 count toward `maxBuffer`: the ones the caller captures. */
    captured?: [boolean, boolean];
    maxBuffer?: number;
    timeout?: number;
    killSignal?: number;
    onStdout?(bytes: Uint8Array): void;
    onStderr?(bytes: Uint8Array): void;
    /**
     * The kernel descriptors the child starts with, as `NodeProcessLaunch.descriptors` (ADR-0010 §4): each `fd` of the
     * child's table a `dup2` of its fork's copy of `from`. Where given, the child's stdio is its own and there is no
     * `input`, `captured`, `maxBuffer`, `onStdout` or `onStderr`: the host calls `drain` once the child runs (after its
     * exec, before it waits for the child's end), which returns once this realm's ends of the child's pipes are
     * closed, then waits for the end with `timeout` and `killSignal` as before.
     */
    kernelDescriptors?: readonly { fd: number; from: number }[];
    drain?(): void;
  }): { started: boolean; status: number | null; signal: string | null; error?: 'ETIMEDOUT' | 'ENOBUFS' | 'ENOENT' | 'ENOTDIR'; refusal?: string; hostStarted?: boolean; endPosted?: boolean };
}
const hostExecutorSymbol = Symbol.for('@volter/browser-runtime/child-process-executor');
let nextSyncChild = 1;

/** What libuv answers for one synchronous child. */
interface SyncSpawnResult {
  pid: number;
  output: Array<Uint8Array | null> | null;
  status: number | null;
  signal: string | null;
  error?: number;
}

let nextPid = 1001 + Math.floor(Math.random() * 30000);

function environmentOf(envPairs: string[] | undefined): Record<string, string> | undefined {
  if (!envPairs) return undefined;
  const env: Record<string, string> = {};
  for (const pair of envPairs) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return env;
}

/**
 * Whether a child's fd is the caller's own descriptor rather than bytes kept for the caller: an `inherit` entry,
 * or a descriptor named by number, which is what `stdio: 'inherit'` reaches this binding as.
 */
function passedOn(entry: SyncStdioEntry | undefined): boolean {
  return entry?.type === 'inherit' || entry?.type === 'fd';
}

/**
 * libuv's synchronous spawn. Everything above it -- the encoding of the
 * output, the `Error` an `error` number becomes, `execSync`'s throw -- is
 * Node's own and is vendored.
 */
/** Node's own `Buffer`, read when a child answers rather than when this loads. */
function bufferClass(): { from(value: unknown, encoding?: string): Uint8Array & { toString(encoding?: string): string } } {
  return (libRequire('buffer') as { Buffer: { from(value: unknown, encoding?: string): Uint8Array & { toString(encoding?: string): string } } }).Buffer;
}

function spawn(options: SyncSpawnOptions, credentials: Readonly<ProcessCredentials> = copyProcessCredentials()): SyncSpawnResult {
  const Buffer = bufferClass();
  const pid = nextPid++;
  const argv = options.args ?? [options.file];
  const stdio = options.stdio ?? [];
  const nothing = (error: number, of: number = pid): SyncSpawnResult => ({ pid: of, output: null, status: null, signal: null, error });

  const parentCredentials = credentials;
  const declaredIdentity = options.uid != null || options.gid != null;
  try { credentials = spawnedProcessCredentials(credentials, options.uid, options.gid); }
  catch (cause) { return nothing((cause as { code?: string })?.code === 'EPERM' ? UV_EPERM : UV_EINVAL, 0); }

  // A realm that cannot run a synchronous child at all says which of its reasons it is. libuv's record has room for
  // an errno only, and Node's own `spawnSync` (internal/child_process.js) makes the Error from it and stores it back
  // on the record's `error`; the reason is added to that Error's message as it is stored, so `result.error.message`
  // and the Error `execSync` throws read "spawnSync <file> ENOSYS: <reason>". Without it the four refusals were one
  // indistinguishable ENOSYS.
  const refusedBecause = (refusal: string, of: number = pid): SyncSpawnResult => {
    let error: unknown = UV_ENOSYS;
    const refused = nothing(UV_ENOSYS, of);
    Object.defineProperty(refused, 'error', {
      enumerable: true,
      configurable: true,
      get: () => error,
      set: (value: unknown) => {
        const made = value as { message?: unknown } | null;
        if (made && typeof made === 'object' && typeof made.message === 'string' && !made.message.includes(refusal)) made.message = `${made.message}: ${refusal}`;
        error = value;
      },
    });
    return refused;
  };

  // Where the child's fd 1 and fd 2 go when they are the caller's own descriptors, by the rule an asynchronous
  // child's go by; a writer holding its own reference to a description lets it go when the child has ended.
  const asking = __currentProcessToken();
  const sinks = ([1, 2] as const).map((index) => passedOn(stdio[index]) ? inheritedWriter(stdio[index]!.fd ?? index, asking) : null);
  const sink = (index: 1 | 2): ((bytes: Uint8Array) => void) | undefined => sinks[index - 1] ?? undefined;
  // Each writer's bytes are written before it is let go (ADR-0010 §2): this realm blocks for a full description.
  const releaseSinks = (): void => { for (const held of sinks) { held?.settleBlocking?.(); held?.release?.(); } };
  // A descriptor the caller names and does not hold fails the spawn, as libuv's does (`spawnSync ... EBADF`, no
  // pid, no output). The caller's own fd 1 and 2 always stand for its output, held or not. In a process with socket
  // calls the kernel answers whether it holds it (`prepareChildStdio`).
  if (!callingSockets() && ([1, 2] as const).some((index) => passedOn(stdio[index]) && sinks[index - 1] === null && (stdio[index]!.fd ?? index) > 2)) {
    releaseSinks();
    return nothing(UV_EBADF, 0);
  }

  const input = stdio[0]?.input;
  // Node's limit (SyncProcessRunner::IncrementBufferSizeAndCheckOverflow): a positive maxBuffer bounds the captured
  // bytes of every output pipe together; zero, or none, sets no limit (ADR-0010 §4).
  const maxBuffer = typeof options.maxBuffer === 'number' && options.maxBuffer > 0 ? options.maxBuffer : Infinity;
  const realm = (globalThis as unknown as { process?: { cwd?: () => string; env?: Record<string, string> } & Record<symbol, unknown> }).process;
  // The tree of the run that asks, which a host may have given that run alone.
  const runTree = realm?.[Symbol.for('tabnode.run.vfs')] as Parameters<typeof runSyncChild>[0]['tree'];
  const cwd = options.cwd ?? (typeof realm?.cwd === 'function' ? realm.cwd() : undefined);
  const env = environmentOf(options.envPairs) ?? (realm?.env ? { ...realm.env } : undefined);

  // A host may own every child of this run: even an engine-resolvable image
  // script must then use that process owner. A restricted realm deliberately
  // has no raw Worker; selecting the fallback because its shell knows a program
  // refused spawnSync before reaching the already installed synchronous door.
  // Other embeddings retain the same program classification as async children.
  // The child is forked under this run before the wait and reaped at its end.
  const host = (globalThis as unknown as Record<symbol, SyncChildHost | undefined>)[hostExecutorSymbol];
  const ownsAllSyncChildren = host?.ownsAllSyncChildren === true;
  if (host && typeof host.runSync === 'function' && (ownsAllSyncChildren || __substrateHostRuns(options.file, cwd, env ?? {}) || (declaredIdentity && __substrateRunsNode(options.file, cwd)))) {
    const owner = __currentProcessToken();
    const parentPid = runPidOf(owner) ?? 0;
    const token = `sync-child-${nextSyncChild++}`;
    // In a process with socket calls the child's stdio is made in this process's kernel table before its fork, as
    // uv__process_init_stdio makes it (ADR-0010 §4).
    const sockets = callingSockets();
    const kernel = sockets ? syncStdio(stdio, sockets, treeDescriptorsOf(callingTree())) : undefined;
    if (typeof kernel === 'number') { releaseSinks(); return nothing(kernel, 0); }
    let childPid: number;
    try { childPid = mintPid(parentPid, false, owner, declaredIdentity ? credentials : undefined); }
    catch (cause) {
      releaseSinks();
      kernel?.prepared.closeAll();
      const code = (cause as { code?: string })?.code;
      if (code === 'EPERM' || code === 'EINVAL') return nothing(code === 'EPERM' ? UV_EPERM : UV_EINVAL, 0);
      throw cause;
    }
    // Forked, the child holds its own copies of what was made for it, as at spawn's hand-over (ADR-0010 §2).
    kernel?.prepared.makeBlocking();
    kernel?.prepared.closeMade();
    setRunPid(token, childPid, parentPid, { argv, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }, owner);
    const kept = new Map<number, Uint8Array[]>();
    const keep = (index: number, bytes: Uint8Array): void => {
      const chunks = kept.get(index);
      if (chunks) chunks.push(bytes); else kept.set(index, [bytes]);
    };
    const take = (index: 1 | 2) => (bytes: Uint8Array): void => {
      const entry = stdio[index];
      if (passedOn(entry)) sink(index)?.(bytes);
      else if (entry?.type !== 'ignore') keep(index, bytes.slice());
    };
    const captured = (index: number): boolean => kernel ? kernel.pipes.some(pipe => pipe.index === index && pipe.reading)
      : (index === 1 || index === 2) && stdio[index]?.type !== 'ignore' && !passedOn(stdio[index]);
    const killSignal = typeof options.killSignal === 'number' ? options.killSignal : 15;
    let drained: DrainOutcome | undefined;
    // The timeout runs from the spawn, as SyncProcessRunner starts its kill timer.
    const spawnedAt = Date.now();
    let answer: ReturnType<NonNullable<SyncChildHost['runSync']>>;
    try {
      // An owning kernel resolves the original file itself; engine aliases
      // must not turn an absolute Node path into a different PATH lookup, or
      // replace custom argv[0]. Shell argv also stays whole on this route.
      const list = ownsAllSyncChildren ? [...argv] : __substrateArgvFor(options.file, argv, options.cwd);
      const line = ownsAllSyncChildren
        ? [options.file, ...argv.slice(1)].map((word) => __substrateShellWord(String(word))).join(' ')
        : __substrateLineFor(options.file, argv, options.cwd);
      answer = enterRun(token, () => host.runSync!(line, {
        ...(list ? { argv: list } : {}),
        ...(ownsAllSyncChildren ? { executablePath: options.file } : {}),
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        credentials,
        ...(typeof options.timeout === 'number' && options.timeout > 0 ? { timeout: options.timeout } : {}),
        ...(typeof options.killSignal === 'number' ? { killSignal: options.killSignal } : {}),
        ...(kernel ? {
          kernelDescriptors: kernel.prepared.placed.map(each => ({ ...each })),
          drain: () => {
            drained ??= drainSyncPipes(kernel.pipes, sockets!, {
              deadline: typeof options.timeout === 'number' && options.timeout > 0 ? spawnedAt + options.timeout : Infinity,
              maxBuffer,
              keep,
              kill: () => killChild(childPid, killSignal, owner),
            }, kernel.prepared.closeAll);
          },
        } : {
          ...(input === undefined ? {} : { input: new Uint8Array(input) }),
          captured: [captured(1), captured(2)] as [boolean, boolean],
          ...(Number.isFinite(maxBuffer) ? { maxBuffer } : {}),
          onStdout: take(1),
          onStderr: take(2),
        }),
      }));
    } catch (cause) {
      answer = { started: false, status: null, signal: null, refusal: cause instanceof Error ? cause.message : String(cause) };
    }
    releaseSinks();
    kernel?.prepared.closeAll();
    // Only a child with neither an image handoff nor an already posted end
    // permits a local launch failure. The kernel's actual end wins at reap;
    // a host rejection must not kill a handed image or replace a posted end.
    if (!answer.started && answer.hostStarted !== true && answer.endPosted !== true) exitRunProcess(childPid, parentPid, 0, 'SIGKILL', owner);
    const ended = reapRunProcess(childPid, parentPid, answer.status ?? 0, answer.signal, owner);
    forgetRunPid(token);
    // A working directory that is not there is the child's ENOENT, as Node reports a bad `cwd` for a spawn.
    if (!answer.started && (answer.error === 'ENOENT' || answer.error === 'ENOTDIR')) return nothing(UV_ENOENT, childPid);
    if (!answer.started) return refusedBecause(answer.refusal ?? 'the host did not start the child', childPid);
    const join = (chunks: Uint8Array[]): Uint8Array => {
      const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let at = 0;
      for (const chunk of chunks) { whole.set(chunk, at); at += chunk.byteLength; }
      return Buffer.from(whole);
    };
    const hostOutput: Array<Uint8Array | null> = [null];
    for (let index = 1; index < Math.max(3, stdio.length); index += 1) {
      hostOutput.push(captured(index) ? join(kept.get(index) ?? []) : null);
    }
    // The shell's own "not found" for a program the caller named is ENOENT, as below.
    const saidByHost = __substrateShellLine(options.file, argv) === null && (ended.code === 127 || ended.code === 126) && captured(2) ? new TextDecoder().decode(join(kept.get(2) ?? [])) : '';
    if (ended.code === 127 && /command not found|No such file or directory/u.test(saidByHost)) return nothing(UV_ENOENT, childPid);
    if (ended.code === 126 && /Permission denied|not executable/u.test(saidByHost)) return nothing(UV_EACCES, childPid);
    return {
      pid: childPid,
      output: hostOutput,
      status: ended.signal ? null : ended.code,
      signal: ended.signal,
      // SyncProcessRunner::GetError: the runner's own error (a timeout, a full buffer) before a pipe's.
      ...(drained?.error === UV_ETIMEDOUT || answer.error === 'ETIMEDOUT' ? { error: UV_ETIMEDOUT }
        : drained?.error === UV_ENOBUFS || answer.error === 'ENOBUFS' ? { error: UV_ENOBUFS }
        : drained?.pipeError !== undefined ? { error: drained.pipeError } : {}),
    };
  }


  // The fallback worker proxies filesystem calls through the parent tree. It cannot act as a different
  // kernel identity: declared Node children use the host door above; an embedding without it is refused.
  if (credentials.uid !== parentCredentials.uid || credentials.gid !== parentCredentials.gid
    || credentials.groups.length !== parentCredentials.groups.length
    || credentials.groups.some((group, index) => group !== parentCredentials.groups[index])) {
    releaseSinks(); return refusedBecause('a synchronous child with different credentials requires a kernel host child door');
  }
  // A realm that cannot run a synchronous child of the engine's own says which of its reasons it is.
  const refusal = syncChildRefusal();
  if (refusal !== null) { releaseSinks(); return refusedBecause(refusal); }
  let answer;
  try {
    // A child that is the engine's Node goes by its argv, as `spawn` starts
    // one, and its fds are bytes both ways; the input is the bytes Node's
    // `spawnSync` was given, whatever their encoding.
    answer = runSyncChild({
      ...(runTree ? { tree: runTree } : {}),
      command: __substrateLineFor(options.file, argv, options.cwd),
      ...(__substrateRunsNode(options.file, options.cwd) ? { argv } : {}),
      cwd,
      env,
      credentials,
      ...(input === undefined ? {} : { input: new Uint8Array(input) }),
      onStdout: sink(1),
      onStderr: sink(2),
    });
  } catch {
    releaseSinks();
    return nothing(UV_ENOSYS);
  }
  releaseSinks();

  // A program the shell has no command for is absent, as it is on a machine
  // that does not carry that binary; a path that is there and is not a program
  // is the shell's 126 and Node's EACCES. Only a caller that named a program
  // can say so: a `-c` line is the shell's own, and its 127 is the line's.
  const named = __substrateShellLine(options.file, argv) === null;
  const said = named && (answer.status === 127 || answer.status === 126) ? new TextDecoder().decode(answer.stderr) : '';
  if (named && answer.status === 127 && /command not found|No such file or directory/u.test(said)) {
    return nothing(UV_ENOENT);
  }
  if (named && answer.status === 126 && /Permission denied|not executable/u.test(said)) {
    return nothing(UV_EACCES);
  }

  // Past `maxBuffer` the child is reported as having failed, and the bytes it
  // had already produced come back whole: libuv reads in blocks and hands
  // over what it read, which is why Node's own test says "we can have buffers
  // larger than maxBuffer".
  const stdout = Buffer.from(answer.stdout);
  const stderr = Buffer.from(answer.stderr);
  // Only bytes kept for the caller count, both fds together: a descriptor passed on is not a buffer of this call's.
  const kept = (index: 1 | 2): boolean => stdio[index]?.type !== 'ignore' && !passedOn(stdio[index]);
  const overflowed = (kept(1) ? stdout.length : 0) + (kept(2) ? stderr.length : 0) > maxBuffer;
  const output: Array<Uint8Array | null> = [null];
  for (let index = 1; index < Math.max(3, stdio.length); index += 1) {
    const bytes = index === 1 ? stdout : index === 2 ? stderr : null;
    output.push(bytes === null || !kept(index as 1 | 2) ? null : bytes);
  }

  return {
    pid,
    output,
    status: answer.status,
    signal: answer.signal,
    ...(overflowed ? { error: UV_ENOBUFS } : {}),
  };
}

/** What the loop over a synchronous child's pipes ended with: the runner's error, else the first pipe's. */
interface DrainOutcome {
  error?: number;
  pipeError?: number;
}

/** One of this realm's ends of a synchronous child's pipe: what the child's fd `index` is read and written through. */
interface SyncPipe {
  fd: number;
  index: number;
  /** The child writes it: read until its end. */
  reading: boolean;
  /** The child reads it: `input` written, then shut down. */
  writing: boolean;
  input: Uint8Array;
  sent: number;
}

/** One read's room, as libuv's sync runner allocates per read. */
const READ_BYTES = 64 * 1024;

/**
 * A synchronous child's stdio (ADR-0010 §4), made by the preparation `spawn` shares (`prepareChildStdio`), an absent
 * fd 0 to 2 ignored: the pipes this realm's loop serves, by the child's fd, Node's `readable` (the child reads it) and
 * `writable` (the child writes it) saying which way.
 */
function syncStdio(stdio: readonly SyncStdioEntry[], sockets: TreeSockets, files: TreeDescriptors | undefined): { prepared: PreparedChildStdio; pipes: SyncPipe[] } | number {
  const entries = Array.from({ length: Math.max(3, stdio.length) }, (_, index): ChildStdioEntry => {
    const entry = stdio[index];
    if (!entry) return index < 3 ? { type: 'ignore' } : { type: 'none' };
    switch (entry.type) {
      case 'pipe': case 'overlapped': return { type: 'pipe' };
      case 'inherit': case 'fd': return { type: 'inherit', fd: entry.fd ?? index };
      case 'ignore': return { type: 'ignore' };
      case 'wrap': return { type: 'none' };
    }
  });
  const prepared = prepareChildStdio(entries, sockets, files);
  if (typeof prepared === 'number') return prepared;
  const pipes: SyncPipe[] = [];
  entries.forEach((entry, index) => {
    const fd = entry.type === 'pipe' ? prepared.parentEnd(index) : undefined;
    if (fd === undefined) return;
    const given = stdio[index]!;
    const writing = given.readable ?? index === 0;
    pipes.push({ fd, index, writing, reading: given.writable ?? index !== 0, input: writing ? given.input ?? new Uint8Array(0) : new Uint8Array(0), sent: 0 });
  });
  return { prepared, pipes };
}

interface DrainLimits {
  /** When `timeout` runs out (Date.now's clock), or Infinity. */
  deadline: number;
  /** The output bytes kept before the child is ended `ENOBUFS`, or Infinity. */
  maxBuffer: number;
  keep(index: number, bytes: Uint8Array): void;
  kill(): void;
}

/**
 * libuv's SyncProcessRunner loop over this realm's ends of a synchronous child's pipes (Node v24.21.0
 * `src/spawn_sync.cc`), with blocking `poll` (ADR-0010 §4): each pipe the child reads is written its input and shut
 * down; each it writes is read to its end, every byte kept; when `timeout` runs out (`ETIMEDOUT`) or the bytes kept pass
 * `maxBuffer` (`ENOBUFS`) the child is killed with `killSignal` and every pipe closed (`Kill`, `CloseStdioPipes`). A
 * pipe's failure is the first pipe error, reported only where the runner has none of its own. Returns once every end is
 * closed, the child's end itself being the host's wait.
 */
function drainSyncPipes(pipes: SyncPipe[], sockets: TreeSockets, limits: DrainLimits, closePipes: () => void): DrainOutcome {
  const outcome: DrainOutcome = {};
  const room = new Uint8Array(READ_BYTES);
  let buffered = 0;
  const end = (error: number): DrainOutcome => {
    outcome.error = error;
    limits.kill();
    closePipes();
    return outcome;
  };
  const fail = (pipe: SyncPipe, error: number): void => {
    outcome.pipeError ??= error;
    pipe.reading = false;
    pipe.writing = false;
  };
  // Each round serves every ready pipe once (one send, one read) and then reads the clock, so the deadline holds
  // whatever the pipes' readiness and no pipe waits on another's flood (SyncProcessRunner's kill timer).
  for (;;) {
    for (const pipe of pipes) {
      if (pipe.writing && pipe.sent >= pipe.input.byteLength) {
        pipe.writing = false;
        const shut = sockets.shutdown(pipe.fd, linux.SHUT_WR);
        if (shut < 0) fail(pipe, shut);
      }
    }
    const asked: (PollDescriptor & { pipe: SyncPipe })[] = pipes.filter(pipe => pipe.reading || pipe.writing)
      .map(pipe => ({ fd: pipe.fd, events: (pipe.reading ? linux.POLLIN : 0) | (pipe.writing ? linux.POLLOUT : 0), revents: 0, pipe }));
    if (asked.length === 0) { closePipes(); return outcome; }
    if (Date.now() >= limits.deadline) return end(UV_ETIMEDOUT);
    const wait = Number.isFinite(limits.deadline) ? Math.max(0, limits.deadline - Date.now()) : -1;
    const ready = sockets.poll(asked, wait);
    if (ready === -linux.EINTR || ready === 0) continue;
    if (ready < 0) { for (const { pipe } of asked) fail(pipe, ready); continue; }
    for (const { pipe, revents } of asked) {
      if (revents === 0) continue;
      if (pipe.writing && pipe.sent < pipe.input.byteLength) {
        const sent = sockets.sendto(pipe.fd, pipe.input.subarray(pipe.sent), linux.MSG_DONTWAIT | linux.MSG_NOSIGNAL, null);
        if (sent >= 0) pipe.sent += sent;
        else if (sent !== -linux.EAGAIN && sent !== -linux.EINTR) fail(pipe, sent);
      }
      if (!pipe.reading) continue;
      const read = sockets.recvfrom(pipe.fd, room, linux.MSG_DONTWAIT, null);
      if (read === -linux.EAGAIN || read === -linux.EINTR) continue;
      if (read < 0) { fail(pipe, read); continue; }
      if (read === 0) { pipe.reading = false; continue; }
      limits.keep(pipe.index, room.slice(0, read));
      buffered += read;
      if (buffered > limits.maxBuffer) return end(UV_ENOBUFS);
    }
  }
}

/** SyncProcessRunner::Kill's signal: `killSignal`, or SIGKILL for a signal that has no name; a child already gone is ESRCH and left. */
function killChild(pid: number, signal: number, owner: ProcessToken | null): void {
  signalPid(pid, __substrateSignalNames[signal] ?? 'SIGKILL', owner);
}

export default { spawn };

/** The binding captures its caller's own process independently of ambient globals. */
export function createSpawnSyncBinding(parent: object): { spawn: (options: SyncSpawnOptions) => SyncSpawnResult } {
  return { spawn: options => spawn(options, processCredentialsOf(parent)) };
}
