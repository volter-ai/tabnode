// `import text from './file?base64'`: a function returning the file's bytes as a base64 string
// module, for bytes an engine realm must hold without fetching them (its
// network is closed): the Brotli decoder's wasm.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';


export function base64Asset() {
  return {
    name: 'base64-asset',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('?base64')) return null;
      const file = source.slice(0, -'?base64'.length);
      return `${importer && !file.startsWith('/') ? resolve(dirname(importer.split('?')[0]), file) : file}?base64`;
    },
    load(id) {
      if (!id.endsWith('?base64')) return null;
      // A function, not a constant: the text is made only when it is asked for (see lazy-text-plugin.mjs).
      return `export default function base64() { return ${JSON.stringify(readFileSync(id.slice(0, -'?base64'.length)).toString('base64'))}; }`;
    },
  };
}
