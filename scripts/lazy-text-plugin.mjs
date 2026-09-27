// `import text from './file?lazytext'`: a function that returns the file's
// text. A string constant at a module's top level is made when the bundle
// loads, a second copy of text the bundle's source already holds, in every
// realm; inside a function it is made only when the function is called. The
// engine carries Node's library this way, each file made a string when it is
// first required.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function lazyText() {
  return {
    name: 'lazy-text',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('?lazytext')) return null;
      const file = source.slice(0, -'?lazytext'.length);
      return `${importer && !file.startsWith('/') ? resolve(dirname(importer.split('?')[0]), file) : file}?lazytext`;
    },
    load(id) {
      if (!id.endsWith('?lazytext')) return null;
      return `export default function text() { return ${JSON.stringify(readFileSync(id.slice(0, -'?lazytext'.length), 'utf8'))}; }`;
    },
  };
}
