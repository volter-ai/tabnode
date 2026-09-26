import { defineConfig } from 'vitest/config';
import { base64Asset } from './scripts/base64-asset-plugin.mjs';

// What the tests need beyond the defaults: `?base64` assets, as the library
// build has, which means brotli-wasm's files go through the transform.
export default defineConfig({ plugins: [base64Asset()], test: { server: { deps: { inline: [/brotli-wasm/] } } } });
