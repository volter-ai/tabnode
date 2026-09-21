// A module with a top-level `await` settles before its importers run, as a
// module graph evaluates in Node: the importer's body waits on it, `import()`
// of it settles when it has, and a program whose entry waits has run when the
// entry has settled. A module that waits on nothing still loads synchronously.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Runtime, VirtualFS } from '../src/index';

const files: Record<string, string> = {
  '/work/package.json': JSON.stringify({ name: 'work', type: 'module' }),
  // The shape @sveltejs/kit's sync/utils.js has: a value awaited at the top,
  // read by a function an importer calls right after importing.
  '/work/utils.js': `const previous = await Promise.resolve(new Map());\nexport function write(key) { previous.set(key, 1); return previous.size; }\nexport const value = await Promise.resolve(41);\n`,
  '/work/middle.js': `import { value, write } from './utils.js';\nexport const next = value + 1;\nexport const wrote = write('x');\n`,
  '/work/main.js': `import { next, wrote } from './middle.js';\nimport { value } from './utils.js';\nexport const seen = [next, wrote, value];\n`,
  '/work/dynamic.js': `export const promised = import('./utils.js').then((m) => m.value);\n`,
  '/work/plain.js': `export const v = 1;\n`,
  '/work/use.cjs': `module.exports = { v: require('./plain.js').v, loaded: require.cache ? true : true };\n`,
  '/work/fails.js': `await Promise.resolve();\nthrow new Error('settled badly');\n`,
  '/work/imports-failure.js': `import './fails.js';\nexport const reached = true;\n`,
  // A dependency evaluates once, and a cycle's caller reaches the hoisted
  // function of the module that is still evaluating it, as before.
  '/work/counted.js': `globalThis.__evaluations = (globalThis.__evaluations ?? 0) + 1;\nexport const n = globalThis.__evaluations;\n`,
  '/work/once.js': `import { n } from './counted.js';\nimport { n as again } from './counted.js';\nexport const seen = [n, again, globalThis.__evaluations];\n`,
  '/work/cycle-b.js': `import { start } from './cycle-a.js';\nexport function f() { return 'f from b'; }\nexport const result = start();\n`,
  '/work/cycle-a.js': `import { f } from './cycle-b.js';\nexport const during = f();\nexport function start() { return during; }\n`,
  // Re-exports of a settling module wait for it too.
  '/work/star.js': `export * from './utils.js';\nexport { value as named } from './utils.js';\nexport * as ns from './utils.js';\n`,
  '/work/uses-star.js': `import { value, named, ns } from './star.js';\nexport const seen = [value, named, ns.value];\n`,
  // A body that throws before any wait throws from the load, synchronously.
  '/work/throws-early.js': `import { v } from './plain.js';\nthrow new Error('early ' + v);\n`,
  '/work/requires-early.cjs': `try { require('./throws-early.js'); module.exports = 'no throw'; } catch (error) { module.exports = error.message; }\n`,
};

function runtime(): Runtime {
  const fs = new VirtualFS();
  for (const [path, text] of Object.entries(files)) {
    fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(path, text);
  }
  return new Runtime(fs, { cwd: '/work' });
}

/** What Node itself answers for the same files. */
function nodeAnswers(entry: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'tla-'));
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path.slice('/work/'.length));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
  }
  const script = `import * as m from './${entry}'; const out = {}; for (const k of Object.keys(m)) out[k] = await m[k]; console.log(JSON.stringify(out));`;
  writeFileSync(join(dir, '__probe.js'), script);
  // A login shell finds node: importing the engine replaces the host's `process`, so its env is not the host's.
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, '__probe.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

describe('top-level await through the loader', () => {
  it('an importer reads what a settling module exports, after it settled, as Node does', async () => {
    const result = await runtime().runFileAsync('/work/main.js');
    expect((result.exports as { seen: unknown }).seen).toEqual([42, 1, 41]);
    expect(nodeAnswers('main.js')).toEqual({ seen: [42, 1, 41] });
  });

  it('a dynamic import of a settling module settles when it has', async () => {
    const result = await runtime().runFileAsync('/work/dynamic.js');
    expect(await (result.exports as { promised: Promise<number> }).promised).toBe(41);
    expect(nodeAnswers('dynamic.js')).toEqual({ promised: 41 });
  });

  it('a module that waits on nothing still loads synchronously for a require', () => {
    const result = runtime().runFile('/work/use.cjs');
    expect((result.exports as { v: number }).v).toBe(1);
  });

  it('a dependency evaluates once, and a cycle still reaches a hoisted function mid-evaluation', async () => {
    const once = await runtime().runFileAsync('/work/once.js');
    expect((once.exports as { seen: unknown }).seen).toEqual([1, 1, 1]);
    expect(nodeAnswers('once.js')).toEqual({ seen: [1, 1, 1] });
    const cycle = await runtime().runFileAsync('/work/cycle-b.js');
    expect((cycle.exports as { result: string }).result).toBe('f from b');
    expect(nodeAnswers('cycle-b.js')).toEqual({ result: 'f from b' });
  });

  it('re-exports of a settling module carry its settled values', async () => {
    const result = await runtime().runFileAsync('/work/uses-star.js');
    expect((result.exports as { seen: unknown }).seen).toEqual([41, 41, 41]);
    expect(nodeAnswers('uses-star.js')).toEqual({ seen: [41, 41, 41] });
  });

  it('a body that throws before any wait throws from the load, synchronously', () => {
    expect(String(runtime().runFile('/work/requires-early.cjs').exports)).toMatch(/^early 1/u);
  });

  it('a body that fails after waiting fails its importer and is forgotten', async () => {
    const rt = runtime();
    await expect(rt.runFileAsync('/work/imports-failure.js')).rejects.toThrow('settled badly');
    expect((rt as unknown as { moduleCache: Record<string, unknown> }).moduleCache['/work/fails.js']).toBeUndefined();
  });
});
