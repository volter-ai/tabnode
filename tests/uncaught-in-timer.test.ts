// An exception a timer callback throws belongs to the program that set the
// timer. Node: the process's `uncaughtException` listeners take it, else the
// stack goes to that process's stderr and that process exits 1 — and every
// other process is untouched. The engine ran a guest's timers on the realm's
// own loop and never caught the throw, so it reached the realm's global
// `error` event; in the tab that realm is a worker, and the substrate's
// container reads a worker error as a dead host and disposes it. One throw in
// one `setTimeout` of openvscode-server's took the extension host and every
// other program in the tab with it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { VirtualFS, createContainer } from '../src/index';

const programs: Record<string, string> = {
  // Nobody is listening: the stack is printed and the program ends, so the
  // line after the wait never runs.
  'timer.mjs': "setTimeout(() => { throw new Error('boom'); }, 10);\nawait new Promise((r) => setTimeout(r, 200));\nconsole.log('after');\n",
  // The guest listens on its own process and the program goes on to exit 0.
  'caught.mjs': "process.on('uncaughtException', (e) => console.log('caught', e.message));\nsetTimeout(() => { throw new Error('boom'); }, 10);\nawait new Promise((r) => setTimeout(r, 200));\nconsole.log('after');\n",
  // A repeating timer's callback throws the same way, and the first throw ends
  // the program: the interval does not fire again.
  'interval.mjs': "setInterval(() => { throw new Error('boom'); }, 10);\nawait new Promise((r) => setTimeout(r, 200));\nconsole.log('after');\n",
  // What a second program in the same realm still does after the first died.
  'alive.mjs': "console.log('alive');\n",
};

interface Seen { stdout: string; exitCode: number }
function nodeAnswers(dir: string, name: string): Seen {
  const run = spawnSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, name))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
  return { stdout: run.stdout, exitCode: run.status ?? -1 };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uncaught-'));
  for (const [name, source] of Object.entries(programs)) writeFileSync(join(dir, name), source);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function tab(): { run: (name: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> } {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
  for (const [name, source] of Object.entries(programs)) vfs.writeFileSync(`/work/${name}`, source);
  const container = createContainer({ vfs });
  return { run: (name: string) => container.run(`node /work/${name}`, { cwd: '/work' }) };
}

describe('an exception a timer callback throws', () => {
  it('prints the stack to the program s own stderr and exits it 1, as Node does', async () => {
    const container = tab();
    const seen = await container.run('timer.mjs');
    expect({ stdout: seen.stdout, exitCode: seen.exitCode }).toEqual(nodeAnswers(dir, 'timer.mjs'));
    expect({ stdout: seen.stdout, exitCode: seen.exitCode }).toEqual({ stdout: '', exitCode: 1 });
    expect(seen.stderr).toContain('boom');
    expect(seen.stderr).toMatch(/\n\s+at /u);
    // The program that threw is the only one that died.
    const after = await container.run('alive.mjs');
    expect({ stdout: after.stdout, exitCode: after.exitCode }).toEqual({ stdout: 'alive\n', exitCode: 0 });
  }, 30_000);

  it('goes to a listener the guest put on its process, and the program goes on', async () => {
    const seen = await tab().run('caught.mjs');
    expect({ stdout: seen.stdout, exitCode: seen.exitCode }).toEqual(nodeAnswers(dir, 'caught.mjs'));
    expect({ stdout: seen.stdout, exitCode: seen.exitCode }).toEqual({ stdout: 'caught boom\nafter\n', exitCode: 0 });
  }, 30_000);

  it('ends the program from a repeating timer too, at the first throw', async () => {
    const seen = await tab().run('interval.mjs');
    expect({ stdout: seen.stdout, exitCode: seen.exitCode }).toEqual(nodeAnswers(dir, 'interval.mjs'));
    expect({ stdout: seen.stdout, exitCode: seen.exitCode }).toEqual({ stdout: '', exitCode: 1 });
    expect(seen.stderr).toContain('boom');
  }, 30_000);
});
