/**
 * `internalBinding('process_methods')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's
 * src/node_process_methods.cc split where V8 stands. What its C++ asks libuv or libc (uv_hrtime, uv_cwd, uv_chdir,
 * umask, uv_getrusage, uv_resident_set_memory, uv_kill, abort, exit) is the program's C (native/node/process_methods.c,
 * stdio.c); what it asks V8 or the Environment is answered here. Node's own `lib/internal/process/per_thread.js`,
 * `internal/bootstrap/node.js` and `switches/does_own_process_state.js` wrap it.
 *
 * Where this differs from Node:
 * - MemoryUsage's heap fields are V8's HeapStatistics, which a page's engine reports only as `performance.memory`
 *   (Chromium's); where it reports none they are the resident size, a floor. `external` and `arrayBuffers` are 0: the
 *   realm counts neither.
 * - `execve` and `causeSegfault` are not bound: the program has no exec of its own image's JavaScript realm, and a
 *   null write is a valid address in WebAssembly's memory.
 * - `_debugProcess` signals SIGUSR1 as Node's does on POSIX; `_debugEnd` has no inspector to stop.
 */
import { address, nodeProgram, reallyExit, withCString, withRoom } from './program';
import { errname, getErrorMessage } from './uv';
import { nodeActiveHandles, nodeActiveRequests } from './handles';
import { __tokenForProcess } from '../../process-tokens';
import { constantsBinding } from '../../shims/constants';

/** What the binding asks of the run it serves: the process, its DLOpen, its fs binding, its Environment's lists. */
export interface ProcessMethodsHost {
  readonly process: object;
  /** binding::DLOpen (src/node_binding.cc): the run's own (ADR-0011 over TREE_NATIVE until item 7's dlopen). */
  dlopen(...args: unknown[]): void;
  /** A synchronous write of `text` to fd 2, as FPrintF(stderr) then fflush makes one. */
  writeStderr(text: string): void;
  /** Environment::timeout_info()[0] and immediate_info()->ref_count(), for getActiveResourcesInfo. */
  timeoutCount(): number;
  immediateRefCount(): number;
}

/** Dotenv::ParseResult (src/node_dotenv.h): Valid, FileError, InvalidContent. */
const kDotenvFileError = 1, kDotenvInvalidContent = 2;
/** UV_ENOENT. */
const UV_ENOENT = -2;

/**
 * UVException (src/api/exceptions.cc), as `env->ThrowUVException(err, syscall, msg, path, dest)` throws it:
 * `<code>: <msg or uv_strerror>, <syscall>[ '<path>'][ -> '<dest>']`, with errno, code, syscall, path and dest.
 */
function uvException(err: number, syscall: string, msg?: string, path?: string, dest?: string): Error {
  const code = errname(err);
  let text = `${code}: ${msg ?? getErrorMessage(err)}, ${syscall}`;
  if (path !== undefined) text += ` '${path}'`;
  if (dest !== undefined) text += ` -> '${dest}'`;
  return Object.assign(new Error(text), { errno: err, code, syscall },
    path !== undefined ? { path } : {}, dest !== undefined ? { dest } : {});
}

/** A Float64Array of `length` whose buffer starts at it (get_fields_array_buffer's CHECKs). */
function fieldsOf(value: unknown, length: number): Float64Array {
  if (!(value instanceof Float64Array) || value.length !== length || value.byteOffset !== 0) {
    throw new TypeError('process_methods: fields must be a whole Float64Array of ' + length);
  }
  return value;
}

/** A call of the program that fills `count` doubles: its error thrown as ThrowUVException(err, syscall). */
function fillFields(fields: Float64Array, syscall: string, call: (at: number) => number): void {
  const err = withRoom(fields.length * 8, call, (view, answer) => {
    if (answer !== 0) return;
    for (let index = 0; index < fields.length; index++) fields[index] = view.getFloat64(index * 8, true);
  });
  if (err !== 0) throw uvException(err, syscall);
}

/** V8's heap statistics as the realm reports them (Chromium's `performance.memory`), else none. */
function heapStatistics(): { total: number; used: number } | undefined {
  const memory = ((globalThis as { performance?: unknown }).performance as { memory?: { totalJSHeapSize?: unknown; usedJSHeapSize?: unknown } } | undefined)?.memory;
  return typeof memory?.totalJSHeapSize === 'number' && typeof memory.usedJSHeapSize === 'number'
    ? { total: memory.totalJSHeapSize, used: memory.usedJSHeapSize } : undefined;
}

export function createProcessMethodsBinding(host: ProcessMethodsHost): Record<string, unknown> {
  const program = () => nodeProgram().exports;
  // BindingData's hrtime_buffer (node_process_methods.cc:643-661): three Uint32s, the first two read as one uint64 by
  // hrtimeBigInt.
  const hrtimeBuffer = new Uint32Array(3);
  const hrtimeBigInt = new BigUint64Array(hrtimeBuffer.buffer, 0, 1);
  const NANOS_PER_SEC = 1000000000n;
  let emitWarningSync: ((...args: unknown[]) => void) | undefined;
  const rss = (): number => {
    let value = 0;
    const err = withRoom(8, (at) => program().tabnode_rss(at), (view, answer) => { if (answer === 0) value = view.getFloat64(0, true); });
    if (err !== 0) throw uvException(err, 'uv_resident_set_memory');
    return value;
  };
  return {
    hrtimeBuffer,
    hrtime(): void {
      const t = BigInt.asUintN(64, program().tabnode_hrtime());
      const seconds = t / NANOS_PER_SEC;
      hrtimeBuffer[0] = Number(seconds >> 32n);
      hrtimeBuffer[1] = Number(seconds & 0xffffffffn);
      hrtimeBuffer[2] = Number(t % NANOS_PER_SEC);
    },
    hrtimeBigInt(): void { hrtimeBigInt[0] = BigInt.asUintN(64, program().tabnode_hrtime()); },
    _debugProcess(...args: unknown[]): void {
      if (args.length < 1) throw Object.assign(new TypeError('Invalid number of arguments.'), { code: 'ERR_MISSING_ARGS' });
      const pid = Number(args[0]) | 0;
      const err = program().tabnode_kill(pid, (constantsBinding().os.signals as Record<string, number>).SIGUSR1!);
      if (err !== 0) throw uvException(err, 'kill');
    },
    _debugEnd(): void {},
    abort(): void { program().tabnode_abort(); },
    chdir(...args: unknown[]): void {
      if (args.length !== 1 || typeof args[0] !== 'string') throw new TypeError('process_methods.chdir: a path');
      const path = args[0];
      const err = withCString(path, (at) => program().tabnode_chdir(at));
      if (err !== 0) {
        // ThrowUVException(err, "chdir", nullptr, buf, *path): the cwd uv_cwd left in its buffer, then the target.
        let cwd = '';
        try { cwd = readCwd(); } catch { /* uv_cwd's failure leaves the buffer empty */ }
        throw uvException(err, 'chdir', undefined, cwd, path);
      }
    },
    umask(...args: unknown[]): number {
      if (args.length !== 1 || !(args[0] === undefined || (typeof args[0] === 'number' && args[0] >>> 0 === args[0]))) {
        throw new TypeError('process_methods.umask: undefined or a Uint32');
      }
      return program().tabnode_umask(args[0] === undefined ? 0 : 1, args[0] === undefined ? 0 : (args[0] as number)) >>> 0;
    },
    memoryUsage(fields: unknown): void {
      const array = fieldsOf(fields, 5);
      const resident = rss();
      const heap = heapStatistics();
      array[0] = resident;
      array[1] = heap?.total ?? resident;
      array[2] = heap?.used ?? resident;
      array[3] = 0;
      array[4] = 0;
    },
    constrainedMemory: (): number => program().tabnode_constrained_memory(),
    availableMemory: (): number => program().tabnode_available_memory(),
    rss,
    cpuUsage(fields: unknown): void { fillFields(fieldsOf(fields, 2), 'uv_getrusage', (at) => program().tabnode_cpu_usage(at, 0)); },
    threadCpuUsage(fields: unknown): void { fillFields(fieldsOf(fields, 2), 'uv_getrusage_thread', (at) => program().tabnode_cpu_usage(at, 1)); },
    resourceUsage(fields: unknown): void { fillFields(fieldsOf(fields, 16), 'uv_getrusage', (at) => program().tabnode_resource_usage(at)); },
    _getActiveRequests: (): object[] => nodeActiveRequests(host.process, __tokenForProcess(host.process as never)),
    _getActiveHandles: (): object[] => nodeActiveHandles(host.process, __tokenForProcess(host.process as never)),
    getActiveResourcesInfo(): string[] {
      const token = __tokenForProcess(host.process as never);
      const named = (wrap: object): string => {
        const provider = (wrap as { constructor?: { name?: unknown } }).constructor?.name;
        return typeof provider === 'string' && provider !== '' ? provider : 'Unknown';
      };
      const info = nodeActiveRequests(host.process, token).map(named);
      for (const handle of nodeActiveHandles(host.process, token)) {
        const hasRef = (handle as { hasRef?: () => boolean }).hasRef;
        if (typeof hasRef !== 'function' || hasRef.call(handle)) info.push(named(handle));
      }
      for (let index = 0; index < host.timeoutCount(); index++) info.push('Timeout');
      for (let index = 0; index < host.immediateRefCount(); index++) info.push('Immediate');
      return info;
    },
    _kill(...args: unknown[]): number {
      if (args.length < 2) throw Object.assign(new TypeError('Bad argument.'), { code: 'ERR_MISSING_ARGS' });
      return program().tabnode_kill(Number(args[0]) | 0, Number(args[1]) | 0);
    },
    _rawDebug(...args: unknown[]): void {
      if (args.length !== 1 || typeof args[0] !== 'string') throw new TypeError('must be called with a single string');
      host.writeStderr(`${args[0]}\n`);
    },
    cwd: (): string => readCwd(),
    dlopen: (...args: unknown[]): void => host.dlopen(...args),
    reallyExit: (code: unknown): void => reallyExit(code),
    uptime: (): number => program().tabnode_uptime(),
    patchProcessObject(process: unknown): void { patchProcessObject(process as Record<string, unknown>, host); },
    setEmitWarningSync(fn: unknown): void {
      if (typeof fn !== 'function') throw new TypeError('setEmitWarningSync: a function');
      emitWarningSync = fn as (...args: unknown[]) => void;
    },
    // LoadEnvFile (node_process_methods.cc:604-635): Node's Dotenv in the program over the file, its variables set in
    // the process's environment where it holds none; a file that does not parse is ERR_INVALID_ARG_TYPE, one that
    // does not open UV_ENOENT's `open`.
    loadEnvFile(...args: unknown[]): void {
      const path = args.length === 1 ? (typeof args[0] === 'string' ? args[0] : new TextDecoder().decode(args[0] as Uint8Array)) : '.env';
      const parsed = withCString(path, (at) => program().tabnode_load_env_file(at));
      if (parsed === kDotenvInvalidContent) {
        // THROW_ERR_INVALID_ARG_TYPE (src/node_errors.h): a TypeError with its code.
        throw Object.assign(new TypeError(`Contents of '${path}' should be a valid string.`), { code: 'ERR_INVALID_ARG_TYPE' });
      }
      if (parsed === kDotenvFileError) throw uvException(UV_ENOENT, 'open', undefined, path);
    },
    /** The Environment's process_emit_warning_sync, for a warning the engine itself emits synchronously. */
    get emitWarningSync(): ((...args: unknown[]) => void) | undefined { return emitWarningSync; },
  };
}

/** Cwd (node_process_methods.cc:160-181): uv_cwd, its failure Node's message. */
function readCwd(): string {
  const program = nodeProgram();
  const size = 4096;
  const at = address(program.exports.tabnode_malloc(size));
  try {
    const length = program.exports.tabnode_cwd(at, size);
    if (length < 0) {
      let message = `process.cwd failed with error ${getErrorMessage(length)}`;
      if (errname(length) === 'ENOENT') {
        message += ', the current working directory was likely removed without changing the working directory';
      }
      throw uvException(length, 'uv_cwd', message);
    }
    return new TextDecoder().decode(program.read(at, length));
  } finally { program.exports.tabnode_free(at); }
}

/** What the run gives PatchProcessObject (src/node_process_object.cc:160-232): its argv, execArgv, pid and execPath. */
export interface PatchedFacts {
  title(): string;
  setTitle?(title: string): void;
  argv: readonly string[];
  execArgv: readonly string[];
  pid: number;
  ppid(): number;
  execPath: string;
}
const patchedFacts = new WeakMap<object, PatchedFacts>();
/** The facts the run's process is patched with, given before Node's pre-execution asks for them. */
export function setPatchedFacts(process: object, facts: PatchedFacts): void { patchedFacts.set(process, facts); }

/**
 * PatchProcessObject: `title` an accessor (settable where the process owns its state), `argv` and `execArgv` the
 * run's, `pid` read-only, `ppid` an accessor, `execPath` and `debugPort` (with no inspector, the default port 9229 an
 * accessor whose setter keeps the number).
 */
function patchProcessObject(process: Record<string, unknown>, host: ProcessMethodsHost): void {
  const facts = patchedFacts.get(host.process);
  if (!facts) throw new Error('process_methods.patchProcessObject: the run gave its process no facts');
  Object.defineProperty(process, 'title', {
    configurable: true, enumerable: true,
    get: () => facts.title(),
    set: facts.setTitle ? (value: unknown) => facts.setTitle!(`${value}`) : undefined,
  });
  process.argv = [...facts.argv];
  process.execArgv = [...facts.execArgv];
  Object.defineProperty(process, 'pid', { value: facts.pid, writable: false, enumerable: true, configurable: true });
  Object.defineProperty(process, 'ppid', { get: () => facts.ppid(), enumerable: true, configurable: true });
  Object.defineProperty(process, 'execPath', { value: facts.execPath, writable: true, enumerable: true, configurable: true });
  let debugPort = 9229;
  Object.defineProperty(process, 'debugPort', {
    get: () => debugPort,
    set: (value: unknown) => { debugPort = Number(value) | 0; },
    enumerable: true, configurable: true,
  });
}
