export interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
}
export interface FormatInputPathObject {
    root?: string | undefined;
    dir?: string | undefined;
    base?: string | undefined;
    ext?: string | undefined;
    name?: string | undefined;
}
export interface PlatformPath {
    normalize(path: string): string;
    join(...paths: string[]): string;
    resolve(...paths: string[]): string;
    isAbsolute(path: string): boolean;
    relative(from: string, to: string): string;
    dirname(path: string): string;
    basename(path: string, suffix?: string): string;
    extname(path: string): string;
    parse(path: string): ParsedPath;
    format(pathObject: FormatInputPathObject): string;
    toNamespacedPath<T>(path: T): T;
    matchesGlob(path: string, pattern: string): boolean;
    _makeLong<T>(path: T): T;
    readonly sep: string;
    readonly delimiter: string;
    readonly posix: PlatformPath;
    readonly win32: PlatformPath;
}
declare const nodePath: PlatformPath;
export declare const posix: PlatformPath;
export declare const win32: PlatformPath;
export declare const sep: string;
export declare const delimiter: string;
export declare const normalize: (path: string) => string;
export declare const join: (...paths: string[]) => string;
export declare const resolve: (...paths: string[]) => string;
export declare const isAbsolute: (path: string) => boolean;
export declare const relative: (from: string, to: string) => string;
export declare const dirname: (path: string) => string;
export declare const basename: (path: string, suffix?: string) => string;
export declare const extname: (path: string) => string;
export declare const parse: (path: string) => ParsedPath;
export declare const format: (pathObject: FormatInputPathObject) => string;
export declare const toNamespacedPath: <T>(path: T) => T;
export declare const matchesGlob: (path: string, pattern: string) => boolean;
export default nodePath;
//# sourceMappingURL=path.d.ts.map