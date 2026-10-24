import { defineConfig } from 'vite';
import { resolve } from 'path';
import wasm from 'vite-plugin-wasm';


export default defineConfig({
  plugins: [
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
        // A run's fd 0 as a shared ring: the producer a page runs and the
        // layout, with nothing else of the engine. The engine's own reader
        // imports this same module.
        'stdin-ring': resolve(__dirname, 'src/stdin-ring.ts'),
        'prepared-key': resolve(__dirname, 'src/prepared-key.ts'),
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
    // Every CommonJS dependency is wrapped the one way, in a function run at its first `require`, as Node runs
    // it. The plugin's default here (Vite 5: `strictRequires: "auto"`) wraps a module only where it finds it in a
    // require cycle or required conditionally, and what it finds depends on the order modules finish loading,
    // which is not fixed: two packs of one commit differed in one dependency's wrap (`var functionApply = …`
    // hoisted in one, `requireFunctionApply()` in the other), so in the worker bundle's content-hashed name, so in
    // `index.mjs`, whose digest is the engine's ABI label. The worker's own bundle is built with these options too.
    commonjsOptions: { strictRequires: true },
    sourcemap: false,
    minify: false,
  },
  assetsInclude: ['**/*.wasm'],
});
