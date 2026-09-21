/**
 * What this engine reports as its Node, in one place.
 *
 * Two readers need the same answer and neither may import the other: a guest's
 * `process`, built in `src/shims/process.ts` per run, and the process a
 * vendored file is handed where the realm has none, built in
 * `src/node-lib/load.ts` (`shims/process.ts` imports `node-lib/events-module`,
 * so the loader cannot import it back). This file imports nothing, so both
 * can.
 */
/** The version a guest reports where its image names none; the current LTS. */
export declare const NODE_LTS_VERSION = "22.12.0";
/**
 * `process.versions`, as this engine answers it. `webcontainer` says what this
 * runtime is, Node in a browser tab: a program that keeps a wasm build of its
 * native binding for such runtimes, Next's compiler among them, reads that
 * name and reaches for the wasm build before trying to load a binary no tab
 * can run.
 */
export declare function nodeVersions(node?: string): {
    node: string;
    v8: string;
    uv: string;
    webcontainer: string;
    openssl: string;
};
//# sourceMappingURL=node-versions.d.ts.map