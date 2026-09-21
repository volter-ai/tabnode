// A run whose stderr is a pipe nobody reads still has to name why it died.
//
// Node prints an uncaught exception to that process's stderr. A parent that
// pipes the fd and never reads it — openvscode-server pipes the extension
// host into `@vscode/spdlog`, a native module that does not load — drops
// the reason, in Node too. The engine's run model already has the uncaught
// door; when the run ends uncaught (or by process.exit with a nonzero
// code) on a pipe to a parent, it writes one line to the host realm's
// console.error. Inherit is the host's own stdio and gets no duplicate.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

function receiptsOf(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .filter((line) => /^\[run \d+\] /.test(line));
}

let spy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { spy?.mockRestore(); spy = undefined; });

async function runParent(programs: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
  for (const [name, source] of Object.entries(programs)) vfs.writeFileSync(`/work/${name}`, source);
  spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
}

describe('a child whose stderr is a pipe nobody reads', () => {
  it('writes one host-console line naming the pid, the script and the throw', async () => {
    const seen = await runParent({
      'parent.js':
        "const { fork } = require('child_process');\n"
        + "const child = fork('./child.js', { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });\n"
        + "console.log('child-pid ' + child.pid);\n"
        + "child.on('exit', (code) => console.log('exit ' + code));\n",
      'child.js': "throw new Error('boom from child');\n",
    });
    const pid = /child-pid (\d+)/.exec(seen.stdout)?.[1];
    expect(pid).toBeTruthy();
    expect(seen.stdout).toContain('exit 1');
    const receipts = receiptsOf(spy!);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatch(new RegExp(`^\\[run ${pid}\\] node /work/child\\.js ended uncaught:`));
    expect(receipts[0]).toContain('boom from child');
    expect(receipts[0]).toMatch(/ at /);
  }, 20_000);

  it('writes the line when a handler calls process.exit(1) after an uncaught, as Node ends that process', async () => {
    const seen = await runParent({
      'parent.js':
        "const { fork } = require('child_process');\n"
        + "const child = fork('./child.js', { silent: true });\n"
        + "console.log('child-pid ' + child.pid);\n"
        + "child.on('exit', (code) => console.log('exit ' + code));\n",
      'child.js':
        "process.on('uncaughtException', () => process.exit(1));\n"
        + "throw new Error('handled then exit');\n",
    });
    const pid = /child-pid (\d+)/.exec(seen.stdout)?.[1];
    expect(pid).toBeTruthy();
    expect(seen.stdout).toContain('exit 1');
    const receipts = receiptsOf(spy!);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatch(new RegExp(`^\\[run ${pid}\\] node /work/child\\.js ended `));
    expect(receipts[0]).toContain('handled then exit');
  }, 20_000);

  it('writes no such line when the child inherits stderr', async () => {
    const seen = await runParent({
      'parent.js':
        "const { fork } = require('child_process');\n"
        + "const child = fork('./child.js');\n"
        + "child.on('exit', (code) => console.log('exit ' + code));\n",
      'child.js': "throw new Error('boom from child');\n",
    });
    expect(seen.stdout).toContain('exit 1');
    expect(receiptsOf(spy!)).toHaveLength(0);
  }, 20_000);
});
