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
 */
import { libRequire } from '../require-hook';
import { UV_ENOSYS, UV_ENOENT, UV_EACCES, UV_ENOBUFS, UV_ETIMEDOUT, UV_EBADF } from './uv';
import { runSyncChild, syncChildRefusal } from '../../shims/sync-child';
import { __substrateArgvFor, __substrateHostRuns, __substrateLineFor, __substrateRunsNode, __substrateShellLine } from '../../shims/command-line';
import { inheritedWriter } from './process_wrap';
import { __currentProcessToken, enterRun, exitRunProcess, forgetRunPid, mintPid, reapRunProcess, runPid, setRunPid } from '../../process-tokens';

/** One entry of Node's `options.stdio`, as `getValidStdio(stdio, true)` builds it. */
interface SyncStdioEntry {
  type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap';
  fd?: number;
  input?: Uint8Array;
}

/** What `child_process.js`'s `spawnSync` hands the binding. */
interface SyncSpawnOptions {
  file: string;
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
  runSync?(command: string, request: {
    argv?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    input?: Uint8Array;
    /** Which of fd 1 and fd 2 count toward `maxBuffer`: the ones the caller captures. */
    captured: [boolean, boolean];
    maxBuffer?: number;
    timeout?: number;
    killSignal?: number;
    onStdout(bytes: Uint8Array): void;
    onStderr(bytes: Uint8Array): void;
  }): { started: boolean; status: number | null; signal: string | null; error?: 'ETIMEDOUT' | 'ENOBUFS' | 'ENOENT' | 'ENOTDIR'; refusal?: string };
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

function spawn(options: SyncSpawnOptions): SyncSpawnResult {
  const Buffer = bufferClass();
  const pid = nextPid++;
  const argv = options.args ?? [options.file];
  const stdio = options.stdio ?? [];
  const nothing = (error: number, of: number = pid): SyncSpawnResult => ({ pid: of, output: null, status: null, signal: null, error });

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
  const releaseSinks = (): void => { for (const held of sinks) held?.release?.(); };
  // A descriptor the caller names and does not hold fails the spawn, as libuv's does (`spawnSync ... EBADF`, no
  // pid, no output): the child's bytes were dropped in silence. The caller's own fd 1 and 2 always stand for its
  // output, held or not.
  if (([1, 2] as const).some((index) => passedOn(stdio[index]) && sinks[index - 1] === null && (stdio[index]!.fd ?? index) > 2)) {
    releaseSinks();
    return nothing(UV_EBADF, 0);
  }

  const input = stdio[0]?.input;
  const realm = (globalThis as unknown as { process?: { cwd?: () => string; env?: Record<string, string> } & Record<symbol, unknown> }).process;
  // The tree of the run that asks, which a host may have given that run alone.
  const runTree = realm?.[Symbol.for('tabnode.run.vfs')] as Parameters<typeof runSyncChild>[0]['tree'];
  const cwd = options.cwd ?? (typeof realm?.cwd === 'function' ? realm.cwd() : undefined);
  const env = environmentOf(options.envPairs) ?? (realm?.env ? { ...realm.env } : undefined);

  // A program the host runs (one its kernel holds: git, a shell script, psql) is the host's synchronous child, by
  // the rule its asynchronous child goes by. It is a process as that one is: forked here, under this run, before
  // the wait; run by the host as that process; reaped here when the wait ends, by the wait every child's end takes.
  const host = (globalThis as unknown as Record<symbol, SyncChildHost | undefined>)[hostExecutorSymbol];
  if (host && typeof host.runSync === 'function' && __substrateHostRuns(options.file, cwd, env ?? {})) {
    const owner = __currentProcessToken();
    const parentPid = runPid(owner)?.pid ?? 0;
    const token = `sync-child-${nextSyncChild++}`;
    const childPid = mintPid(parentPid, false, owner);
    setRunPid(token, childPid, parentPid, { argv, ...(cwd ? { cwd } : {}) }, owner);
    const kept: [Uint8Array[], Uint8Array[]] = [[], []];
    const take = (index: 0 | 1) => (bytes: Uint8Array): void => {
      const entry = stdio[index + 1];
      if (passedOn(entry)) sink((index + 1) as 1 | 2)?.(bytes);
      else if (entry?.type !== 'ignore') kept[index].push(bytes.slice());
    };
    const captured = (index: 1 | 2): boolean => stdio[index]?.type !== 'ignore' && !passedOn(stdio[index]);
    let answer: ReturnType<NonNullable<SyncChildHost['runSync']>>;
    try {
      answer = enterRun(token, () => host.runSync!(__substrateLineFor(options.file, argv, options.cwd), {
        ...(((list) => list ? { argv: list } : {})(__substrateArgvFor(options.file, argv, options.cwd))),
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        ...(input === undefined ? {} : { input: new Uint8Array(input) }),
        captured: [captured(1), captured(2)],
        ...(typeof options.maxBuffer === 'number' && options.maxBuffer >= 0 && Number.isFinite(options.maxBuffer) ? { maxBuffer: options.maxBuffer } : {}),
        ...(typeof options.timeout === 'number' && options.timeout > 0 ? { timeout: options.timeout } : {}),
        ...(typeof options.killSignal === 'number' ? { killSignal: options.killSignal } : {}),
        onStdout: take(0),
        onStderr: take(1),
      }));
    } catch (cause) {
      answer = { started: false, status: null, signal: null, refusal: cause instanceof Error ? cause.message : String(cause) };
    }
    releaseSinks();
    // A child the host never started ends here, as one the engine never started does; one it ran reported its own
    // end. Either way this wait reaps it, and the end it answers is the one the process table holds.
    if (!answer.started) exitRunProcess(childPid, parentPid, 0, 'SIGKILL', owner);
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
      hostOutput.push((index === 1 || index === 2) && captured(index) ? join(kept[index - 1]!) : null);
    }
    // The shell's own "not found" for a program the caller named is ENOENT, as below.
    const saidByHost = __substrateShellLine(options.file, argv) === null && (ended.code === 127 || ended.code === 126) && captured(2) ? new TextDecoder().decode(join(kept[1])) : '';
    if (ended.code === 127 && /command not found|No such file or directory/u.test(saidByHost)) return nothing(UV_ENOENT, childPid);
    if (ended.code === 126 && /Permission denied|not executable/u.test(saidByHost)) return nothing(UV_EACCES, childPid);
    return {
      pid: childPid,
      output: hostOutput,
      status: ended.signal ? null : ended.code,
      signal: ended.signal,
      ...(answer.error === 'ETIMEDOUT' ? { error: UV_ETIMEDOUT } : answer.error === 'ENOBUFS' ? { error: UV_ENOBUFS } : {}),
    };
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
  const limit = typeof options.maxBuffer === 'number' && options.maxBuffer >= 0 ? options.maxBuffer : Infinity;
  const stdout = Buffer.from(answer.stdout);
  const stderr = Buffer.from(answer.stderr);
  // Only bytes kept for the caller count: a descriptor passed on is not a buffer of this call's.
  const kept = (index: 1 | 2): boolean => stdio[index]?.type !== 'ignore' && !passedOn(stdio[index]);
  const overflowed = (kept(1) && stdout.length > limit) || (kept(2) && stderr.length > limit);
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

export default { spawn };
