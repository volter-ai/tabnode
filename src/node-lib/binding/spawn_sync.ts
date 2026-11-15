/**
 * `internalBinding('spawn_sync')`: Node's SyncProcessRunner (src/spawn_sync.cc, Node v24.21.0) over a loop of its
 * own (ADR-0018 §3, §6), which is native/node's spawn_sync.c: the child is uv_spawn'd there, its pipes, input, output,
 * timeout, maxBuffer and kill are libuv's, and the call blocks in that loop until the child has ended, as Node's does.
 * What is here is V8's half: ParseOptions' reading of the options object into one record, with what it answers itself
 * for a value of the wrong kind, and the result object built from the record the C answers.
 */
import { libRequire } from '../require-hook';
import { CRecord, address, libnode, readRecord } from './libnode';
import { UV_EINVAL } from './uv';

/** spawn_sync.c's `struct spawn_sync` (80 bytes) and `struct spawn_sync_stdio` (28), field by field. */
const OPTIONS = {
  error: 0, file: 4, args: 8, cwd: 12, env: 16, setUid: 20, uid: 24, setGid: 28, gid: 32, flags: 36, setKillSignal: 40,
  killSignal: 44, timeout: 48, maxBuffer: 56, stdioCount: 64, stdioParsed: 68, stdio: 72, bytes: 80,
};
const STDIO = { type: 0, readable: 4, writable: 8, input: 12, inputLength: 16, fd: 20, typeName: 24, bytes: 28 };
/** spawn_sync.c's stdio types, by the string ParseStdioOption compares `type` with, and its flags. */
const STDIO_TYPE = { ignore: 0, pipe: 1, inherit: 2, unknown: 3 };
const FLAG = { detached: 1 << 0, windowsHide: 1 << 1, windowsVerbatimArguments: 1 << 2 };
/** spawn_sync.c's `struct spawn_sync_result` (40 bytes) and `struct spawn_sync_output` (12). */
const RESULT = { error: 0, statusIsNull: 4, status: 8, signal: 16, signalLength: 20, outputIsNull: 24, outputCount: 28, output: 32, pid: 36, bytes: 40 };
const OUTPUT = { data: 0, length: 4, isNull: 8, bytes: 12 };

/** V8's IsObject. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';
const isNullish = (value: unknown): value is null | undefined => value === null || value === undefined;
/** V8's IsInt32: a Number whose value is one, -0 not. */
const isInt32 = (value: unknown): value is number => typeof value === 'number' && (value | 0) === value && !Object.is(value, -0);
/** CopyJsString's ToString (V8's, which a Symbol refuses). */
const text = (value: unknown): string => typeof value === 'string' ? value : `${value as string}`;
/** V8's IntegerValue of a Number: NaN 0, saturated at int64's bounds (the largest double below 2^63 above). */
const integerValue = (value: number): number =>
  Number.isNaN(value) ? 0 : Math.min(Math.max(Math.trunc(value), -(2 ** 63)), 2 ** 63 - 1024);
/** THROW_ERR_INVALID_ARG_TYPE. */
const invalidArgType = (message: string): Error => Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });

/** ParseOptions, ParseStdioOptions and ParseStdioOption's reading of the values (spawn_sync.cc:788-1073), in their order. */
function parseOptions(options: unknown): CRecord {
  const record = new CRecord(OPTIONS.bytes);
  record.int32(OPTIONS.stdioCount, -1);
  const answer = (error: number): CRecord => { record.int32(OPTIONS.error, error); return record; };
  if (!isObject(options)) return answer(UV_EINVAL);
  record.pointer(OPTIONS.file, record.string(text(options.file)));
  const args = options.args;
  if (!Array.isArray(args)) return answer(UV_EINVAL);
  record.pointer(OPTIONS.args, record.strings(Array.from(args, text)));
  if (!isNullish(options.cwd)) record.pointer(OPTIONS.cwd, record.string(text(options.cwd)));
  const envPairs = options.envPairs;
  if (!isNullish(envPairs)) {
    if (!Array.isArray(envPairs)) return answer(UV_EINVAL);
    record.pointer(OPTIONS.env, record.strings(Array.from(envPairs, text)));
  }
  const uid = options.uid;
  if (!isNullish(uid)) {
    if (!isInt32(uid)) throw invalidArgType('options.uid must be a 32-bit signed integer');
    record.int32(OPTIONS.setUid, 1);
    record.int32(OPTIONS.uid, uid);
  }
  const gid = options.gid;
  if (!isNullish(gid)) {
    if (!isInt32(gid)) throw invalidArgType('options.gid must be a 32-bit signed integer');
    record.int32(OPTIONS.setGid, 1);
    record.int32(OPTIONS.gid, gid);
  }
  let flags = 0;
  if (options.detached) flags |= FLAG.detached;
  if (options.windowsHide) flags |= FLAG.windowsHide;
  if (options.windowsVerbatimArguments) flags |= FLAG.windowsVerbatimArguments;
  record.uint32(OPTIONS.flags, flags);
  const timeout = options.timeout;
  if (!isNullish(timeout)) {
    if (typeof timeout !== 'number') throw invalidArgType('options.timeout must be a number');
    record.float64(OPTIONS.timeout, integerValue(timeout));
  }
  const maxBuffer = options.maxBuffer;
  if (!isNullish(maxBuffer)) {
    if (typeof maxBuffer !== 'number') throw invalidArgType('options.maxBuffer must be a number');
    record.float64(OPTIONS.maxBuffer, maxBuffer);
  }
  const killSignal = options.killSignal;
  if (!isNullish(killSignal)) {
    if (typeof killSignal !== 'number') throw invalidArgType('options.killSignal must be a number');
    record.int32(OPTIONS.setKillSignal, 1);
    record.int32(OPTIONS.killSignal, killSignal | 0);
  }
  const stdio = options.stdio;
  if (!Array.isArray(stdio)) return answer(UV_EINVAL);
  record.int32(OPTIONS.stdioCount, stdio.length);
  const entries = record.room(stdio.length * STDIO.bytes);
  record.pointer(OPTIONS.stdio, entries);
  for (let index = 0; index < stdio.length; index += 1) {
    const entry: unknown = stdio[index];
    const at = entries + index * STDIO.bytes;
    // An entry ParseStdioOptions refuses ends its reading there: the entries before it are the C's to add.
    record.uint32(OPTIONS.stdioParsed, index);
    if (!isObject(entry)) return answer(UV_EINVAL);
    const type = entry.type;
    if (type === 'ignore') {
      record.int32(at + STDIO.type, STDIO_TYPE.ignore);
    } else if (type === 'pipe') {
      const readable = Boolean(entry.readable);
      const writable = Boolean(entry.writable);
      record.int32(at + STDIO.type, STDIO_TYPE.pipe);
      record.int32(at + STDIO.readable, readable ? 1 : 0);
      record.int32(at + STDIO.writable, writable ? 1 : 0);
      if (readable) {
        const input = entry.input;
        if (ArrayBuffer.isView(input)) {
          record.pointer(at + STDIO.input, record.data(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)));
          record.uint32(at + STDIO.inputLength, input.byteLength);
        } else if (!isNullish(input)) {
          // Strings, numbers etc. are currently unsupported (spawn_sync.cc:1049-1053).
          return answer(UV_EINVAL);
        }
      }
    } else if (type === 'inherit' || type === 'fd') {
      record.int32(at + STDIO.type, STDIO_TYPE.inherit);
      record.int32(at + STDIO.fd, +(entry.fd as number) | 0);
    } else {
      let name = '';
      try { name = text(type); } catch { /* Utf8Value of a value with no string is empty */ }
      record.int32(at + STDIO.type, STDIO_TYPE.unknown);
      record.pointer(at + STDIO.typeName, record.string(name));
    }
  }
  record.uint32(OPTIONS.stdioParsed, stdio.length);
  return record;
}

/** Node's own `Buffer`, read when a child answers rather than when this loads. */
function bufferClass(): { from(bytes: ArrayBuffer, offset: number, length: number): Uint8Array; alloc(length: number): Uint8Array } {
  return (libRequire('buffer') as { Buffer: ReturnType<typeof bufferClass> }).Buffer;
}

/** BuildResultObject and BuildOutputArray (spawn_sync.cc:692-786), from the C's record of them. */
function resultOf(at: number): Record<string, unknown> {
  const program = libnode();
  const view = readRecord(at, RESULT.bytes);
  const result: Record<string, unknown> = {};
  const error = view.getInt32(RESULT.error, true);
  if (error !== 0) result.error = error;
  result.status = view.getInt32(RESULT.statusIsNull, true) !== 0 ? null : view.getFloat64(RESULT.status, true);
  const signal = address(view.getUint32(RESULT.signal, true));
  result.signal = signal === 0 ? null
    : String.fromCharCode(...program.read(signal, view.getUint32(RESULT.signalLength, true)));
  if (view.getInt32(RESULT.outputIsNull, true) !== 0) {
    result.output = null;
  } else {
    const Buffer = bufferClass();
    const count = view.getUint32(RESULT.outputCount, true);
    const outputs = readRecord(view.getUint32(RESULT.output, true), count * OUTPUT.bytes);
    const output: (Uint8Array | null)[] = [];
    for (let index = 0; index < count; index += 1) {
      const entry = index * OUTPUT.bytes;
      if (outputs.getInt32(entry + OUTPUT.isNull, true) !== 0) { output.push(null); continue; }
      const length = outputs.getUint32(entry + OUTPUT.length, true);
      if (length === 0) { output.push(Buffer.alloc(0)); continue; }
      const bytes = program.read(address(outputs.getUint32(entry + OUTPUT.data, true)), length);
      output.push(Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, length));
    }
    result.output = output;
  }
  result.pid = view.getInt32(RESULT.pid, true);
  return result;
}

/** SyncProcessRunner::Spawn (spawn_sync.cc:380-405): the options read, the run, and its result. */
function spawn(options: unknown): Record<string, unknown> {
  const record = parseOptions(options);
  const { exports } = libnode();
  const at = record.commit();
  let result: number;
  try { result = address(exports.tabnode_spawn_sync(at)); }
  finally { record.free(); }
  try { return resultOf(result); }
  finally { exports.tabnode_spawn_sync_free(result); }
}

export default { spawn };
