// `import()` of a `data:` URL whose media type is JavaScript evaluates its
// payload as a module, as Node has since 12.10: import-from-string, under
// bundle-import and vite-plugin-fake-server, compiles a file in memory and
// imports the result that way.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Runtime, VirtualFS } from '../src/index';

const program = [
  "const plain = await import('data:text/javascript,export default 42; export const kind = \"plain\";');",
  "const encoded = await import('data:text/javascript;base64,' + Buffer.from('export const meta = import.meta.url.slice(0, 16); export default 7').toString('base64'));",
  "let refused = 'none';",
  "try { await import('data:text/plain,hello'); } catch (error) { refused = error.code; }",
  "export const seen = [plain.default, plain.kind, encoded.default, encoded.meta, refused];",
].join('\n');

function nodeAnswers(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'data-url-'));
  writeFileSync(join(dir, 'main.mjs'), program);
  writeFileSync(join(dir, 'probe.mjs'), "import { seen } from './main.mjs'; console.log(JSON.stringify(seen));");
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.mjs'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

describe('import() of a data: URL', () => {
  it('evaluates a JavaScript payload as a module and refuses another type, as Node does', async () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    fs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
    fs.writeFileSync('/work/main.js', program);
    const result = await new Runtime(fs, { cwd: '/work' }).runFileAsync('/work/main.js');
    const seen = (result.exports as { seen: unknown[] }).seen;
    const expected = nodeAnswers() as unknown[];
    expect(seen).toEqual(expected);
    expect(seen).toEqual([42, 'plain', 7, 'data:text/javasc', 'ERR_UNKNOWN_MODULE_FORMAT']);
  });
});
