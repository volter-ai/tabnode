/**
 * Virtual File System - In-memory file tree with POSIX-like operations
 */
import type { VFSSnapshot } from './runtime-interface';
import { Readable } from './node-lib/stream-module';
/**
 * A read stream is a real `Readable`, so a guest can pipe it, iterate it, or
 * listen for `open` and `ready`; the hand-rolled object it used to answer had
 * only `on` and `pipe`, so anything that treated it as a stream got nothing.
 * `start`, `end` and `encoding` are honoured as Node honours them.
 *
 * What `createReadStream` accepts: the subset of Node's options bag used here.
 */
export interface ReadStreamOptions {
    encoding?: string;
    start?: number;
    end?: number;
}
/** A `Readable` carrying the two properties Node's fs read stream carries. */
export interface FsReadStream extends Readable {
    path: string;
    bytesRead: number;
}
export interface FSNode {
    type: 'file' | 'directory' | 'symlink';
    content?: Uint8Array;
    /** Where a symlink points, exactly as it was written. */
    target?: string;
    children?: Map<string, FSNode>;
    mtime: number;
    /**
     * When the file was last read. Node reports it apart from the write time
     * and `utimes` sets the two separately; this filesystem reported the write
     * time in its place, so a program that set an access time and read it back
     * got the other one (Node's own test/wasi `stat` fixture asserts them
     * apart). Absent until something sets it, which is the write time.
     */
    atime?: number;
}
type VFSChangeListener = (path: string, content: string) => void;
type VFSDeleteListener = (path: string) => void;
export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    size: number;
    mode: number;
    mtime: Date;
    atime: Date;
    ctime: Date;
    birthtime: Date;
    mtimeMs: number;
    atimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    nlink: number;
    uid: number;
    gid: number;
    dev: number;
    ino: number;
    rdev: number;
    blksize: number;
    blocks: number;
}
export type WatchEventType = 'change' | 'rename';
export type WatchListener = (eventType: WatchEventType, filename: string | null) => void;
export interface FSWatcher {
    close(): void;
    ref(): this;
    unref(): this;
}
/**
 * Create a Node.js-style error with code property
 */
export interface NodeError extends Error {
    code: string;
    errno: number;
    syscall: string;
    path?: string;
}
export declare function createNodeError(code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY' | 'ELOOP' | 'EINVAL', syscall: string, path: string, message?: string): NodeError;
export declare class VirtualFS {
    private root;
    private encoder;
    private decoder;
    private watchers;
    private eventListeners;
    constructor();
    /**
     * Add event listener (for change notifications to workers)
     */
    on(event: 'change', listener: VFSChangeListener): this;
    on(event: 'delete', listener: VFSDeleteListener): this;
    /**
     * Remove event listener
     */
    off(event: 'change', listener: VFSChangeListener): this;
    off(event: 'delete', listener: VFSDeleteListener): this;
    /**
     * Emit event to listeners
     */
    private emit;
    /**
     * Serialize the entire file tree to a snapshot (for worker transfer)
     */
    toSnapshot(): VFSSnapshot;
    private serializeNode;
    /**
     * Create a VirtualFS from a snapshot
     */
    static fromSnapshot(snapshot: VFSSnapshot): VirtualFS;
    /**
     * Internal write that optionally emits events
     */
    private writeFileSyncInternal;
    /**
     * Normalize path - resolve . and .. segments, ensure leading /
     */
    private normalizePath;
    /**
     * Get path segments from normalized path
     */
    private getPathSegments;
    /**
     * Get parent directory path
     */
    private getParentPath;
    /**
     * Get basename from path
     */
    private getBasename;
    /**
     * Get node at path, returns undefined if not found
     */
    getNode(path: string): FSNode | undefined;
    /** The node at a path, following every link on the way and, when `follow`, the last one too. */
    __substrateNode(path: string, follow: boolean, depth: number): FSNode | undefined;
    /** A link's target as an absolute path: absolute as written, or relative to the link's directory. */
    __substrateLinkTarget(linkPath: string, target: string): string;
    symlinkSync(target: string, path: string): void;
    readlinkSync(path: string): string;
    /**
     * Get or create directory at path (for mkdir -p behavior)
     */
    private ensureDirectory;
    /**
     * Check if path exists
     */
    existsSync(path: string): boolean;
    /**
     * Get stats for path
     */
    statSync(path: string): Stats;
    /**
     * lstatSync - same as statSync for our virtual FS (no symlinks)
     */
    lstatSync(path: string): Stats;
    /**
     * Read file contents as Uint8Array
     */
    readFileSync(path: string): Uint8Array;
    readFileSync(path: string, encoding: 'utf8' | 'utf-8'): string;
    /**
     * Write data to file, creating parent directories as needed
     */
    writeFileSync(path: string, data: string | Uint8Array): void;
    /**
     * Create directory, optionally with recursive parent creation
     */
    mkdirSync(path: string, options?: {
        recursive?: boolean;
    }): void;
    /**
     * Read directory contents
     */
    readdirSync(path: string): string[];
    /**
     * Remove file
     */
    unlinkSync(path: string): void;
    /**
     * Remove directory (must be empty)
     */
    rmdirSync(path: string): void;
    /**
     * Rename/move file or directory
     */
    renameSync(oldPath: string, newPath: string): void;
    /**
     * Read file with optional options parameter
     */
    readFile(path: string, optionsOrCallback?: string | {
        encoding?: string;
    } | ((err: Error | null, data?: Uint8Array | string) => void), callback?: (err: Error | null, data?: Uint8Array | string) => void): void | Promise<Uint8Array | string>;
    /**
     * Async stat
     */
    stat(path: string, callback: (err: Error | null, stats?: Stats) => void): void;
    /**
     * Async lstat
     */
    lstat(path: string, callback: (err: Error | null, stats?: Stats) => void): void;
    /**
     * Async readdir
     */
    readdir(path: string, optionsOrCallback?: {
        withFileTypes?: boolean;
    } | ((err: Error | null, files?: string[]) => void), callback?: (err: Error | null, files?: string[]) => void): void;
    /**
     * Async realpath
     */
    realpath(path: string, callback: (err: Error | null, resolvedPath?: string) => void): void;
    /**
     * Sync realpath - in our VFS, just normalize the path
     */
    realpathSync(path: string): string;
    /**
     * Watch for file changes
     */
    watch(filename: string, optionsOrListener?: {
        persistent?: boolean;
        recursive?: boolean;
        encoding?: string;
    } | WatchListener, listener?: WatchListener): FSWatcher;
    /**
     * Notify watchers of file changes
     */
    private notifyWatchers;
    /**
     * Access check - in our VFS, always succeeds if file exists
     */
    accessSync(path: string, mode?: number): void;
    /**
     * Async access
     */
    access(path: string, modeOrCallback?: number | ((err: Error | null) => void), callback?: (err: Error | null) => void): void;
    /**
     * Copy file
     */
    copyFileSync(src: string, dest: string): void;
    /**
     * Create read stream - simplified implementation
     */
    createReadStream(path: string, options?: ReadStreamOptions | string): FsReadStream;
    /**
     * Create write stream - simplified implementation
     */
    createWriteStream(path: string): {
        write: (data: string | Uint8Array) => boolean;
        end: (data?: string | Uint8Array) => void;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
    };
}
export {};
//# sourceMappingURL=virtual-fs.d.ts.map