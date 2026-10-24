/**
 * Where the bundlers' own wasm builds are fetched from when a host names no
 * other place: the versions the engine's `esbuild` and `rollup` doors are
 * written against.
 */

// esbuild-wasm 0.20.0 is built with Go 1.20.12, whose wasm `IndexByte`
// sign-extends the address `memchr` answers (golang/go#65571, fixed in Go 1.23
// and backported to 1.21.13 and 1.22.6): once esbuild's heap passes 2 GiB of
// linear memory, a search that finds its byte in a buffer above that line
// answers about -4294967295, and esbuild panics slicing with it
// (`slice bounds out of range [:-4294967295]` in the printer, and outside the
// linker's recover in `validatePathTemplate`, which ends the service). A long
// shared instance gets there: a Next application's host pack build did at 2.0
// GiB on 0.20.0, and ran to the end on 0.28.2.
export const ESBUILD_WASM_VERSION = '0.28.2';
export const ROLLUP_BROWSER_VERSION = '4.63.1';

export const ESBUILD_WASM_ESM_CDN = `https://esm.sh/esbuild-wasm@${ESBUILD_WASM_VERSION}`;
export const ESBUILD_WASM_BINARY_CDN = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esbuild.wasm`;
export const ESBUILD_WASM_BROWSER_CDN = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esm/browser.min.js`;
export const ROLLUP_BROWSER_CDN = `https://esm.sh/@rollup/browser@${ROLLUP_BROWSER_VERSION}`;
