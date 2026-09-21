// `Module.prototype._compile(content, filename)` compiles a body in place on
// a bare Module, as Node does; a loader that transpiles a file hands it the
// result, and Node (>= 22.12) takes ES module source there as well. Next's
// TypeScript config loader compiles its config into `new Module(...)`. The
// lowered module also carries `__esModule`, which Node's namespace does not;
// that mark is the engine's everywhere and is left out of the comparison.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Runtime, VirtualFS } from '../src/index';

const files: Record<string, string> = {
  '/work/package.json': JSON.stringify({ name: 'work' }),
  '/work/x.js': "module.exports = { answer: 41 };\n",
  '/work/main.cjs': [
    "const Module = require('module');",
    "const cjs = new Module('/work/cfg.cjs', module); cjs.filename = '/work/cfg.cjs'; cjs.paths = Module._nodeModulePaths('/work');",
    "cjs._compile(\"const x = require('./x.js'); module.exports = { a: x.answer + 1, file: __filename };\", '/work/cfg.cjs');",
    "const esm = new Module('/work/cfg.mts', module); esm.filename = '/work/cfg.mts'; esm.paths = Module._nodeModulePaths('/work');",
    "esm._compile(\"import x from './x.js'; export const sql = 'db'; export default { b: x.answer };\", '/work/cfg.mts');",
    "module.exports = { a: cjs.exports.a, file: cjs.exports.file, keys: Object.keys(esm.exports).filter((k) => k !== '__esModule').sort(), b: esm.exports.default.b, sql: esm.exports.sql };",
  ].join('\n'),
};

function nodeAnswers(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'compile-'));
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path.slice('/work/'.length));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text.replaceAll('/work/', `${dir}/`));
  }
  writeFileSync(join(dir, 'probe.cjs'), "const r = require('./main.cjs'); r.file = r.file.replace(process.argv[2], '/work'); console.log(JSON.stringify(r));");
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.cjs'))} ${JSON.stringify(dir)}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

describe('Module.prototype._compile', () => {
  it('compiles CommonJS and ES module source in place, as Node does', () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    for (const [path, text] of Object.entries(files)) fs.writeFileSync(path, text);
    const result = new Runtime(fs, { cwd: '/work' }).runFile('/work/main.cjs').exports;
    const expected = nodeAnswers();
    expect(result).toEqual(expected);
    expect(result).toEqual({ a: 42, file: '/work/cfg.cjs', keys: ['default', 'sql'], b: 41, sql: 'db' });
  });
});
