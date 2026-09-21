/**
 * The engine's constant tables, in the two shapes Node serves them in.
 *
 * Node keeps one table, `internalBinding('constants')`, grouped by subsystem
 * (`os`, `fs`, `crypto`, `zlib`, `trace`); `lib/constants.js` is that table
 * spread flat, and `process.binding('constants')` hands out the groups. The
 * engine had only the flat form, written out here, and no `process.binding`
 * at all, so a bundle that feature-detects through it -- the Prisma CLI asks
 * for `constants`, `buffer` and `tty_wrap` -- called `undefined` and died
 * with a TypeError where Node answers. The groups below are that same flat
 * table read back apart by name, so there is one set of numbers in the
 * engine and the binding cannot drift from `require("constants")`.
 *
 * `crypto` and `zlib` groups are object literals built inside
 * `constantsBinding`, not imported tables. A getter over an imported
 * `const` is a live binding: a consumer's bundler inlined it to
 * `zlib: constants$N` and called this function while that const was still
 * in its temporal dead zone. Literals have no binding to access.
 */

// Node's old `constants` module, the flat table of fs, os, and signal constants,
// which graceful-fs still requires on its way into every React Router build; the
// engine's table had no entry, and the require was read as a file named
// `constants`. The table is Node's own for this flavour, measured against it:
// every errno, signal, libuv dirent and copy flag, scheduling priority and
// dlopen mode Node names. OpenSSL's cipher, padding, curve and engine numbers
// stay out — the engine has no OpenSSL, and a number that names an option of a
// subsystem a tab does not have is a surface that answers and then cannot act.
export const nodeConstants = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 512, O_EXCL: 2048, O_NOCTTY: 131072, O_TRUNC: 1024, O_APPEND: 8, O_DIRECTORY: 1048576, O_NOFOLLOW: 256, O_SYNC: 128, O_SYMLINK: 2097152, O_NONBLOCK: 4, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192, S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152, S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64, S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8, S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1, SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 10, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 30, SIGSEGV: 11, SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 20, SIGCONT: 19, SIGSTOP: 17, SIGTSTP: 18, SIGWINCH: 28, E2BIG: 7, EACCES: 13, EADDRINUSE: 48, EAGAIN: 35, EBADF: 9, EBUSY: 16, ECONNREFUSED: 61, ECONNRESET: 54, EEXIST: 17, EINVAL: 22, EIO: 5, EISDIR: 21, EMFILE: 24, ENOENT: 2, ENOSPC: 28, ENOTDIR: 20, ENOTEMPTY: 66, EPERM: 1, EPIPE: 32, ETIMEDOUT: 60, EADDRNOTAVAIL: 49, EAFNOSUPPORT: 47, EALREADY: 37, EBADMSG: 94, ECANCELED: 89, ECHILD: 10, ECONNABORTED: 53, EDEADLK: 11, EDESTADDRREQ: 39, EDOM: 33, EDQUOT: 69, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 65, EIDRM: 90, EILSEQ: 92, EINPROGRESS: 36, EINTR: 4, EISCONN: 56, ELOOP: 62, EMLINK: 31, EMSGSIZE: 40, EMULTIHOP: 95, ENAMETOOLONG: 63, ENETDOWN: 50, ENETRESET: 52, ENETUNREACH: 51, ENFILE: 23, ENOBUFS: 55, ENODATA: 96, ENODEV: 19, ENOEXEC: 8, ENOLCK: 77, ENOLINK: 97, ENOMEM: 12, ENOMSG: 91, ENOPROTOOPT: 42, ENOSR: 98, ENOSTR: 99, ENOSYS: 78, ENOTCONN: 57, ENOTSOCK: 38, ENOTSUP: 45, ENOTTY: 25, ENXIO: 6, EOPNOTSUPP: 102, EOVERFLOW: 84, EPROTO: 100, EPROTONOSUPPORT: 43, EPROTOTYPE: 41, ERANGE: 34, EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 70, ETIME: 101, ETXTBSY: 26, EWOULDBLOCK: 35, EXDEV: 18, SIGINFO: 29, SIGIO: 23, SIGIOT: 6, SIGPROF: 27, SIGSYS: 12, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 16, SIGVTALRM: 26, SIGXCPU: 24, SIGXFSZ: 25, PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20, RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_LOCAL: 4, RTLD_GLOBAL: 8, O_DSYNC: 4194304, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, UV_FS_COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4, UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3, UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7, UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2, UV_FS_O_FILEMAP: 0, UV_FS_O_RANDOM: 0, UV_FS_O_SEQUENTIAL: 0, UV_FS_O_SHORT_LIVED: 0, UV_FS_O_TEMPORARY: 0, EXTENSIONLESS_FORMAT_JAVASCRIPT: 0, EXTENSIONLESS_FORMAT_WASM: 1 };

/** Which group of Node's binding a flat name belongs to. */
function groupOf(name: string): 'errno' | 'signals' | 'priority' | 'dlopen' | 'fs' {
  if (/^E[A-Z0-9]+$/.test(name)) return 'errno';
  if (name.startsWith('SIG')) return 'signals';
  if (name.startsWith('PRIORITY_')) return 'priority';
  if (name.startsWith('RTLD_')) return 'dlopen';
  return 'fs';
}

type ConstantsBinding = {
  os: { UV_UDP_REUSEADDR: number; dlopen: Record<string, number>; errno: Record<string, number>; signals: Record<string, number>; priority: Record<string, number> };
  fs: Record<string, number>;
  crypto: Record<string, unknown>;
  zlib: Record<string, unknown>;
  trace: Record<string, number>;
};

let binding: ConstantsBinding | null = null;

/**
 * `process.binding('constants')`, built on the first ask and kept, as Node
 * hands out the same object every time.
 */
export function constantsBinding(): ConstantsBinding {
  if (binding) return binding;
  const groups: Record<string, Record<string, number>> = { errno: {}, signals: {}, priority: {}, dlopen: {}, fs: {} };
  for (const [name, value] of Object.entries(nodeConstants)) groups[groupOf(name)][name] = value as number;
  binding = {
    // libuv's own flag, which Node's binding carries beside the os groups and
    // the flat table has never held.
    os: { UV_UDP_REUSEADDR: 4, dlopen: groups.dlopen, errno: groups.errno, signals: groups.signals, priority: groups.priority },
    fs: groups.fs,
    crypto: { SSL_OP_ALL: 0, RSA_PKCS1_PADDING: 1, RSA_PKCS1_OAEP_PADDING: 4, RSA_PKCS1_PSS_PADDING: 6 },
    zlib: { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, ZLIB_VERNUM: 4784, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1, BROTLI_DECODE: 0, BROTLI_ENCODE: 1, BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_PARAM_QUALITY: 1, BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_PARAM_LGWIN: 2, BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_DEFAULT_WINDOW: 22, BROTLI_PARAM_LGBLOCK: 3, BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24 },
    trace: { TRACE_EVENT_PHASE_BEGIN: 66, TRACE_EVENT_PHASE_END: 69, TRACE_EVENT_PHASE_COMPLETE: 88, TRACE_EVENT_PHASE_INSTANT: 73, TRACE_EVENT_PHASE_ASYNC_BEGIN: 83, TRACE_EVENT_PHASE_ASYNC_STEP_INTO: 84, TRACE_EVENT_PHASE_ASYNC_STEP_PAST: 112, TRACE_EVENT_PHASE_ASYNC_END: 70, TRACE_EVENT_PHASE_NESTABLE_ASYNC_BEGIN: 98, TRACE_EVENT_PHASE_NESTABLE_ASYNC_END: 101, TRACE_EVENT_PHASE_NESTABLE_ASYNC_INSTANT: 110, TRACE_EVENT_PHASE_FLOW_BEGIN: 115, TRACE_EVENT_PHASE_FLOW_STEP: 116, TRACE_EVENT_PHASE_FLOW_END: 102, TRACE_EVENT_PHASE_METADATA: 77, TRACE_EVENT_PHASE_COUNTER: 67, TRACE_EVENT_PHASE_SAMPLE: 80, TRACE_EVENT_PHASE_CREATE_OBJECT: 78, TRACE_EVENT_PHASE_SNAPSHOT_OBJECT: 79, TRACE_EVENT_PHASE_DELETE_OBJECT: 68, TRACE_EVENT_PHASE_MEMORY_DUMP: 118, TRACE_EVENT_PHASE_MARK: 82, TRACE_EVENT_PHASE_CLOCK_SYNC: 99 },
  };
  return binding;
}
