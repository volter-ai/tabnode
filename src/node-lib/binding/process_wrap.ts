/**
 * `internalBinding('process_wrap')`: Node's src/process_wrap.cc (Node v24.21.0) over the program's uv_spawn
 * (ADR-0018 §3, §6). A `Process` is a HandleWrap whose uv_process_t is native/node's (process_wrap.c); `spawn` reads
 * its arguments as V8's half of Node's Spawn reads them, into one record the C turns into uv_process_options_t and
 * spawns on the process's loop; `kill` is uv_process_kill; libuv's exit callback calls `onexit` with the exit status
 * and the signal's name (`processExit`, an import of the program's), and the C then closes the callback's scope.
 * Everything else, what a stdio entry is, a child's pipes, how a child is found and started, is libuv's.
 */
import { CRecord, address, libnode } from '../../libnode';
import { HandleWrap, uvStreamOf, kHandle } from './handle_wrap';
import { startHandle, stopHandle, invokeOwned } from './handles';

/** process_wrap.cc:57-62's flags, as lib/internal/child_process.js passes them. */
export const constants = Object.freeze({
  kProcessFlagDetached: 1 << 0,
  kProcessFlagWindowsHide: 1 << 1,
  kProcessFlagWindowsVerbatimArguments: 1 << 2,
});

/** process_wrap.c's `struct process_spawn` (44 bytes) and `struct process_stdio` (12), field by field. */
const SPAWN = { file: 0, args: 4, cwd: 8, env: 12, stdio: 16, stdioCount: 20, flags: 24, setUid: 28, uid: 32, setGid: 36, gid: 40, bytes: 44 };
const STDIO = { type: 0, fd: 4, stream: 8, bytes: 12 };
/** process_wrap.c's stdio types, by the string ParseStdioOptions compares `type` with. */
const STDIO_TYPE = { ignore: 0, pipe: 1, overlapped: 2, wrap: 3, fd: 4 };

/** V8's IsInt32 and IsUint32: a Number whose value is one, -0 not. */
const isInt32 = (value: unknown): value is number => typeof value === 'number' && (value | 0) === value && !Object.is(value, -0);
const isUint32 = (value: unknown): value is number => typeof value === 'number' && value >>> 0 === value && !Object.is(value, -0);
/** Utf8Value's string: V8's ToString, which a Symbol refuses. */
const text = (value: unknown): string => typeof value === 'string' ? value : `${value as string}`;
/** A CHECK of Node's that the call's values do not meet. */
const check = (what: string): Error => new TypeError(`CHECK(${what}) failed`);

export class Process extends HandleWrap {
  declare onexit: ((exitCode: number, signalCode: string) => void) | null;
  /** Set where uv_spawn answered 0, as Spawn sets it on the object. */
  declare pid: number;

  /** ProcessWrap's constructor (process_wrap.cc:110-116): its uv_process_t, marked uninitialized. */
  constructor() {
    super(libnode().exports.tabnode_process_new(), false, false);
  }

  /** ProcessWrap::Spawn (process_wrap.cc:193-342), the arguments in its order: file, args, cwd, envPairs, stdio, flags, uid, gid. */
  spawn(file: unknown, args: unknown, cwd: unknown, envPairs: unknown, stdio: unknown, flags: unknown, uid?: unknown, gid?: unknown): number {
    if (typeof file !== 'string') throw check('args[0]->IsString()');
    const record = new CRecord(SPAWN.bytes);
    record.pointer(SPAWN.file, record.string(file));
    if (uid !== undefined && uid !== null) {
      if (!isInt32(uid)) throw check('uid_v->IsInt32()');
      record.int32(SPAWN.setUid, 1);
      record.int32(SPAWN.uid, uid);
    }
    if (gid !== undefined && gid !== null) {
      if (!isInt32(gid)) throw check('gid_v->IsInt32()');
      record.int32(SPAWN.setGid, 1);
      record.int32(SPAWN.gid, gid);
    }
    if (Array.isArray(args)) record.pointer(SPAWN.args, record.strings(Array.from(args, text)));
    if (typeof cwd === 'string') record.pointer(SPAWN.cwd, record.string(cwd));
    if (Array.isArray(envPairs)) record.pointer(SPAWN.env, record.strings(Array.from(envPairs, text)));
    if (!Array.isArray(stdio)) throw Object.assign(new TypeError('options.stdio must be an array'), { code: 'ERR_INVALID_ARG_TYPE' });
    const entries = record.room(stdio.length * STDIO.bytes);
    stdio.forEach((entry: { type?: unknown; handle?: unknown; fd?: unknown }, index) => {
      const at = entries + index * STDIO.bytes;
      const type = entry.type;
      if (type === 'ignore') record.int32(at + STDIO.type, STDIO_TYPE.ignore);
      else if (type === 'pipe' || type === 'overlapped' || type === 'wrap') {
        record.int32(at + STDIO.type, STDIO_TYPE[type]);
        record.uint32(at + STDIO.stream, uvStreamOf(entry.handle));
      } else {
        const fd = entry.fd;
        if (typeof fd !== 'number') throw check('fd_value->IsNumber()');
        record.int32(at + STDIO.type, STDIO_TYPE.fd);
        record.int32(at + STDIO.fd, fd | 0);
      }
    });
    record.pointer(SPAWN.stdio, entries);
    record.uint32(SPAWN.stdioCount, stdio.length);
    if (!isUint32(flags)) throw check('args[5]->IsUint32()');
    record.uint32(SPAWN.flags, flags);

    const { exports } = libnode();
    const options = record.commit();
    let err: number;
    try { err = exports.tabnode_process_spawn(this[kHandle], options); }
    finally { record.free(); }
    this.markAsInitialized();
    if (err === 0) {
      this.pid = exports.tabnode_process_pid(this[kHandle]);
      startHandle(this);
    }
    return err;
  }

  /** ProcessWrap::Kill (process_wrap.cc:344-360): the signal as V8's Int32Value takes it. */
  kill(signal: unknown): number {
    const number = +(signal as number) | 0;
    return libnode().exports.tabnode_process_kill(this[kHandle], number);
  }
}

/**
 * The program's `process_exit` (engine.h): ProcessWrap::OnExit (process_wrap.cc:362-378), its `onexit` made as
 * MakeCallback makes it, with the exit status and the signal's name (OneByteString of signo_string), after libuv has
 * stopped the handle (uv__wait_children).
 */
export function processExit(handle: number, exitStatus: number, signalAt: number, signalLength: number): void {
  const wrap = HandleWrap.at(handle, Process);
  const signal = signalLength === 0 ? '' : String.fromCharCode(...libnode().read(address(signalAt), signalLength));
  stopHandle(wrap);
  invokeOwned(wrap, 'onexit', exitStatus, signal);
}

export default { Process, constants };
