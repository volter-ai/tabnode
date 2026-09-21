/**
 * Rollup shim - Uses @rollup/browser for browser-compatible Rollup
 *
 * Vite uses Rollup for bundling. The native Rollup package doesn't work
 * in browsers, so we need to use @rollup/browser instead.
 */
/** What a rollup build is handed, and what it answers. */
export interface RollupBuildOptions {
    fs?: unknown;
    [key: string]: unknown;
}
export interface RollupBundle {
    generate?: (...args: unknown[]) => Promise<unknown>;
    write?: (...args: unknown[]) => Promise<unknown>;
    [key: string]: unknown;
}
declare global {
    var __substrateCarried: (<T>(callback: T) => T) | undefined;
    var __browserRuntimeHeldWork: {
        count: number;
    } | undefined;
    var __browserRuntimeRollupUrl: string | undefined;
    var __browserRuntimeRollupFs: unknown;
    var __browserRuntimeNativeSetTimeout: typeof setTimeout | undefined;
}
/**
 * Load Rollup from CDN
 */
declare function loadRollup(): Promise<unknown>;
export declare const VERSION = "4.63.1";
/**
 * A script is not finished while its build is running. Rollup's work is held
 * so the process loop waits: the graph while `rollup()` builds it, the chunks
 * while `generate` or `write` renders them. A React Router build is Vite's
 * build, which is rollup's, and printed nothing for the half second the engine
 * waited, so the Dockerfile stage moved on with no `build/`.
 */
export declare function rollup(options: RollupBuildOptions): Promise<RollupBundle>;
export declare function watch(options: unknown): Promise<unknown>;
export { loadRollup };
export interface Plugin {
    name: string;
    [key: string]: unknown;
}
export interface PluginContext {
    meta: {
        rollupVersion: string;
    };
    parse: (code: string) => unknown;
    [key: string]: unknown;
}
export declare function parseAst(input: string, options?: {
    allowReturnOutsideFunction?: boolean;
    jsx?: boolean;
}): unknown;
export declare function parseAstAsync(input: string, options?: {
    allowReturnOutsideFunction?: boolean;
    jsx?: boolean;
    signal?: AbortSignal;
}): Promise<unknown>;
export declare function getPackageBase(): string;
declare const _default: {
    VERSION: string;
    rollup: typeof rollup;
    watch: typeof watch;
    loadRollup: typeof loadRollup;
    parseAst: typeof parseAst;
    parseAstAsync: typeof parseAstAsync;
};
export default _default;
//# sourceMappingURL=rollup.d.ts.map