// A CommonJS body is script code, compiled sloppy as Node compiles one: an
// assignment to a getter-only property is ignored rather than thrown,
// an undeclared assignment makes a global, and `this` at the top is
// `module.exports`. lightningcss's `node/index.js` assigns three names onto
// the wasm namespace it re-exported, and the throw took Tailwind's PostCSS
// plugin with it. An ES module stays strict, as Node keeps one.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Runtime, VirtualFS } from '../src/index';

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'work' }),
  // The shape lightningcss has: a namespace of getters, assigned onto.
  'getters.js': "const ns = {};\nObject.defineProperty(ns, 'toTargets', { enumerable: true, get: () => 'from the getter' });\nmodule.exports = ns;\n",
  'sloppy.js': [
    "const ns = require('./getters.js');",
    "let assigned = 'threw';",
    "try { ns.toTargets = 'assigned'; assigned = 'ignored'; } catch (error) { assigned = 'threw: ' + error.constructor.name; }",
    "let implicit = 'threw';",
    "try { undeclaredGlobalName = 7; implicit = typeof globalThis.undeclaredGlobalName; } catch (error) { implicit = 'threw: ' + error.constructor.name; }",
    "module.exports = { assigned, value: ns.toTargets, implicit, thisIsExports: this === module.exports };",
  ].join('\n'),
  'strict.mjs': [
    "const ns = { get x() { return 1; } };",
    "let assigned = 'ignored';",
    "try { ns.x = 2; } catch (error) { assigned = 'threw: ' + error.constructor.name; }",
    "export const seen = { assigned, thisIsUndefined: typeof undefined_this_probe };",
  ].join('\n'),
  'main.js': "const sloppy = require('./sloppy.js');\nmodule.exports = sloppy;\n",
};

function nodeAnswers(entry: string, read: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'sloppy-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, 'probe.cjs'), `${read}\n`.replace('DIR', JSON.stringify(dir)).replace('ENTRY', JSON.stringify(entry)));
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.cjs'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

function runtime(): Runtime {
  const fs = new VirtualFS();
  fs.mkdirSync('/work', { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(`/work/${name}`, text);
  return new Runtime(fs, { cwd: '/work' });
}

describe('a CommonJS body is compiled as Node compiles one', () => {
  it('ignores an assignment to a getter, makes an implicit global, and has module.exports as `this`', () => {
    const result = runtime().runFile('/work/main.js').exports;
    const expected = nodeAnswers('main.js', "console.log(JSON.stringify(require(require('path').join(DIR, ENTRY))));");
    expect(result).toEqual(expected);
    expect(result).toEqual({ assigned: 'ignored', value: 'from the getter', implicit: 'number', thisIsExports: true });
  });

  it('keeps an ES module strict, as Node keeps one', async () => {
    const result = await runtime().runFileAsync('/work/strict.mjs');
    expect((result.exports as { seen: { assigned: string } }).seen.assigned).toBe('threw: TypeError');
  });
});
