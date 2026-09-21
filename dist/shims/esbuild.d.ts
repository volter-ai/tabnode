/**
 * esbuild shim - Uses esbuild-wasm for transforms in the browser
 * Provides VFS integration for file access
 */
import type { VirtualFS } from '../virtual-fs';
export interface TransformOptions {
    loader?: 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css';
    format?: 'iife' | 'cjs' | 'esm';
    target?: string | string[];
    minify?: boolean;
    sourcemap?: boolean | 'inline' | 'external';
    jsx?: 'transform' | 'preserve';
    jsxFactory?: string;
    jsxFragment?: string;
}
/** A message esbuild returned, as much of it as the formatter reads. */
export interface EsbuildMessage {
    text?: string;
    location?: {
        file: string;
        line: number;
        column: number;
    } | null;
    notes?: Array<{
        text: string;
    }>;
}
/** A build's metafile, as much of it as the summary reads. */
export interface EsbuildMetafile {
    outputs?: Record<string, {
        bytes?: number;
    }>;
}
export interface TransformResult {
    code: string;
    map: string;
    warnings: unknown[];
}
export interface BuildOptions {
    /**
     * esbuild's two entry forms: a list of files, and the named form
     * `{ out: "in.ts" }` that gives each output its own name. Only the list is
     * made absolute against the working directory; the named form is passed on
     * as it was written.
     */
    entryPoints?: string[] | Record<string, string>;
    stdin?: {
        contents: string;
        resolveDir?: string;
        loader?: 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css';
    };
    bundle?: boolean;
    outdir?: string;
    outfile?: string;
    format?: 'iife' | 'cjs' | 'esm';
    platform?: 'browser' | 'node' | 'neutral';
    target?: string | string[];
    minify?: boolean;
    sourcemap?: boolean | 'inline' | 'external';
    external?: string[];
    write?: boolean;
    plugins?: unknown[];
    absWorkingDir?: string;
    /** Path of a tsconfig, read from the engine's filesystem and handed to esbuild as `tsconfigRaw`. */
    tsconfig?: string;
    tsconfigRaw?: string | TsconfigJson;
    /** Where a workspace member's sources are, as tsconfig paths with absolute targets. */
    workspacePaths?: Record<string, string[]>;
    /**
     * The packages this build is not of: an import of one is left to whoever
     * builds it, external under the specifier it was written with, rather than
     * bundled in. `self` are the specifiers this build IS of, which stay inside
     * it however they are imported. The ones an import actually reached come
     * back as `neighbors` on the result.
     */
    neighbors?: {
        names: string[];
        self?: string[];
    };
}
export interface BuildResult {
    errors: unknown[];
    warnings: unknown[];
    /** The specifiers `neighbors` left external, sorted; absent when a build named none. */
    neighbors?: string[];
    outputFiles?: Array<{
        path: string;
        contents: Uint8Array;
        text: string;
    }>;
    metafile?: {
        inputs?: Record<string, unknown>;
        outputs?: Record<string, unknown>;
    };
}
/**
 * The instance, for the lanes outside this module that need it: the module
 * transformer and the dev servers. Exporting the `let` itself put a live
 * binding in the shim's namespace, which is the surface a guest's
 * `require("esbuild")` reads; an accessor keeps that surface a stable
 * function rather than a value that changes under the guest.
 */
export declare function getEsbuildInstance(): typeof import('esbuild-wasm') | null;
export declare function setModuleURL(url: string): void;
/** An esbuild that runs elsewhere: a host a realm sends its builds to. */
export interface EsbuildHost {
    build: (options: BuildOptions) => Promise<BuildResult>;
    transform: (code: string, options?: TransformOptions) => Promise<TransformResult>;
    /** A host that can answer a transform before returning, native esbuild under a Node host, answers `transformSync`. */
    transformSync?: (code: string, options?: TransformOptions) => TransformResult;
    prebundle?: (options: BuildOptions) => Promise<BuildResult>;
    /**
     * The host answers the `neighbors` option itself: a build carrying it
     * crosses with the option in place and no plugin, since a plugin is a
     * function in this realm and cannot cross. A host that does not say so is
     * given the shim's plugin, as esbuild itself would be.
     */
    neighbors?: boolean;
}
export declare function formatMessages(messages: EsbuildMessage[], options?: {
    kind?: string;
}): Promise<string[]>;
export declare function analyzeMetafile(metafile: string | EsbuildMetafile, options?: unknown): Promise<string>;
export declare function useHost(host: EsbuildHost | null): void;
/**
 * Set the VirtualFS instance for file access
 */
export declare function setVFS(vfs: VirtualFS): void;
/**
 * Set the URL for the esbuild WASM file
 */
export declare function setWasmURL(url: string): void;
/**
 * Initialize esbuild-wasm
 * Must be called before using transform or build
 */
export declare function initialize(options?: {
    wasmURL?: string;
}): Promise<void>;
/**
 * Check if esbuild is initialized
 */
export declare function isInitialized(): boolean;
/**
 * Transform code using esbuild
 */
export declare function transform(code: string, options?: TransformOptions): Promise<TransformResult>;
/**
 * `esbuild.stop()`, as Node's esbuild has it: the thread held for
 * synchronous calls is ended; nothing else is held here.
 */
export declare function stop(): Promise<void>;
/**
 * Transform code synchronously, as `esbuild.transformSync` does in Node.
 */
export declare function transformSync(code: string, options?: TransformOptions): TransformResult;
/**
 * Transform ESM to CJS
 */
export declare function transformToCommonJS(code: string, options?: {
    loader?: TransformOptions['loader'];
}): Promise<string>;
/** As much of a tsconfig as the resolver reads. */
interface TsconfigJson {
    extends?: string | string[];
    compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
    } & Record<string, unknown>;
    [key: string]: unknown;
}
export declare function __flattenTsconfig(raw: string | TsconfigJson, directory: string, seen?: Set<string>): TsconfigJson;
/**
 * Build/bundle code (limited support in browser)
 */
export declare function build(options: BuildOptions): Promise<BuildResult>;
/**
 * Build synchronously (not supported in browser, throws error)
 */
export declare function buildSync(_options: BuildOptions): BuildResult;
/**
 * Get the esbuild version
 */
export declare function version(): string;
export declare function context(options: BuildOptions): Promise<unknown>;
declare const _default: {
    initialize: typeof initialize;
    isInitialized: typeof isInitialized;
    transform: typeof transform;
    transformSync: typeof transformSync;
    transformToCommonJS: typeof transformToCommonJS;
    build: typeof build;
    buildSync: typeof buildSync;
    context: typeof context;
    stop: typeof stop;
    version: typeof version;
    setWasmURL: typeof setWasmURL;
    setVFS: typeof setVFS;
    setModuleURL: typeof setModuleURL;
    useHost: typeof useHost;
    formatMessages: typeof formatMessages;
    analyzeMetafile: typeof analyzeMetafile;
};
export default _default;
//# sourceMappingURL=esbuild.d.ts.map