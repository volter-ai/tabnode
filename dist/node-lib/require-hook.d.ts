/**
 * The one way a binding or a hand-bound internal reaches a vendored file.
 *
 * It exists as a file of its own, importing nothing, because the loader
 * imports the binding and the internals to build its tables: a binding that
 * imported the loader back put the two in a cycle, and which of them a bundler
 * evaluates first is then its own decision. The loader installs itself here
 * when it loads; everything below it asks through this and is a leaf.
 */
export type LibRequire = (specifier: string) => unknown;
/** The loader takes this door once, at the bottom of its own body. */
export declare function setLibRequire(lib: LibRequire): void;
/** A vendored Node file, by the name Node's own `require` calls it. */
export declare function libRequire(specifier: string): unknown;
//# sourceMappingURL=require-hook.d.ts.map