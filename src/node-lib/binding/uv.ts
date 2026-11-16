/**
 * `internalBinding('uv')`: libuv's error numbers, names and messages, Node v24.21.0's src/uv.cc.
 *
 * Where the realm's process is the `node` program, they are the program's: uv.cc's error table compiled against
 * libuv's uv.h (native/node uv.c, UV_ERRNO_MAP over the musl errno numbers libuv's UV__E* are made of), `errname`
 * uv_err_name_r and `getErrorMessage` uv_strerror_r, so every number a binding compares libuv's answers with, or
 * answers itself, is the one libuv returns. A realm with no program has no libuv, and its numbers are the engine's own
 * table below, Linux's, since a program reads `err.errno` and `err.code` and expects the pair a Linux Node reports.
 */
import { address, libnode, programForm, readRecord, withRoom } from './libnode';

/** The engine's own table, for a realm with no `node` program: the codes Node's `net`, `child_process` and their
 * internals name, with Linux's numbers. */
const codes: Record<string, [number, string]> = {
  UV_E2BIG: [-7, 'argument list too long'],
  UV_EACCES: [-13, 'permission denied'],
  UV_EADDRINUSE: [-98, 'address already in use'],
  UV_EADDRNOTAVAIL: [-99, 'address not available'],
  UV_EAFNOSUPPORT: [-97, 'address family not supported'],
  UV_EAGAIN: [-11, 'resource temporarily unavailable'],
  UV_EALREADY: [-114, 'connection already in progress'],
  UV_EBADF: [-9, 'bad file descriptor'],
  UV_EBUSY: [-16, 'resource busy or locked'],
  UV_ECANCELED: [-125, 'operation canceled'],
  UV_ECONNABORTED: [-103, 'software caused connection abort'],
  UV_ECONNREFUSED: [-111, 'connection refused'],
  UV_ECONNRESET: [-104, 'connection reset by peer'],
  UV_EDESTADDRREQ: [-89, 'destination address required'],
  UV_EEXIST: [-17, 'file already exists'],
  UV_EFAULT: [-14, 'bad address in system call argument'],
  UV_EHOSTDOWN: [-112, 'host is down'],
  UV_EHOSTUNREACH: [-113, 'host is unreachable'],
  UV_EINTR: [-4, 'interrupted system call'],
  UV_EINVAL: [-22, 'invalid argument'],
  UV_EIO: [-5, 'i/o error'],
  UV_EISCONN: [-106, 'socket is already connected'],
  UV_EISDIR: [-21, 'illegal operation on a directory'],
  UV_EMFILE: [-24, 'too many open files'],
  UV_EMSGSIZE: [-90, 'message too long'],
  UV_ENAMETOOLONG: [-36, 'name too long'],
  UV_ENETDOWN: [-100, 'network is down'],
  UV_ENETUNREACH: [-101, 'network is unreachable'],
  UV_ENFILE: [-23, 'file table overflow'],
  UV_ENOBUFS: [-105, 'no buffer space available'],
  UV_ENOENT: [-2, 'no such file or directory'],
  UV_ENOMEM: [-12, 'not enough memory'],
  UV_ENONET: [-64, 'machine is not on the network'],
  UV_ENOPROTOOPT: [-92, 'protocol not available'],
  UV_ENOSPC: [-28, 'no space left on device'],
  UV_ENOSYS: [-38, 'function not implemented'],
  UV_ENOTCONN: [-107, 'socket is not connected'],
  UV_ENOTDIR: [-20, 'not a directory'],
  UV_ENOTEMPTY: [-39, 'directory not empty'],
  UV_ENOTSOCK: [-88, 'socket operation on non-socket'],
  UV_ENOTSUP: [-95, 'operation not supported on socket'],
  UV_EOF: [-4095, 'end of file'],
  UV_EPERM: [-1, 'operation not permitted'],
  UV_EPIPE: [-32, 'broken pipe'],
  UV_EPROTO: [-71, 'protocol error'],
  UV_EPROTONOSUPPORT: [-93, 'protocol not supported'],
  UV_EPROTOTYPE: [-91, 'protocol wrong type for socket'],
  UV_ESHUTDOWN: [-108, 'cannot send after transport endpoint shutdown'],
  UV_ESOCKTNOSUPPORT: [-94, 'socket type not supported'],
  UV_ESRCH: [-3, 'no such process'],
  UV_ETIMEDOUT: [-110, 'connection timed out'],
  UV_UNKNOWN: [-4094, 'unknown error'],
};

/** The realm's errors: the program's compiled ones, read once, or the engine's table. */
interface UvErrors {
  /** Each `UV_*` name's number. */
  readonly values: ReadonlyMap<string, number>;
  /** uv.cc's table in its order: the number, the name, the message. */
  readonly entries: readonly (readonly [number, string, string])[];
  /** GetErrMap's pairs. */
  map(): Map<number, [string, string]>;
  errname(code: number): string;
  message(code: number): string;
}

let programErrors: UvErrors | undefined;
let engineErrors: UvErrors | undefined;

/** uv.cc's per_process::uv_errors_map as the program compiled it (uv.c `tabnode_uv_errors`): 12 bytes an entry. */
function readProgramErrors(): UvErrors {
  const lib = libnode();
  let at = 0, count = 0;
  withRoom(4, (countAt) => { at = address(lib.exports.tabnode_uv_errors(countAt)); }, (view) => { count = view.getUint32(0, true); });
  const table = readRecord(at, count * 12);
  const entries: [number, string, string][] = [];
  const values = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const value = table.getInt32(i * 12, true);
    const name = lib.cString(table.getUint32(i * 12 + 4, true)) ?? '';
    const message = lib.cString(table.getUint32(i * 12 + 8, true)) ?? '';
    entries.push([value, name, message]);
    values.set(`UV_${name}`, value);
  }
  // uv_err_name_r and uv_strerror_r into Node's 50 bytes (uv.cc:60-91).
  const into50 = (call: (at: number) => void): string => {
    let text = '';
    withRoom(50, call, (view) => {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, 50);
      const end = bytes.indexOf(0);
      text = new TextDecoder().decode(bytes.subarray(0, end < 0 ? 50 : end));
    });
    return text;
  };
  return {
    values, entries,
    map: () => new Map(entries.map(([value, name, message]) => [value, [name, message]])),
    errname: (code) => into50((room) => lib.exports.tabnode_uv_err_name_r(code, room)),
    message: (code) => into50((room) => lib.exports.tabnode_uv_strerror_r(code, room)),
  };
}

/** The engine's table, for a realm with no program. */
function readEngineErrors(): UvErrors {
  const entries: [number, string, string][] = Object.entries(codes).map(([name, [value, message]]) => [value, name.slice(3), message]);
  const values = new Map(Object.entries(codes).map(([name, [value]]) => [name, value]));
  const names = new Map<number, [string, string]>();
  for (const [value, name, message] of entries) if (!names.has(value)) names.set(value, [name, message]);
  // The engine's constants table (and a Darwin host's `require('constants')`) names EADDRNOTAVAIL 49 and EAGAIN 35;
  // `util.getSystemErrorName` reads this map, so those numbers must name the same errors Linux's -99 and -11 do.
  if (!names.has(-49)) names.set(-49, ['EADDRNOTAVAIL', 'address not available']);
  if (!names.has(-35)) names.set(-35, ['EAGAIN', 'resource temporarily unavailable']);
  return {
    values, entries,
    map: () => new Map([...names].map(([value, pair]) => [value, [...pair] as [string, string]])),
    errname: (code) => names.get(code)?.[0] ?? `Unknown system error ${code}`,
    message: (code) => names.get(code)?.[1] ?? `Unknown system error ${code}`,
  };
}

function errors(): UvErrors {
  if (programForm("internalBinding('uv')")) return programErrors ??= readProgramErrors();
  return engineErrors ??= readEngineErrors();
}

/** A libuv error's number by its uv.h name (`UV_EBADF`), the realm's. */
export function uvConstant(name: `UV_${string}`): number {
  const value = errors().values.get(name);
  if (value === undefined) throw new Error(`libuv defines no ${name}`);
  return value;
}

/** ErrName (uv.cc:68-86), libuv's `uv_err_name_r`: the code a number stands for. */
export function errname(code: number): string {
  return errors().errname(code);
}

/** GetErrMessage (uv.cc:60-66), libuv's `uv_strerror_r`. */
export function getErrorMessage(code: number): string {
  return errors().message(code);
}

/** GetErrMap (uv.cc:93-117): every number to its `[name, message]` pair, a new Map each call. */
export function getErrorMap(): Map<number, [string, string]> {
  return errors().map();
}

let binding: Record<string, unknown> | undefined;
/**
 * uv.cc's Initialize (119-143): `errname`, every `UV_*` read-only and undeletable, `getErrorMap` and
 * `getErrorMessage`; built on the first ask, after the realm's program, where it has one, is attached.
 */
export function uvBinding(): Record<string, unknown> {
  if (binding) return binding;
  const target: Record<string, unknown> = { errname };
  for (const [value, name] of errors().entries) {
    Object.defineProperty(target, `UV_${name}`, { value, enumerable: true, writable: false, configurable: false });
  }
  target.getErrorMap = getErrorMap;
  target.getErrorMessage = getErrorMessage;
  return binding = target;
}
