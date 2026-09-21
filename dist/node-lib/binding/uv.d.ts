/**
 * `internalBinding('uv')`: libuv's error numbers and names.
 *
 * The engine has no libuv, and the numbers are still libuv's, because Node's
 * own files compare against them and a program reads `err.errno` and
 * `err.code` and expects the pair a Linux Node reports. The engine's platform
 * is `linux`, so these are Linux's.
 */
/** libuv's `uv_err_name`: the code a number stands for, `UNKNOWN` for a number none does. */
export declare function errname(code: number): string;
/** Node's `getErrorMap()`: every number to its `[name, message]` pair. */
export declare function getErrorMap(): Map<number, [string, string]>;
declare const uvBinding: Record<string, unknown>;
export declare const UV_EOF: number;
export declare const UV_ECONNREFUSED: number;
export declare const UV_ECONNRESET: number;
export declare const UV_EADDRINUSE: number;
export declare const UV_ENOENT: number;
export declare const UV_ENOTSOCK: number;
export declare const UV_EPIPE: number;
export declare const UV_EINVAL: number;
export declare const UV_ENOTCONN: number;
export declare const UV_ECANCELED: number;
export declare const UV_ENOTSUP: number;
export declare const UV_EBADF: number;
export declare const UV_ENOSYS: number;
export declare const UV_EADDRNOTAVAIL: number;
export declare const UV_EACCES: number;
export declare const UV_ENOBUFS: number;
export declare const UV_ESRCH: number;
export default uvBinding;
//# sourceMappingURL=uv.d.ts.map