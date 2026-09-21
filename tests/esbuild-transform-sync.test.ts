// `esbuild.transformSync` answers before it returns, as it does in Node.
// import-from-string, under bundle-import and vite-plugin-fake-server,
// transforms the bundle it is about to import that way; vue-pure-admin's mock
// API died on the shim's refusal ("transformSync is not available in browser").
// The shim answers it as Node's own esbuild-wasm does: esbuild on another
// thread, the caller blocked on shared memory until the answer is written.
// The far side here is a worker loading a stand-in module that re-exports
// native esbuild (esbuild-wasm's browser build cannot load in Node); what is
// measured is the channel and the call's shape against Node's own answer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Runtime, VirtualFS } from '../src/index';
import { setModuleURL, stop, transformSync, useHost } from '../src/shims/esbuild';

const esbuildMain = createRequire(import.meta.url).resolve('esbuild');
const big = 'x'.repeat(1_500_000);
const program = (esbuild: string) => [
  `const { transformSync } = require(${JSON.stringify(esbuild)});`,
  "const out = transformSync('export const answer = __u; export default (x: number) => x + 1', { format: 'esm', loader: 'ts', define: { __u: JSON.stringify('file:///work/x.js') } });",
  "let failure = null;",
  "try { transformSync('let = ;', { loader: 'js' }); } catch (error) { failure = { message: error.message.split('\\n')[0], errors: error.errors.length, text: error.errors[0].text }; }",
  `const wide = transformSync('export const big = "${big}";', { format: 'esm' });`,
  "module.exports = { code: out.code, warnings: out.warnings.length, failure, wide: wide.code.length, wideTail: wide.code.slice(-24) };",
].join('\n');

let dir: string;
const hadWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'transform-sync-'));
  // The far side of the channel: esbuild-wasm's browser build cannot load in Node, so native esbuild stands in, its `initialize` a no-op.
  writeFileSync(join(dir, 'esbuild-far.mjs'), `export * from ${JSON.stringify(pathToFileURL(esbuildMain).href)};\nexport async function initialize() {}\n`);
  setModuleURL(pathToFileURL(join(dir, 'esbuild-far.mjs')).href);
  Object.defineProperty(globalThis, 'Worker', { value: Worker, configurable: true, writable: true });
});
afterAll(async () => {
  await stop();
  if (hadWorker) Object.defineProperty(globalThis, 'Worker', hadWorker); else delete (globalThis as { Worker?: unknown }).Worker;
  rmSync(dir, { recursive: true, force: true });
});

function nodeAnswers(): unknown {
  writeFileSync(join(dir, 'main.cjs'), program(esbuildMain));
  writeFileSync(join(dir, 'probe.cjs'), "console.log(JSON.stringify(require('./main.cjs')));");
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.cjs'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

describe('esbuild.transformSync', () => {
  it('answers before returning, with what Node answers, an error as Node throws it, and an answer wider than the shared window', async () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/work', { recursive: true });
    fs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    fs.writeFileSync('/work/main.js', program('esbuild'));
    const result = await new Runtime(fs, { cwd: '/work' }).runFileAsync('/work/main.js');
    const seen = JSON.parse(JSON.stringify(result.exports)) as Record<string, unknown>;
    expect(seen).toEqual(nodeAnswers());
    expect(seen.code).toBe('const answer = "file:///work/x.js";\nvar stdin_default = (x) => x + 1;\nexport {\n  answer,\n  stdin_default as default\n};\n');
    expect(seen.failure).toEqual({ message: 'Transform failed with 1 error:', errors: 1, text: 'Unexpected ";"' });
    expect(seen.wide).toBeGreaterThan(1 << 20);
  }, 60_000);

  it('answers again on a thread started when the host was installed, before any call', async () => {
    await stop();
    // Installing a host starts the thread while the realm's loop still runs;
    // a worker created inside a blocked call never starts in a browser realm.
    useHost({ build: () => Promise.reject(new Error('unused')), transform: () => Promise.reject(new Error('unused')) });
    try {
      // The thread starts on its own; the call finds it running (or waits, bounded).
      await new Promise((resolve) => setTimeout(resolve, 200));
      const out = transformSync('let a: number = 1', { loader: 'ts' } as never);
      expect(out.code).toBe('let a = 1;\n');
    } finally {
      useHost(null);
    }
  }, 30_000);

  it('throws within seconds, naming the reason, when the thread cannot start', async () => {
    await stop();
    // A worker that never runs its script: what a worker created inside a
    // blocked call is to a browser realm.
    const never = class { postMessage(): void {} terminate(): void {} onerror: unknown };
    Object.defineProperty(globalThis, 'Worker', { value: never, configurable: true, writable: true });
    const started = Date.now();
    try {
      expect(() => transformSync('let a = 1')).toThrow(/did not start within 5 s/u);
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      Object.defineProperty(globalThis, 'Worker', { value: Worker, configurable: true, writable: true });
    }
    // The next call starts afresh on a thread that runs.
    expect(transformSync('let b = 2').code).toBe('let b = 2;\n');
  }, 30_000);
});
