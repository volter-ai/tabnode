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
export declare const nodeConstants: {
    O_RDONLY: number;
    O_WRONLY: number;
    O_RDWR: number;
    O_CREAT: number;
    O_EXCL: number;
    O_NOCTTY: number;
    O_TRUNC: number;
    O_APPEND: number;
    O_DIRECTORY: number;
    O_NOFOLLOW: number;
    O_SYNC: number;
    O_SYMLINK: number;
    O_NONBLOCK: number;
    S_IFMT: number;
    S_IFREG: number;
    S_IFDIR: number;
    S_IFCHR: number;
    S_IFBLK: number;
    S_IFIFO: number;
    S_IFLNK: number;
    S_IFSOCK: number;
    S_IRWXU: number;
    S_IRUSR: number;
    S_IWUSR: number;
    S_IXUSR: number;
    S_IRWXG: number;
    S_IRGRP: number;
    S_IWGRP: number;
    S_IXGRP: number;
    S_IRWXO: number;
    S_IROTH: number;
    S_IWOTH: number;
    S_IXOTH: number;
    F_OK: number;
    R_OK: number;
    W_OK: number;
    X_OK: number;
    UV_FS_COPYFILE_EXCL: number;
    COPYFILE_EXCL: number;
    SIGHUP: number;
    SIGINT: number;
    SIGQUIT: number;
    SIGILL: number;
    SIGTRAP: number;
    SIGABRT: number;
    SIGBUS: number;
    SIGFPE: number;
    SIGKILL: number;
    SIGUSR1: number;
    SIGSEGV: number;
    SIGUSR2: number;
    SIGPIPE: number;
    SIGALRM: number;
    SIGTERM: number;
    SIGCHLD: number;
    SIGCONT: number;
    SIGSTOP: number;
    SIGTSTP: number;
    SIGWINCH: number;
    E2BIG: number;
    EACCES: number;
    EADDRINUSE: number;
    EAGAIN: number;
    EBADF: number;
    EBUSY: number;
    ECONNREFUSED: number;
    ECONNRESET: number;
    EEXIST: number;
    EINVAL: number;
    EIO: number;
    EISDIR: number;
    EMFILE: number;
    ENOENT: number;
    ENOSPC: number;
    ENOTDIR: number;
    ENOTEMPTY: number;
    EPERM: number;
    EPIPE: number;
    ETIMEDOUT: number;
    EADDRNOTAVAIL: number;
    EAFNOSUPPORT: number;
    EALREADY: number;
    EBADMSG: number;
    ECANCELED: number;
    ECHILD: number;
    ECONNABORTED: number;
    EDEADLK: number;
    EDESTADDRREQ: number;
    EDOM: number;
    EDQUOT: number;
    EFAULT: number;
    EFBIG: number;
    EHOSTUNREACH: number;
    EIDRM: number;
    EILSEQ: number;
    EINPROGRESS: number;
    EINTR: number;
    EISCONN: number;
    ELOOP: number;
    EMLINK: number;
    EMSGSIZE: number;
    EMULTIHOP: number;
    ENAMETOOLONG: number;
    ENETDOWN: number;
    ENETRESET: number;
    ENETUNREACH: number;
    ENFILE: number;
    ENOBUFS: number;
    ENODATA: number;
    ENODEV: number;
    ENOEXEC: number;
    ENOLCK: number;
    ENOLINK: number;
    ENOMEM: number;
    ENOMSG: number;
    ENOPROTOOPT: number;
    ENOSR: number;
    ENOSTR: number;
    ENOSYS: number;
    ENOTCONN: number;
    ENOTSOCK: number;
    ENOTSUP: number;
    ENOTTY: number;
    ENXIO: number;
    EOPNOTSUPP: number;
    EOVERFLOW: number;
    EPROTO: number;
    EPROTONOSUPPORT: number;
    EPROTOTYPE: number;
    ERANGE: number;
    EROFS: number;
    ESPIPE: number;
    ESRCH: number;
    ESTALE: number;
    ETIME: number;
    ETXTBSY: number;
    EWOULDBLOCK: number;
    EXDEV: number;
    SIGINFO: number;
    SIGIO: number;
    SIGIOT: number;
    SIGPROF: number;
    SIGSYS: number;
    SIGTTIN: number;
    SIGTTOU: number;
    SIGURG: number;
    SIGVTALRM: number;
    SIGXCPU: number;
    SIGXFSZ: number;
    PRIORITY_LOW: number;
    PRIORITY_BELOW_NORMAL: number;
    PRIORITY_NORMAL: number;
    PRIORITY_ABOVE_NORMAL: number;
    PRIORITY_HIGH: number;
    PRIORITY_HIGHEST: number;
    RTLD_LAZY: number;
    RTLD_NOW: number;
    RTLD_LOCAL: number;
    RTLD_GLOBAL: number;
    O_DSYNC: number;
    COPYFILE_FICLONE: number;
    COPYFILE_FICLONE_FORCE: number;
    UV_FS_COPYFILE_FICLONE: number;
    UV_FS_COPYFILE_FICLONE_FORCE: number;
    UV_DIRENT_UNKNOWN: number;
    UV_DIRENT_FILE: number;
    UV_DIRENT_DIR: number;
    UV_DIRENT_LINK: number;
    UV_DIRENT_FIFO: number;
    UV_DIRENT_SOCKET: number;
    UV_DIRENT_CHAR: number;
    UV_DIRENT_BLOCK: number;
    UV_FS_SYMLINK_DIR: number;
    UV_FS_SYMLINK_JUNCTION: number;
    UV_FS_O_FILEMAP: number;
    UV_FS_O_RANDOM: number;
    UV_FS_O_SEQUENTIAL: number;
    UV_FS_O_SHORT_LIVED: number;
    UV_FS_O_TEMPORARY: number;
    EXTENSIONLESS_FORMAT_JAVASCRIPT: number;
    EXTENSIONLESS_FORMAT_WASM: number;
};
type ConstantsBinding = {
    os: {
        UV_UDP_REUSEADDR: number;
        dlopen: Record<string, number>;
        errno: Record<string, number>;
        signals: Record<string, number>;
        priority: Record<string, number>;
    };
    fs: Record<string, number>;
    crypto: Record<string, unknown>;
    zlib: Record<string, unknown>;
    trace: Record<string, number>;
};
/**
 * `process.binding('constants')`, built on the first ask and kept, as Node
 * hands out the same object every time.
 */
export declare function constantsBinding(): ConstantsBinding;
export {};
//# sourceMappingURL=constants.d.ts.map