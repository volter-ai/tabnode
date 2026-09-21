// `new X()` where X is a default import constructs the imported class, as
// Node does: the lowered read of a default import is a call, and bare as a
// `new` callee it re-associated to construct the interop helper instead.
import { describe, expect, it } from 'vitest';
import { Runtime, VirtualFS } from '../src/index';

describe('new of a default-imported class', () => {
  it('constructs the class, and every other use of the import still reads live', async () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    fs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
    fs.writeFileSync('/work/slug.js', "export default class Slugger { constructor() { this.count = 0; } slug(value) { this.count += 1; return value.toLowerCase(); } }\n");
    fs.writeFileSync('/work/main.js', "import Slugger from './slug.js';\nconst one = new Slugger();\nconst two = new Slugger;\nexport const seen = [one.slug('A'), two instanceof Slugger, Slugger.name, typeof Slugger];\n");
    const result = await new Runtime(fs, { cwd: '/work' }).runFileAsync('/work/main.js');
    expect((result.exports as { seen: unknown }).seen).toEqual(['a', true, 'Slugger', 'function']);
  });
});
