/** A resolve hook's answer, as `internal/modules/esm/hooks.js` validates one. */
export interface ResolveResult {
    url: string;
    format?: string;
    importAttributes?: Record<string, string>;
    shortCircuit?: boolean;
}
/** A load hook's answer. */
export interface LoadResult {
    format?: string;
    source?: string | ArrayBuffer | ArrayBufferView | null;
    shortCircuit?: boolean;
}
type ResolveContext = {
    parentURL?: string;
    importAttributes?: Record<string, string>;
    conditions?: string[];
};
type LoadContext = {
    format?: string;
    importAttributes?: Record<string, string>;
    conditions?: string[];
};
/** What the vendored `internal/modules/customization_hooks.js` exports. */
interface CustomizationHooks {
    resolveHooks: unknown[];
    loadHooks: unknown[];
    registerHooks(hooks: {
        resolve?: unknown;
        load?: unknown;
    }): {
        deregister(): void;
    };
    resolveWithHooks(specifier: string, parentURL: string | undefined, importAttributes: Record<string, string> | undefined, conditions: string[], defaultResolve: (specifier: string, context: ResolveContext) => ResolveResult): ResolveResult;
    loadWithHooks(url: string, format: string | undefined, importAttributes: Record<string, string> | undefined, conditions: string[], defaultLoad: (url: string, context: LoadContext) => LoadResult): LoadResult;
    convertCJSFilenameToURL(filename: string): string;
    convertURLToCJSFilename(url: string): string;
}
/** The conditions a `require` resolves under, as Node's `getCjsConditions()` reports them. */
declare const CJS_CONDITIONS: string[];
/**
 * Node's own `import()` conditions. The engine resolves an import the way it
 * resolves a require, so this is what a hook is told, not a second resolver.
 */
declare const ESM_CONDITIONS: string[];
export declare class RunModuleHooks {
    #private;
    /** The vendored file's own instance, this run's alone. */
    readonly sync: CustomizationHooks;
    /**
     * Which chain has anything in it. The loader asks before it builds
     * anything: a run that registered no hook pays for none, which is the fast
     * path Node keeps in `Module._load` and `loadSource` too.
     */
    get hasSyncResolve(): boolean;
    get hasSyncLoad(): boolean;
    get hasAsyncResolve(): boolean;
    get hasAsyncLoad(): boolean;
    /**
     * `module.register(specifier[, parentURL][, options])`.
     *
     * The argument shuffle is Node's own (`internal/modules/esm/loader.js`): a
     * second argument that is an object and not a URL is the options. The hook
     * module is loaded through the engine's own loader, which is what answers a
     * `data:` URL, a `file:` URL and a bare specifier alike.
     */
    register(specifier: unknown, parentURL: unknown, options: {
        parentURL?: unknown;
        data?: unknown;
        transferList?: unknown;
    } | undefined, load: (specifier: string, from: string) => unknown): void;
    /**
     * `Hooks.addCustomLoader`: the three names a hook module may export, each
     * onto its chain, and `initialize` called with the data.
     */
    addLoader(url: string, exports: Record<string, unknown> | undefined, data: unknown): void;
    /** Every `initialize` still settling, awaited before the chain serves anything. */
    ready(): Promise<void>;
    /**
     * The resolve chain of `module.register`, awaited. `defaultResolve` is the
     * engine's own resolution, the bottom of the chain.
     */
    resolve(specifier: string, parentURL: string | undefined, importAttributes: Record<string, string> | undefined, defaultResolve: (specifier: string, context: ResolveContext) => ResolveResult | Promise<ResolveResult>): Promise<ResolveResult>;
    /** The load chain of `module.register`, awaited. */
    load(url: string, format: string | undefined, importAttributes: Record<string, string> | undefined, defaultLoad: (url: string, context: LoadContext) => LoadResult | Promise<LoadResult>): Promise<LoadResult>;
}
export { CJS_CONDITIONS, ESM_CONDITIONS };
export type { ResolveContext, LoadContext };
//# sourceMappingURL=module-hooks.d.ts.map