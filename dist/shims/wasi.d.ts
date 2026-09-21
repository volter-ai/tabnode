/** The stats the engine's fs answers, read by name. */
export interface WasiHostStats {
    size: number;
    ino?: number;
    dev?: number;
    nlink?: number;
    atimeMs?: number;
    mtimeMs?: number;
    ctimeMs?: number;
    atime?: Date;
    mtime?: Date;
    ctime?: Date;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isCharacterDevice?(): boolean;
    isBlockDevice?(): boolean;
    isSocket?(): boolean;
    isFIFO?(): boolean;
}
export interface WasiHostDirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}
/** The fs members the binding calls; each is the engine's `fs.<name>`. */
export interface WasiHostFs {
    existsSync(path: string): boolean;
    statSync(path: string): WasiHostStats;
    lstatSync(path: string): WasiHostStats;
    fstatSync(fd: number): WasiHostStats;
    openSync(path: string, flags: string | number, mode?: number): number;
    closeSync(fd: number): void;
    readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
    writeSync(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): number;
    readdirSync(path: string, options: {
        withFileTypes: true;
    }): WasiHostDirent[];
    mkdirSync(path: string, options?: {
        recursive?: boolean;
    }): void;
    rmdirSync(path: string): void;
    unlinkSync(path: string): void;
    renameSync(oldPath: string, newPath: string): void;
    realpathSync(path: string): string;
    ftruncateSync(fd: number, length?: number): void;
    utimesSync?(path: string, atime: number, mtime: number): void;
    readlinkSync?(path: string): string;
    symlinkSync?(target: string, path: string): void;
}
/** The process members the binding reaches: the guest's own. */
export interface WasiHostProcess {
    pid: number;
    stdout: {
        write(data: string): unknown;
    };
    stderr: {
        write(data: string): unknown;
    };
    stdin: {
        read?: (size?: number) => string | Uint8Array | null;
    };
    exit(code?: number): never;
    kill(pid: number, signal?: string | number): boolean;
    emitWarning(warning: string | Error, ...rest: unknown[]): void;
}
/** The `wasi` module as Node's `lib/wasi.js` exports it. */
export interface WasiModule {
    WASI: new (options?: unknown) => {
        wasiImport: Record<string, unknown>;
        start(instance: unknown): number;
        initialize(instance: unknown): void;
        getImportObject(): Record<string, Record<string, unknown>>;
    };
}
export declare function createWasiModule(fs: WasiHostFs, process: WasiHostProcess): WasiModule;
//# sourceMappingURL=wasi.d.ts.map