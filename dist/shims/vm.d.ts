/**
 * vm shim - Basic VM functionality using eval
 *
 * `vm.runInNewContext(code, sandbox)` runs the code with the sandbox as its
 * global: what the code writes on `globalThis` lands on the sandbox, and a name
 * the sandbox lacks reads from the host's global. This passed the sandbox's
 * keys as parameters, so `globalThis.x = ...` wrote to the real global and the
 * caller read nothing back. Next's server evaluates each client-reference
 * manifest exactly that way and read an empty object.
 */
export declare class Script {
    private code;
    constructor(code: string, _options?: object);
    runInThisContext(_options?: object): unknown;
    runInNewContext(contextObject?: object, _options?: object): unknown;
    runInContext(_context: object, _options?: object): unknown;
    createCachedData(): Buffer;
}
export declare function createContext(contextObject?: object, _options?: object): object;
export declare function isContext(_sandbox: object): boolean;
export declare function runInThisContext(code: string, _options?: object): unknown;
export declare function runInNewContext(code: string, contextObject?: object, _options?: object): unknown;
export declare function runInContext(code: string, context: object, _options?: object): unknown;
export declare function compileFunction(code: string, params?: string[], _options?: object): Function;
export declare class Module {
    constructor(_code: string, _options?: object);
    link(_linker: unknown): Promise<void>;
    evaluate(_options?: object): Promise<unknown>;
    get status(): string;
    get identifier(): string;
    get context(): object;
    get namespace(): object;
}
export declare class SourceTextModule extends Module {
}
export declare class SyntheticModule extends Module {
    setExport(_name: string, _value: unknown): void;
}
declare const _default: {
    Script: typeof Script;
    createContext: typeof createContext;
    isContext: typeof isContext;
    runInThisContext: typeof runInThisContext;
    runInNewContext: typeof runInNewContext;
    runInContext: typeof runInContext;
    compileFunction: typeof compileFunction;
    Module: typeof Module;
    SourceTextModule: typeof SourceTextModule;
    SyntheticModule: typeof SyntheticModule;
};
export default _default;
//# sourceMappingURL=vm.d.ts.map