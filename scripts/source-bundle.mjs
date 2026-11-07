// The engine bundled from its own source, for the scripts that read it rather than a published build (RELEASING.md,
// "Build the library"): native-probe.mjs, which produces the release's surface, and crypto-ed25519-volume.mjs. One
// owner of how the source is bundled: esbuild, an ESM module for Node, Vite's `?raw` imports read as text (a relative
// specifier is a file beside its importer, a bare one a package's file as the package exports it), a dependency's
// compiled `.node` left as the require it was, and a `require` for the bundle's CommonJS dependencies.
//   const file = await bundleSource('native-probe', 'registries.mjs', { stdin: …, loader: … });
import * as fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const raw = { name: 'raw', setup(b) {
  b.onResolve({ filter: /\?raw$/ }, (a) => {
    const specifier = a.path.replace(/\?raw$/, '');
    const path = /^\.{0,2}\//.test(specifier) ? resolve(a.resolveDir, specifier) : createRequire(resolve(a.resolveDir, 'importer.js')).resolve(specifier);
    return { path, namespace: 'raw' };
  });
  b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8'), loader: 'text' }));
} };

/** Bundles the caller's entry (`entryPoints` or `stdin`, with its own `loader` and `logLevel`) into a new temporary file, and answers its path. */
export async function bundleSource(folder, file, entry) {
  const { build } = await import(pathToFileURL(resolve(root, 'node_modules/esbuild/lib/main.js')).href);
  const outfile = resolve(fs.mkdtempSync(resolve(tmpdir(), `${folder}-`)), file);
  await build({
    ...entry,
    bundle: true, format: 'esm', platform: 'node', outfile, plugins: [raw],
    external: ['*.node'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return outfile;
}
