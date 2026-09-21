/**
 * Node's `validatePath`: a path is a string or a `Uint8Array`, and it carries
 * no NUL. `fork('a\u0000b')` is a program's own bug and Node says so rather
 * than opening a file whose name stops at the NUL.
 */
declare function validatePath(path: unknown, propName?: string): void;
/**
 * Node's `getValidatedPath`: a `file:` URL is the path it names, and anything
 * else is validated as it stands. `fork(new URL('file:///app/child.js'))` is
 * an ordinary call and `test-child-process-fork-url.mjs` makes it.
 */
declare function getValidatedPath(fileURLOrPath: unknown, propName?: string): string | Uint8Array;
export declare const internalFsUtils: {
    getValidatedPath: typeof getValidatedPath;
    validatePath: typeof validatePath;
};
/**
 * `internal/dgram`: the one name `internal/child_process.js` reads from it,
 * the symbol a `dgram.Socket` keeps its handle under. The engine's `dgram` is
 * a stub with no handle, so nothing is ever sent this way; the symbol exists
 * because the conversion table names it while it is built.
 */
export declare const internalDgram: {
    kStateSymbol: symbol;
};
export {};
//# sourceMappingURL=child-process.d.ts.map