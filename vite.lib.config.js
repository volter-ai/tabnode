import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { build as esbuild } from 'esbuild';
import wasm from 'vite-plugin-wasm';

/**
 * Node's own files' bodies (src/node-lib/bodies.ts) made here, once, by the same scopedBody a process would run, and
 * carried in that module's place with each file's own text: no process's realm parses Node's library to rewrite it,
 * and the realm whose process is `node` compiles the text as Node's BuiltinLoader does (ADR-0018 §7). The build
 * refuses a vendored set that is not closed: an id its files can require that is neither vendored nor answered.
 */
function nodeLibBodies() {
  const module = resolve(__dirname, 'src/node-lib/bodies.ts');
  return {
    name: 'node-lib-bodies',
    async load(id) {
      if (id !== module) return null;
      const maker = await esbuild({
        stdin: {
          contents: `import { NODE_LIB_PARAMETERS } from './src/guest-scope';
import { scopedBody } from './src/node-lib/scoped-body';
import { NODE_LIB_SOURCES } from './src/node-lib/sources';
import { unansweredBuiltins } from './src/node-lib/builtin-closure';
import { ENGINE_BUILTIN_IDS } from './src/node-lib/engine-builtin-ids';
export const unanswered = unansweredBuiltins(NODE_LIB_SOURCES, ENGINE_BUILTIN_IDS);
export default Object.fromEntries(Object.entries(NODE_LIB_SOURCES).map(([name, source]) => [name, { ...scopedBody(NODE_LIB_PARAMETERS, source, \`node:\${name}\`), source }]));`,
          resolveDir: __dirname,
          loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        // A vendored file is its text, as Vite's `?raw` reads it.
        plugins: [{
          name: 'raw',
          setup(build) {
            build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)), namespace: 'raw' }));
            build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
          },
        }],
      });
      const { default: bodies, unanswered } = await import(`data:text/javascript;base64,${Buffer.from(maker.outputFiles[0].text).toString('base64')}`);
      // The vendored set is closed (src/node-lib/builtin-closure.ts): every id its files can require is a vendored
      // file or one the engine answers (src/node-lib/engine-builtin-ids.ts), as Node's own builtin set is.
      if (unanswered.length > 0) {
        throw new Error(`node-lib: ids Node's vendored files require that nothing answers: ${unanswered.map(({ id, from }) => `${id} (from ${from})`).join(', ')}`);
      }
      return `const BODIES = ${JSON.stringify(bodies)};
export function nodeLibBody(name) { const made = BODIES[name]; return made && { body: made.body, scoped: made.scoped }; }
export function nodeLibSource(name) { return BODIES[name]?.source; }
export function nodeLibNames() { return Object.keys(BODIES); }
export function isNodeLibFile(name) { return BODIES[name] !== undefined; }
`;
    },
  };
}


export default defineConfig({
  plugins: [
    wasm(),
    nodeLibBodies(),
  ],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // A bundled dependency's `node:zlib` (just-bash's) is Node's own zlib of the realm's library graph.
      'node:zlib': resolve(__dirname, 'src/node-lib/zlib-module.ts'),
      'zlib': resolve(__dirname, 'src/node-lib/zlib-module.ts'),
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
        // A thread's side of an addon's imports, which the substrate's thread worker imports alone (ADR-0011 §4).
        'native-thread': resolve(__dirname, 'src/native-thread.ts'),
      },
      name: 'Tabnode',
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      external: [
        'pako',
        'comlink',
        'just-bash',
        'resolve.exports',
        // Node.js built-ins for vite-plugin
        'fs',
        'path',
        'url',
        'vite',
      ],
      output: {
        globals: {
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
