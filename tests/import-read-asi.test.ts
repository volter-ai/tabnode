// A reference to an imported binding is lowered to a read of the module's
// namespace. The read stood in parentheses, and after a line the source ended
// without a semicolon a `(` continues that line: import-meta-resolve's
// `const {parentURL} = context` followed by `assert(...)` became
// `context(...)` and died "context is not a function" under
// vite-plugin-fake-server. Node runs the source as written: the statement
// ends where the line does, and a `new` of an imported class constructs it.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Runtime, VirtualFS } from '../src/index';

const files: Record<string, string> = {
  'thing.mjs': "export default class Thing { constructor(value) { this.value = value } }\nexport const helper = { Klass: Thing }\nexport let count = 0\nexport function bump() { count += 1 }\n",
  'main.mjs': [
    "import assert from 'node:assert'",
    "import Thing, { helper, count, bump } from './thing.mjs'",
    "const context = 1",
    "assert(context === 1, 'kept')",
    "const made = new Thing(2)",
    "const viaMember = new helper.Klass(3)",
    "bump()",
    "const later = count",
    "export const seen = [made.value, viaMember.value, typeof assert, later, made instanceof Thing]",
    "",
  ].join('\n'),
};

function nodeAnswers(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'import-read-'));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  writeFileSync(join(dir, 'probe.mjs'), "import { seen } from './main.mjs'; console.log(JSON.stringify(seen));");
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.mjs'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

describe('an imported binding read where the source has no semicolons', () => {
  it('ends the statement where the line ends and constructs an imported class, as Node does', async () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    fs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
    for (const [name, source] of Object.entries(files)) fs.writeFileSync(`/work/${name}`, source);
    const result = await new Runtime(fs, { cwd: '/work' }).runFileAsync('/work/main.mjs');
    const seen = (result.exports as { seen: unknown[] }).seen;
    expect(seen).toEqual(nodeAnswers());
    expect(seen).toEqual([2, 3, 'function', 1, true]);
  });
});
