/**
 * VirtualFS Adapter for just-bash
 * Implements IFileSystem interface to bridge VirtualFS with just-bash
 */
import type { IFileSystem, FsStat, MkdirOptions, RmOptions, CpOptions, BufferEncoding, FileContent } from 'just-bash';
import type { VirtualFS } from '../virtual-fs';
interface DirentEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}
interface ReadFileOptions {
    encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
    encoding?: BufferEncoding;
}
export declare class VirtualFSAdapter implements IFileSystem {
    private vfs;
    constructor(vfs: VirtualFS);
    /**
     * Read the contents of a file as a string
     */
    readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
    /**
     * Read the contents of a file as a Uint8Array (binary)
     */
    readFileBuffer(path: string): Promise<Uint8Array>;
    /**
     * Write content to a file, creating it if it doesn't exist
     */
    writeFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void>;
    /**
     * Append content to a file, creating it if it doesn't exist
     */
    appendFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void>;
    /**
     * Check if a path exists
     */
    exists(path: string): Promise<boolean>;
    /**
     * Get file/directory information
     */
    stat(path: string): Promise<FsStat>;
    /**
     * Create a directory
     */
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    /**
     * Read directory contents
     */
    readdir(path: string): Promise<string[]>;
    /**
     * Read directory contents with file type information
     */
    readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
    /**
     * Remove a file or directory
     */
    rm(path: string, options?: RmOptions): Promise<void>;
    /**
     * Recursively remove a directory and its contents
     */
    private rmRecursive;
    /**
     * Copy a file or directory
     */
    cp(src: string, dest: string, options?: CpOptions): Promise<void>;
    /**
     * Recursively copy a directory
     */
    private cpRecursive;
    /**
     * Move/rename a file or directory
     */
    mv(src: string, dest: string): Promise<void>;
    /**
     * Resolve a relative path against a base path
     */
    resolvePath(base: string, path: string): string;
    /**
     * Normalize a path (resolve . and .. segments)
     */
    private normalizePath;
    /**
     * Get all paths in the filesystem
     */
    getAllPaths(): string[];
    /**
     * Recursively collect all paths
     */
    private collectPaths;
    /**
     * Change file/directory permissions (no-op - VFS doesn't track permissions)
     */
    chmod(_path: string, _mode: number): Promise<void>;
    /**
     * Create a symbolic link (not supported)
     */
    symlink(_target: string, _linkPath: string): Promise<void>;
    /**
     * Create a hard link (not supported)
     */
    link(_existingPath: string, _newPath: string): Promise<void>;
    /**
     * Read the target of a symbolic link (not supported)
     */
    readlink(_path: string): Promise<string>;
    /**
     * Get file/directory information without following symlinks
     * Since VFS doesn't support symlinks, this is the same as stat
     */
    lstat(path: string): Promise<FsStat>;
    /**
     * Resolve all symlinks in a path
     * Since VFS doesn't support symlinks, just normalize and return
     */
    realpath(path: string): Promise<string>;
    /**
     * Set access and modification times (no-op - VFS doesn't track times)
     */
    utimes(path: string, _atime: Date, _mtime: Date): Promise<void>;
}
export {};
//# sourceMappingURL=vfs-adapter.d.ts.map