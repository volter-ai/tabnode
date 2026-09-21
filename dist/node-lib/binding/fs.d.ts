import type { VirtualFS } from '../../virtual-fs';
/** The key the engine hangs a run's filesystem off its guest process. */
export declare const kRunFilesystem: unique symbol;
export declare function withFilesystem<T>(tree: VirtualFS, work: () => T): T;
/** A request object `fs.js` hands an asynchronous call, answered on a tick. */
interface FSReq {
    oncomplete?: (error: Error | null, ...rest: unknown[]) => void;
}
/**
 * The request object `fs.js` makes for every asynchronous call and hangs its
 * callback off. Node's is a C++ handle the event loop owns; here it carries
 * the callback and nothing else, because `answer` above is the whole of what
 * makes a call asynchronous in a realm with one thread.
 */
export declare class FSReqCallback {
    bigint: boolean;
    oncomplete: ((error: Error | null, ...rest: unknown[]) => void) | undefined;
    context: unknown;
    constructor(bigint?: boolean);
}
/** The symbol `fs.promises` passes where a callback would go. */
export declare const kUsePromises: unique symbol;
/**
 * `internalBinding('fs_dir')`'s handle: an open directory, read a batch at a
 * time. Node's own `Dir` and `Dirent` are built on it; what a handle owes is
 * a flat list of name and type, and `null` when there is nothing left.
 */
export declare class DirHandle {
    #private;
    constructor(path: string, encoding?: unknown);
    read(encoding?: string, bufferSize?: number, req?: FSReq): unknown;
    close(req?: FSReq): undefined;
}
export declare const fsDirBinding: {
    opendirSync(path: unknown, encoding?: unknown): DirHandle;
    opendir(path: unknown, encoding: string, req?: FSReq): DirHandle | undefined;
};
/**
 * `internalBinding('fs_event_wrap')`'s `FSEvent`: what `fs.watch` is. The
 * engine's tree reports its own changes, and this is the shape Node's
 * `FSWatcher` expects around them -- a start that takes a path and answers
 * an errno, a close, and `onchange(status, event, filename)`.
 */
export declare class FSEvent {
    #private;
    onchange: ((status: number, event: string, filename: string) => void) | null;
    initialized: boolean;
    start(path: unknown, _persistent?: boolean, recursive?: boolean, _encoding?: string): number;
    close(): void;
    ref(): void;
    unref(): void;
    getAsyncId(): number;
    hasRef(): boolean;
}
/**
 * `StatWatcher`: what `fs.watchFile` is. It polls, as libuv's does, and the
 * interval is the one the program asked for.
 */
export declare class StatWatcher {
    #private;
    bigint: boolean;
    onchange: ((current: Float64Array | BigInt64Array, previous: Float64Array | BigInt64Array) => void) | null;
    constructor(bigint?: boolean);
    start(path: unknown, interval?: number): number;
    stop(): void;
    close(): void;
    ref(): void;
    unref(): void;
    getAsyncId(): number;
    hasRef(): boolean;
}
export declare const fsEventWrapBinding: {
    FSEvent: typeof FSEvent;
};
/**
 * What `fs.promises.open` is handed: a descriptor with a close of its own.
 * Node's is a C++ handle whose destructor closes the file; here it is the
 * same number this file's table keeps, with the same close.
 */
export declare class FileHandle {
    fd: number;
    constructor(fd: number);
    close(): Promise<void>;
    release(): void;
    getAsyncId(): number;
}
export declare const fsBinding: {
    FSReqCallback: typeof FSReqCallback;
    kUsePromises: symbol;
    StatWatcher: typeof StatWatcher;
    /** `fs.promises.open`: the same open, answered as a promise with a handle. */
    openFileHandle(path: unknown, flags: number, mode: number, usePromises?: unknown): Promise<FileHandle> | FileHandle;
    open(path: unknown, flags: number, _mode: number, req?: FSReq): number | undefined;
    close(fd: number, req?: FSReq): undefined;
    read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number, req?: FSReq): number | undefined;
    readBuffers(fd: number, buffers: Uint8Array[], position: number, req?: FSReq): number | undefined;
    /** Node's fast path for `readFile` with an encoding it can decode itself. */
    readFileUtf8(path: unknown, _flags: number): string;
    writeBuffer(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, req?: FSReq): number | undefined;
    writeBuffers(fd: number, buffers: Uint8Array[], position: number | null, req?: FSReq): number | undefined;
    writeString(fd: number, value: string, position: number | null, encoding: string | undefined, req?: FSReq): number | undefined;
    writeFileUtf8(path: unknown, data: string, flags: number, _mode: number): undefined;
    stat(path: unknown, bigint: boolean, req?: FSReq, throwIfNoEntry?: boolean): Float64Array | BigInt64Array | undefined;
    lstat(path: unknown, bigint: boolean, req?: FSReq, throwIfNoEntry?: boolean): Float64Array | BigInt64Array | undefined;
    fstat(fd: number, bigint: boolean, req?: FSReq): Float64Array | BigInt64Array | undefined;
    /**
     * `statfs`: a tab's filesystem is the page's memory, and it has no device
     * of its own. The numbers are a filesystem's shape rather than a lie about
     * a disk: a block size, and a count no program can exhaust.
     */
    statfs(_path: unknown, bigint: boolean, req?: FSReq): Float64Array | BigInt64Array | undefined;
    access(path: unknown, _mode: number, req?: FSReq): undefined;
    existsSync(path: unknown): boolean;
    /**
     * Node's `cpSync` asks this before it copies: a directory is not a file,
     * and without `recursive` the copy of one is `ERR_FS_EISDIR`.
     */
    cpSyncCheckPaths(src: unknown, dest: unknown, dereference: boolean, recursive: boolean): undefined;
    /** Node's C++ `cp` of a file onto an existing dest. */
    cpSyncOverrideFile(src: unknown, dest: unknown, _mode: number, _preserveTimestamps: boolean): undefined;
    /** Node's C++ recursive directory copy, without a JS filter. */
    cpSyncCopyDir(src: unknown, dest: unknown, force: boolean, dereference: boolean, errorOnExist: boolean, _verbatimSymlinks: boolean, _preserveTimestamps: boolean): undefined;
    /**
     * What the module loader asks of a path before it reads it: 0 for a file,
     * 1 for a directory, and a negative errno for neither.
     *
     * Node has called this with a receiver in front of the path and without
     * one across versions; the three vendored call sites here -- `fs.js`'s
     * `glob` twice and `internal/fs/promises.js`'s once -- pass the path alone,
     * so the path is whichever argument is one.
     */
    internalModuleStat(receiver: unknown, path?: unknown): number;
    readdir(path: unknown, encoding: string, withFileTypes: boolean, req?: FSReq): unknown;
    mkdir(path: unknown, mode: number, recursive: boolean, req?: FSReq): string | undefined;
    rmdir(path: unknown, req?: FSReq): undefined;
    unlink(path: unknown, req?: FSReq): undefined;
    rename(from: unknown, to: unknown, req?: FSReq): undefined;
    copyFile(from: unknown, to: unknown, mode: number, req?: FSReq): undefined;
    link(from: unknown, to: unknown, req?: FSReq): undefined;
    symlink(target: unknown, path: unknown, _type: unknown, req?: FSReq): undefined;
    readlink(path: unknown, encoding: string, req?: FSReq): string | Uint8Array | undefined;
    realpath(path: unknown, encoding: string, req?: FSReq): string | Uint8Array | undefined;
    mkdtemp(prefix: unknown, encoding: string, req?: FSReq): string | Uint8Array | undefined;
    chmod(path: unknown, mode: number, req?: FSReq): undefined;
    fchmod(fd: number, mode: number, req?: FSReq): undefined;
    chown(path: unknown, _uid: number, _gid: number, req?: FSReq): undefined;
    fchown(_fd: number, _uid: number, _gid: number, req?: FSReq): undefined;
    lchown(_path: unknown, _uid: number, _gid: number, req?: FSReq): undefined;
    utimes(_path: unknown, _atime: number, _mtime: number, req?: FSReq): undefined;
    futimes(_fd: number, _atime: number, _mtime: number, req?: FSReq): undefined;
    lutimes(_path: unknown, _atime: number, _mtime: number, req?: FSReq): undefined;
    fsync(_fd: number, req?: FSReq): undefined;
    fdatasync(_fd: number, req?: FSReq): undefined;
    ftruncate(fd: number, length: number, req?: FSReq): undefined;
};
export default fsBinding;
//# sourceMappingURL=fs.d.ts.map