/**
 * The published bundle must load in a consumer's Node. A module-scope read of
 * `crypto.constants` from the constants table sat in a cycle with the crypto
 * shim, and a consumer's bundler that evaluated the table first threw
 * `Cannot access 'constants$N' before initialization`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.mjs');

describe('the published bundle in a child Node', () => {
  it('loads and a guest can require buffer, fs, net, http, constants', () => {
    expect(existsSync(dist)).toBe(true);
    const program = `import(${JSON.stringify(dist)}).then((m) => {
      const tree = new m.VirtualFS();
      tree.mkdirSync('/g', { recursive: true });
      const runtime = new m.Runtime(tree, { cwd: '/g' });
      const seen = runtime.execute("module.exports = { buffer: typeof require('buffer').Buffer, fs: typeof require('fs').readFileSync, net: typeof require('net').createServer, http: typeof require('http').createServer, constants: typeof require('constants').O_RDONLY };", '/g/main.cjs').exports;
      const missing = ['buffer', 'fs', 'net', 'http', 'constants'].filter((name) => seen[name] !== 'function' && seen[name] !== 'number');
      if (missing.length) throw new Error('missing ' + missing.join(','));
      console.log('ok');
    })`;
    const run = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(run.stdout).toMatch(/ok/);
  });
});
