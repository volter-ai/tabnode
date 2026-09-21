/**
 * `internalBinding('uv')`: libuv's error numbers and names.
 *
 * The engine has no libuv, and the numbers are still libuv's, because Node's
 * own files compare against them and a program reads `err.errno` and
 * `err.code` and expects the pair a Linux Node reports. The engine's platform
 * is `linux`, so these are Linux's.
 */

/** The codes Node's `net`, `child_process` and their internals name. */
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
  UV_EEXIST: [-17, 'file already exists'],
  UV_EFAULT: [-14, 'bad address in system call argument'],
  UV_EHOSTUNREACH: [-113, 'host is unreachable'],
  UV_EINTR: [-4, 'interrupted system call'],
  UV_EINVAL: [-22, 'invalid argument'],
  UV_EIO: [-5, 'i/o error'],
  UV_EISCONN: [-106, 'socket is already connected'],
  UV_EISDIR: [-21, 'illegal operation on a directory'],
  UV_EMFILE: [-24, 'too many open files'],
  UV_ENAMETOOLONG: [-36, 'name too long'],
  UV_ENETDOWN: [-100, 'network is down'],
  UV_ENETUNREACH: [-101, 'network is unreachable'],
  UV_ENFILE: [-23, 'file table overflow'],
  UV_ENOBUFS: [-105, 'no buffer space available'],
  UV_ENOENT: [-2, 'no such file or directory'],
  UV_ENOMEM: [-12, 'not enough memory'],
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
  UV_ESHUTDOWN: [-108, 'cannot send after transport endpoint shutdown'],
  UV_ESRCH: [-3, 'no such process'],
  UV_ETIMEDOUT: [-110, 'connection timed out'],
  UV_UNKNOWN: [-4094, 'unknown error'],
};

const names = new Map<number, string>();
for (const [name, [value]] of Object.entries(codes)) if (!names.has(value)) names.set(value, name.slice(3));
// The constants table (and a Darwin host's `require('constants')`) names
// EADDRNOTAVAIL 49 and EAGAIN 35; `util.getSystemErrorName` reads this map,
// so those numbers must name the same errors Linux's -99 and -11 do.
if (!names.has(-49)) names.set(-49, 'EADDRNOTAVAIL');
if (!names.has(-35)) names.set(-35, 'EAGAIN');

/** libuv's `uv_err_name`: the code a number stands for, `UNKNOWN` for a number none does. */
export function errname(code: number): string {
  return names.get(code) ?? `Unknown system error ${code}`;
}

/** Node's `getErrorMap()`: every number to its `[name, message]` pair. */
export function getErrorMap(): Map<number, [string, string]> {
  const map = new Map<number, [string, string]>();
  for (const [name, [value, message]] of Object.entries(codes)) {
    if (!map.has(value)) map.set(value, [name.slice(3), message]);
  }
  if (!map.has(-49)) map.set(-49, ['EADDRNOTAVAIL', 'address not available']);
  if (!map.has(-35)) map.set(-35, ['EAGAIN', 'resource temporarily unavailable']);
  return map;
}

const uvBinding: Record<string, unknown> = { errname, getErrorMap };
for (const [name, [value]] of Object.entries(codes)) uvBinding[name] = value;

export const UV_EOF = codes.UV_EOF[0];
export const UV_ECONNREFUSED = codes.UV_ECONNREFUSED[0];
export const UV_ECONNRESET = codes.UV_ECONNRESET[0];
export const UV_EADDRINUSE = codes.UV_EADDRINUSE[0];
export const UV_ENOENT = codes.UV_ENOENT[0];
export const UV_ENOTSOCK = codes.UV_ENOTSOCK[0];
export const UV_EPIPE = codes.UV_EPIPE[0];
export const UV_EINVAL = codes.UV_EINVAL[0];
export const UV_ENOTCONN = codes.UV_ENOTCONN[0];
export const UV_ECANCELED = codes.UV_ECANCELED[0];
export const UV_ENOTSUP = codes.UV_ENOTSUP[0];
export const UV_EBADF = codes.UV_EBADF[0];
export const UV_ENOSYS = codes.UV_ENOSYS[0];
export const UV_EADDRNOTAVAIL = codes.UV_EADDRNOTAVAIL[0];
export const UV_EACCES = codes.UV_EACCES[0];
export const UV_ENOBUFS = codes.UV_ENOBUFS[0];
export const UV_ESRCH = codes.UV_ESRCH[0];

export default uvBinding;
