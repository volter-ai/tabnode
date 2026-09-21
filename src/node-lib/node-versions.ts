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
export const NODE_LTS_VERSION = "22.12.0";

/**
 * `process.versions`, as this engine answers it. `webcontainer` says what this
 * runtime is, Node in a browser tab: a program that keeps a wasm build of its
 * native binding for such runtimes, Next's compiler among them, reads that
 * name and reaches for the wasm build before trying to load a binary no tab
 * can run.
 */
export function nodeVersions(node: string = NODE_LTS_VERSION): {
  node: string;
  v8: string;
  uv: string;
  webcontainer: string;
  openssl: string;
} {
  // `https.js` calls `assertCrypto()`, which is `!process.versions.openssl`.
  // The engine has crypto (the noble-hashes binding); Node reports openssl
  // whenever it does. A worker compiles `internal/util` against this table
  // before any guest process exists, so the name has to live here.
  return { node, v8: "11.3.244.8", uv: "1.44.2", webcontainer: "1", openssl: "3.0.15" };
}
