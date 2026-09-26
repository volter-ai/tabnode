import { defineConfig } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';
import { base64Asset } from './scripts/base64-asset-plugin.mjs';


export default defineConfig({
  plugins: [
    base64Asset(),
    wasm(),
    {
      name: 'browser-shims',
      enforce: 'pre',
      resolveId(source) {
        if (source === 'node:zlib' || source === 'zlib') {
          return resolve(__dirname, 'src/shims/zlib.ts');
        }
        if (source === 'brotli-wasm/pkg.web/brotli_wasm.js') {
          return resolve(__dirname, 'node_modules/brotli-wasm/pkg.web/brotli_wasm.js');
        }
        if (source === 'brotli-wasm/pkg.web/brotli_wasm_bg.wasm?url') {
          return {
            id: resolve(__dirname, 'node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm') + '?url',
            external: false,
          };
        }
        return null;
      },
    },
  ],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      'node:zlib': resolve(__dirname, 'src/shims/zlib.ts'),
      'zlib': resolve(__dirname, 'src/shims/zlib.ts'),
      'buffer': 'buffer',
      'process': 'process/browser',
    },
  },
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
    ],
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'vite-plugin': resolve(__dirname, 'src/vite-plugin.ts'),
        // The page's side of the service worker alone, with none of Node's
        // library: a page whose engine runs in a worker imports this.
        'port-bridge': resolve(__dirname, 'src/port-bridge.ts'),
      },
      name: 'Tabnode',
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      external: [
        'brotli-wasm',
        'pako',
        'comlink',
        'just-bash',
        'resolve.exports',
        'brotli',
        // Node.js built-ins for vite-plugin
        'fs',
        'path',
        'url',
        'vite',
      ],
      output: {
        globals: {
          'brotli-wasm': 'brotliWasm',
          'pako': 'pako',
          'comlink': 'Comlink',
          'just-bash': 'justBash',
          'resolve.exports': 'resolveExports',
        },
      },
    },
    sourcemap: false,
    minify: false,
  },
  assetsInclude: ['**/*.wasm'],
});
