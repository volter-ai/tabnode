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

/** The version a guest reports where its image names none; the vendored compatibility version. */
export const NODE_LTS_VERSION = "24.21.0";

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
  amaro: string;
} {
  // `https.js` calls `assertCrypto()`, which is `!process.versions.openssl`.
  // The engine has crypto (the noble-hashes binding); Node reports openssl
  // whenever it does. A worker compiles `internal/util` against this table
  // before any guest process exists, so the name has to live here.
  // `amaro` is the type stripper a `.ts` file runs through, the release Node
  // v24.21.0 carries; `internal/util` reads it for `assertTypeScript()`.
  return { node, v8: "11.3.244.8", uv: "1.44.2", webcontainer: "1", openssl: "3.0.15", amaro: "1.1.11" };
}

/**
 * `process.release`, in Node's shape (v24.21.0: name, lts, sourceUrl, headersUrl). The two addresses follow the
 * version by Node's fixed scheme. `lts` is the release line's code name, known here for the library's own version
 * only; for a version an image names it is left out rather than guessed.
 */
export function nodeRelease(node: string = NODE_LTS_VERSION): { name: string; lts?: string; sourceUrl: string; headersUrl: string } {
  const base = `https://nodejs.org/download/release/v${node}/node-v${node}`;
  return { name: "node", ...(node === NODE_LTS_VERSION ? { lts: "Krypton" } : {}), sourceUrl: `${base}.tar.gz`, headersUrl: `${base}-headers.tar.gz` };
}

/*
 * Keys of Node's `process.versions` this engine does not answer, because it carries no such thing or another
 * thing in its place, and a version of what is not there would be a lie: ada, ares, brotli, cldr, icu, llhttp (a
 * wasm build whose version this file cannot read), merve, modules and napi (no native addon loads), nbytes,
 * ncrypto, nghttp2, nghttp3, ngtcp2, simdjson, simdutf, sqlite, tz, undici, unicode, uvwasi, zlib (pako answers
 * it), zstd. `acorn` is answered where the process object is made, from the parser's own version.
 */
