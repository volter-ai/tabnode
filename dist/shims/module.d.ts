/**
 * Node.js module shim
 * Provides basic module system functionality
 */
export declare function createRequire(filename: string): (id: string) => unknown;
export declare const builtinModules: string[];
export declare function isBuiltin(moduleName: string): boolean;
export declare const _cache: Record<string, unknown>;
export declare const _extensions: Record<string, unknown>;
export declare const _pathCache: Record<string, string>;
export declare function syncBuiltinESMExports(): void;
export declare const Module: {
    createRequire: typeof createRequire;
    builtinModules: string[];
    isBuiltin: typeof isBuiltin;
    _cache: Record<string, unknown>;
    _extensions: Record<string, unknown>;
    _pathCache: Record<string, string>;
    syncBuiltinESMExports: typeof syncBuiltinESMExports;
};
export default Module;
//# sourceMappingURL=module.d.ts.map