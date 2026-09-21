/**
 * Where the bundlers' own wasm builds are fetched from when a host names no
 * other place: the versions the engine's `esbuild` and `rollup` doors are
 * written against.
 */

export const ESBUILD_WASM_VERSION = '0.20.0';
export const ROLLUP_BROWSER_VERSION = '4.63.1';

export const ESBUILD_WASM_ESM_CDN = `https://esm.sh/esbuild-wasm@${ESBUILD_WASM_VERSION}`;
export const ESBUILD_WASM_BINARY_CDN = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esbuild.wasm`;
export const ESBUILD_WASM_BROWSER_CDN = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esm/browser.min.js`;
export const ROLLUP_BROWSER_CDN = `https://esm.sh/@rollup/browser@${ROLLUP_BROWSER_VERSION}`;
