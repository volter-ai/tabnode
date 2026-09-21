// A node program ends when its loop has nothing left, as Node's does: a
// program that printed and then set a timer, or reached a timer through a
// promise chain after its first line, runs to the end of that work. The
// runner ended a printed program one tick after its synchronous part when
// nothing was held at that instant; vue-pure-admin's mock loader,
// `import('bundle-import').then(...)` after one printed line, was cut there
// with exit 0 before its build began.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { VirtualFS, createContainer } from '../src/index';

const programs: Record<string, string> = {
  'printed-timer.mjs': "console.log('a');\nsetTimeout(() => console.log('b'), 300);\n",
  'printed-chain.mjs': "console.log('a');\nPromise.resolve().then(() => new Promise((r) => setTimeout(r, 200))).then(() => console.log('c'));\n",
  'printed-done.mjs': "console.log('a');\nPromise.resolve().then(() => console.log('d'));\n",
};

interface Seen { stdout: string; stderr: string; exitCode: number }
function nodeAnswers(dir: string, name: string): Seen {
  const run = spawnSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, name))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
  return { stdout: run.stdout, stderr: run.stderr, exitCode: run.status ?? -1 };
}
async function engineAnswers(name: string): Promise<Seen> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
  vfs.writeFileSync(`/work/${name}`, programs[name]!);
  const result = await createContainer({ vfs }).run(`node /work/${name}`, { cwd: '/work' });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-loop-'));
  for (const [name, source] of Object.entries(programs)) writeFileSync(join(dir, name), source);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a node program that printed', () => {
  it('runs a timer it set to the end, as Node does', async () => {
    const seen = await engineAnswers('printed-timer.mjs');
    expect(seen).toEqual(nodeAnswers(dir, 'printed-timer.mjs'));
    expect(seen).toEqual({ stdout: 'a\nb\n', stderr: '', exitCode: 0 });
  }, 20_000);
  it('runs work a promise chain reaches after its first line, as Node does', async () => {
    const seen = await engineAnswers('printed-chain.mjs');
    expect(seen).toEqual(nodeAnswers(dir, 'printed-chain.mjs'));
    expect(seen).toEqual({ stdout: 'a\nc\n', stderr: '', exitCode: 0 });
  }, 20_000);
  it('ends at once when nothing is left', async () => {
    const started = Date.now();
    const seen = await engineAnswers('printed-done.mjs');
    expect(seen).toEqual(nodeAnswers(dir, 'printed-done.mjs'));
    expect(seen).toEqual({ stdout: 'a\nd\n', stderr: '', exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(400);
  }, 20_000);
});
