// A promise rejection nobody handles ends a program, as it ends one in Node:
// the error printed, exit 1, nothing after it. A guest listener on its
// process for `unhandledRejection` takes it instead and the program goes on.
// vue-pure-admin's mock loader died in such a rejection and the engine's
// node program ended silently with exit 0.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { VirtualFS, createContainer } from '../src/index';

const programs: Record<string, string> = {
  // The rejection lands while the entry is still settling; the line after it never prints.
  'fatal.mjs': "console.log('before');\nawait new Promise((r) => setTimeout(r, 10));\nPromise.reject(new Error('boom'));\nawait new Promise((r) => setTimeout(r, 100));\nconsole.log('after');\n",
  // A reason that is not an Error is printed as it is.
  'plain.mjs': "console.log('before');\nawait new Promise((r) => setTimeout(r, 10));\nPromise.reject('plain reason');\nawait new Promise((r) => setTimeout(r, 100));\nconsole.log('after');\n",
  // The guest handles it on its process and the program goes on to exit 0.
  'handled.mjs': "process.on('unhandledRejection', (reason) => console.log('caught', reason.message));\nconsole.log('before');\nawait new Promise((r) => setTimeout(r, 10));\nPromise.reject(new Error('boom'));\nawait new Promise((r) => setTimeout(r, 100));\nconsole.log('after');\n",
  // Node calls the listener `(reason, promise)`, and a listener that uses the
  // promise is ordinary: openvscode-server's own keeps it and calls
  // `promise.catch` a second later. Handed `undefined` instead, every
  // rejection of the server's became a TypeError inside a timer.
  'promise.mjs': "process.on('unhandledRejection', (reason, promise) => { promise.catch(() => console.log('promise handed')); });\nconsole.log('before');\nawait new Promise((r) => setTimeout(r, 10));\nPromise.reject(new Error('boom'));\nawait new Promise((r) => setTimeout(r, 100));\nconsole.log('after');\n",
};

interface Seen { stdout: string; exitCode: number; stderrNames: boolean }
function nodeAnswers(dir: string, name: string): Seen {
  const run = spawnSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, name))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
  return { stdout: run.stdout, exitCode: run.status ?? -1, stderrNames: /boom|plain reason/u.test(run.stderr) };
}

let dir: string;
// The host's own unhandled-rejection listeners (the test runner's) are set
// aside for the run: the engine reports the guest's rejection through the
// host's process on a Node host, and the runner would otherwise count it.
let hostListeners: Array<(...args: unknown[]) => void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unhandled-'));
  for (const [name, source] of Object.entries(programs)) writeFileSync(join(dir, name), source);
  hostListeners = process.listeners('unhandledRejection') as Array<(...args: unknown[]) => void>;
  for (const listener of hostListeners) process.off('unhandledRejection', listener);
});
afterEach(() => {
  for (const listener of hostListeners) process.on('unhandledRejection', listener);
  rmSync(dir, { recursive: true, force: true });
});

async function engineAnswers(name: string): Promise<Seen> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
  vfs.writeFileSync(`/work/${name}`, programs[name]!);
  const result = await createContainer({ vfs }).run(`node /work/${name}`, { cwd: '/work' });
  return { stdout: result.stdout, exitCode: result.exitCode, stderrNames: /boom|plain reason/u.test(result.stderr) };
}

describe('an unhandled promise rejection in a node program', () => {
  it('prints the error and exits 1 before the next line, as Node does', async () => {
    const seen = await engineAnswers('fatal.mjs');
    expect(seen).toEqual(nodeAnswers(dir, 'fatal.mjs'));
    expect(seen).toEqual({ stdout: 'before\n', exitCode: 1, stderrNames: true });
  }, 20_000);
  it('prints a reason that is not an Error and exits 1, as Node does', async () => {
    const seen = await engineAnswers('plain.mjs');
    expect(seen).toEqual(nodeAnswers(dir, 'plain.mjs'));
    expect(seen).toEqual({ stdout: 'before\n', exitCode: 1, stderrNames: true });
  }, 20_000);
  it('goes to a listener the guest put on its process, and the program goes on', async () => {
    const seen = await engineAnswers('handled.mjs');
    expect(seen).toEqual(nodeAnswers(dir, 'handled.mjs'));
    expect(seen).toEqual({ stdout: 'before\ncaught boom\nafter\n', exitCode: 0, stderrNames: false });
  }, 20_000);
  it('hands that listener the promise that rejected, as Node hands it one', async () => {
    const seen = await engineAnswers('promise.mjs');
    expect(seen).toEqual(nodeAnswers(dir, 'promise.mjs'));
    expect(seen).toEqual({ stdout: 'before\npromise handed\nafter\n', exitCode: 0, stderrNames: false });
  }, 20_000);
});
