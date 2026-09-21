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
import { __substrateLineFor, __substrateShellLine } from '../../shims/command-line';

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

/** The program a caller can still write to: the engine's own stdout and stderr. */
function inheritedWriter(fd: number): ((text: string) => void) | undefined {
  const realm = (globalThis as unknown as {
    process?: { stdout?: { write(text: string): unknown }; stderr?: { write(text: string): unknown } };
  }).process;
  const stream = fd === 1 ? realm?.stdout : realm?.stderr;
  if (!stream || typeof stream.write !== 'function') return undefined;
  return (text: string) => {
    try { stream.write(text); } catch { /* a stream that refuses still lets the child run */ }
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

  if (syncChildRefusal() !== null) return nothing(UV_ENOSYS);

  const input = stdio[0]?.input;
  const realm = (globalThis as unknown as { process?: { cwd?: () => string; env?: Record<string, string> } }).process;
  let answer;
  try {
    answer = runSyncChild({
      command: __substrateLineFor(options.file, argv, options.cwd),
      cwd: options.cwd ?? (typeof realm?.cwd === 'function' ? realm.cwd() : undefined),
      env: environmentOf(options.envPairs) ?? (realm?.env ? { ...realm.env } : undefined),
      input: input === undefined ? undefined : Buffer.from(input).toString('utf8'),
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
  if (named && answer.status === 127 && /command not found|No such file or directory/u.test(answer.stderr)) {
    return nothing(UV_ENOENT);
  }
  if (named && answer.status === 126 && /Permission denied|not executable/u.test(answer.stderr)) {
    return nothing(UV_EACCES);
  }

  // Past `maxBuffer` the child is reported as having failed, and the bytes it
  // had already produced come back whole: libuv reads in blocks and hands
  // over what it read, which is why Node's own test says "we can have buffers
  // larger than maxBuffer".
  const limit = typeof options.maxBuffer === 'number' && options.maxBuffer >= 0 ? options.maxBuffer : Infinity;
  const stdout = Buffer.from(answer.stdout, 'utf8');
  const stderr = Buffer.from(answer.stderr, 'utf8');
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
