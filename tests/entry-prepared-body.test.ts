// A file run as the entry takes its prepared body as a required file does,
// and keeps one it prepares under the same name, so an image's dry run
// carries it: the VS Code server's entry was parsed afresh at every open.
import { describe, expect, it } from 'vitest';
import { PREPARED_MODULES_DIR, Runtime, VirtualFS, preparedModuleKey } from '../src/index';

const ENTRY = "#!/usr/bin/env node\nimport { hello } from './lib.js';\nexport const said = hello();\n";

function tree(): VirtualFS {
  const fs = new VirtualFS();
  fs.mkdirSync('/work', { recursive: true });
  fs.mkdirSync(PREPARED_MODULES_DIR, { recursive: true });
  fs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
  fs.writeFileSync('/work/run.js', ENTRY);
  fs.writeFileSync('/work/lib.js', "export const hello = () => 'hello';\n");
  return fs;
}

describe('an entry file and its prepared body', () => {
  it('prepares the entry once and keeps the body under its key', async () => {
    const fs = tree();
    const ran = await new Runtime(fs, { cwd: '/work' }).runFileAsync('/work/run.js');
    expect((ran.exports as { said: string }).said).toBe('hello');
    const key = preparedModuleKey(ENTRY, '/work/run.js')!;
    expect(fs.existsSync(`${PREPARED_MODULES_DIR}/${key}`)).toBe(true);
  });

  it('runs the body the store holds for the entry, not the entry parsed again', async () => {
    const fs = tree();
    const key = preparedModuleKey(ENTRY, '/work/run.js')!;
    fs.writeFileSync(`${PREPARED_MODULES_DIR}/${key}`, "exports.said = 'from the prepared body';");
    const ran = await new Runtime(fs, { cwd: '/work' }).runFileAsync('/work/run.js');
    expect((ran.exports as { said: string }).said).toBe('from the prepared body');
  });

  it('prepares nothing for source handed to execute or run with `node -e`', () => {
    const fs = tree();
    const runtime = new Runtime(fs, { cwd: '/work' });
    runtime.evaluate("module.exports = 1 + 1;", '/work/[eval]');
    new Runtime(fs, { cwd: '/work' }).execute("module.exports = 'a snippet';", '/work/snippet.js');
    expect(fs.readdirSync(PREPARED_MODULES_DIR)).toEqual([]);
  });
});
