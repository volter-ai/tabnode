// A program run through its `.bin` link runs at the file's real path, as Node
// runs one: Node resolves an entry's symlinks before loading it (unless
// --preserve-symlinks), so the file's relative imports and its package's
// `type` are read from where the file is, not from where the link is.
import { describe, expect, it } from 'vitest';
import { Runtime, VirtualFS } from '../src/index';

function tree(): VirtualFS {
  const fs = new VirtualFS();
  fs.mkdirSync('/work/node_modules/pkg/bin', { recursive: true });
  fs.mkdirSync('/work/node_modules/.bin', { recursive: true });
  fs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
  fs.writeFileSync('/work/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', bin: { pkg: 'bin/run.js' } }));
  fs.writeFileSync('/work/node_modules/pkg/bin/run.js', "#!/usr/bin/env node\nimport { hello } from '../lib.js';\nexport const said = hello();\n");
  fs.writeFileSync('/work/node_modules/pkg/lib.js', "export const hello = () => 'hello from esm';\n");
  fs.symlinkSync('../pkg/bin/run.js', '/work/node_modules/.bin/pkg');
  return fs;
}

describe('a program run through its .bin link', () => {
  it('runs at its real path: relative imports resolve from the file, not the link', async () => {
    const direct = await new Runtime(tree(), { cwd: '/work' }).runFileAsync('/work/node_modules/pkg/bin/run.js');
    expect((direct.exports as { said: string }).said).toBe('hello from esm');
    const linked = await new Runtime(tree(), { cwd: '/work' }).runFileAsync('/work/node_modules/.bin/pkg');
    expect((linked.exports as { said: string }).said).toBe('hello from esm');
    expect(linked.module.filename).toBe('/work/node_modules/pkg/bin/run.js');
  });
});
