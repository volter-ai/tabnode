export declare function primordialsOf(): Record<string, unknown>;
export declare function nodeLibProcessOf(): Record<string, unknown>;
/**
 * A vendored file, evaluated as Node's `BuiltinModule.compileForInternalLoader`
 * evaluates one and cached under its name. The record is cached before the
 * body runs, as Node's is, so a cycle between two vendored files sees a
 * partly-filled `exports` rather than looping.
 */
export declare function loadNodeLib(name: string): unknown;
export declare function esmNamespaceOf(mod: unknown): Record<string, unknown>;
/** Node's `module.syncBuiltinESMExports`: newly assigned CJS keys appear on the namespace. */
export declare function syncBuiltinESMExports(): void;
export declare function loadNodeLibInstance(name: string): unknown;
export declare function loadNodeLibFor(owner: object, name: string): unknown;
/**
 * What a hand-bound internal, a binding or `./lazy.ts` calls to reach a
 * vendored file.
 *
 * A function DECLARATION, not a `const`: a name that stands for a vendored
 * class is read while the bundle is still evaluating -- `class Foo extends
 * EventEmitter` runs `getPrototypeOf` on the proxy at the moment the class is
 * defined, which is module-evaluation time, before this file's own bindings
 * are initialized. A hoisted function is already callable then; a `const` is
 * in its temporal dead zone and the engine failed to load at all.
 */
export declare function nodeLibInternalRequire(specifier: string): unknown;
//# sourceMappingURL=load.d.ts.map