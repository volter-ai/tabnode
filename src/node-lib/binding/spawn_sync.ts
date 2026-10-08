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
import { UV_ENOSYS, UV_ENOENT, UV_EACCES, UV_ENOBUFS } from './uv';
import { runSyncChild, syncChildRefusal } from '../../shims/sync-child';
import { __substrateLineFor, __substrateRunsNode, __substrateShellLine } from '../../shims/command-line';

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
}

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

/** The program a caller can still write to: the engine's own stdout and stderr, given the child's bytes. */
function inheritedWriter(fd: number): ((bytes: Uint8Array) => void) | undefined {
  const realm = (globalThis as unknown as {
    process?: { stdout?: { write(chunk: Uint8Array): unknown }; stderr?: { write(chunk: Uint8Array): unknown } };
  }).process;
  const stream = fd === 1 ? realm?.stdout : realm?.stderr;
  if (!stream || typeof stream.write !== 'function') return undefined;
  return (bytes: Uint8Array) => {
    try { stream.write(bytes); } catch { /* a stream that refuses still lets the child run */ }
  };
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
  const nothing = (error: number): SyncSpawnResult => ({ pid, output: null, status: null, signal: null, error });

  // A realm that cannot run a synchronous child at all says which of its reasons it is. libuv's record has room for
  // an errno only, and Node's own `spawnSync` (internal/child_process.js) makes the Error from it and stores it back
  // on the record's `error`; the reason is added to that Error's message as it is stored, so `result.error.message`
  // and the Error `execSync` throws read "spawnSync <file> ENOSYS: <reason>". Without it the four refusals were one
  // indistinguishable ENOSYS.
  const refusal = syncChildRefusal();
  if (refusal !== null) {
    let error: unknown = UV_ENOSYS;
    const refused = nothing(UV_ENOSYS);
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
  }

  const input = stdio[0]?.input;
  const realm = (globalThis as unknown as { process?: { cwd?: () => string; env?: Record<string, string> } & Record<symbol, unknown> }).process;
  // The tree of the run that asks, which a host may have given that run alone.
  const runTree = realm?.[Symbol.for('tabnode.run.vfs')] as Parameters<typeof runSyncChild>[0]['tree'];
  let answer;
  try {
    // A child that is the engine's Node goes by its argv, as `spawn` starts
    // one, and its fds are bytes both ways; the input is the bytes Node's
    // `spawnSync` was given, whatever their encoding.
    answer = runSyncChild({
      ...(runTree ? { tree: runTree } : {}),
      command: __substrateLineFor(options.file, argv, options.cwd),
      ...(__substrateRunsNode(options.file, options.cwd) ? { argv } : {}),
      cwd: options.cwd ?? (typeof realm?.cwd === 'function' ? realm.cwd() : undefined),
      env: environmentOf(options.envPairs) ?? (realm?.env ? { ...realm.env } : undefined),
      ...(input === undefined ? {} : { input: new Uint8Array(input) }),
      onStdout: stdio[1]?.type === 'inherit' ? inheritedWriter(1) : undefined,
      onStderr: stdio[2]?.type === 'inherit' ? inheritedWriter(2) : undefined,
    });
  } catch {
    return nothing(UV_ENOSYS);
  }

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
  const overflowed = stdout.length > limit || stderr.length > limit;
  const output: Array<Uint8Array | null> = [null];
  for (let index = 1; index < Math.max(3, stdio.length); index += 1) {
    const bytes = index === 1 ? stdout : index === 2 ? stderr : null;
    const kind = stdio[index]?.type;
    output.push(bytes === null || kind === 'ignore' || kind === 'inherit' ? null : bytes);
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
