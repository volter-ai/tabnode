// Every process has its own number, and a number nobody is running is ESRCH.
//
// Node gives each process a distinct `process.pid`, `process.ppid` names the
// one that started it, and the parent's `ChildProcess` handle carries the same
// number the child reports. Programs write those numbers into files and ask,
// later and from another process, whether the writer is still there:
// `try { process.kill(pid, 0); return true } catch { return false }`.
//
// The engine gave every guest `pid: 1` and `ppid: 0` while the parent's handle
// carried a real minted number, so a child and its parent disagreed, and every
// run answered `process.kill(1, 0)` with "that is me". openvscode-server's
// extension host takes a lock on its workspace storage directory
// (`vs/workbench/api/node/extHostStoragePaths`), writes `{ pid: process.pid }`
// into `vscode.lock`, and a later host steals the lock only if that pid is
// gone. Every host wrote 1 and every later host asked about 1 -- its own -- so
// the lock read as held forever, `ExtensionStoragePaths.whenReady` never
// resolved, and every extension's `_loadExtensionContext` awaits it: measured
// in the substrate's tab on v0.2.14-volter.63, five extensions sat at
// "Activating..." for fifteen minutes and `vscode.git` never started.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

describe('a process number', () => {
  it('is the child’s own, matches its parent’s handle, and names its parent', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync('/work/child.js', "process.send({ pid: process.pid, ppid: process.ppid });\n");
    vfs.writeFileSync('/work/parent.js',
      "const { fork } = require('child_process');\n"
      + "const a = fork('/work/child.js');\n"
      + "const b = fork('/work/child.js');\n"
      + "let seen = 0;\n"
      + "const report = (name, handle) => (message) => {\n"
      + "  console.log(name + ' own=' + message.pid + ' handle=' + handle.pid + ' ppid=' + message.ppid + ' parent=' + process.pid);\n"
      + "  if (++seen === 2) console.log('distinct=' + (a.pid !== b.pid));\n"
      + "};\n"
      + "a.on('message', report('A', a));\n"
      + "b.on('message', report('B', b));\n");
    const seen = await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
    const lines = seen.stdout.split('\n').filter(Boolean);
    expect(lines.filter((line) => /own=(\d+) handle=\1 /.test(line))).toHaveLength(2);
    for (const line of lines.slice(0, 2)) {
      const [, own, ppid, parent] = /own=(\d+) handle=\d+ ppid=(\d+) parent=(\d+)/.exec(line)!;
      expect(ppid).toBe(parent);
      expect(own).not.toBe(parent);
    }
    expect(seen.stdout).toContain('distinct=true');
  }, 20_000);

  it('answers ESRCH for the pid in a lock file whose writer has gone', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    // What `extHostStoragePaths` writes, and what it asks about it later.
    vfs.writeFileSync('/work/holder.js',
      "require('fs').writeFileSync('/work/vscode.lock', JSON.stringify({ pid: process.pid }));\n");
    vfs.writeFileSync('/work/taker.js',
      "const { pid } = JSON.parse(require('fs').readFileSync('/work/vscode.lock', 'utf8'));\n"
      + "const exists = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };\n"
      + "console.log('held by ' + pid + ' exists=' + exists(pid));\n"
      + "console.log('self ' + process.pid + ' exists=' + exists(process.pid));\n");
    const container = createContainer({ vfs });
    await container.run('node /work/holder.js', { cwd: '/work' });
    const seen = await container.run('node /work/taker.js', { cwd: '/work' });
    expect(seen.stdout).toMatch(/held by \d+ exists=false/);
    expect(seen.stdout).toMatch(/self \d+ exists=true/);
  }, 20_000);

  it('answers a child’s numbers through the container, and names the parent by pid', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync('/work/child.js', "process.send({ pid: process.pid, ppid: process.ppid });\n");
    vfs.writeFileSync('/work/parent.js',
      "const { fork } = require('child_process');\n"
      + "const child = fork('/work/child.js');\n"
      + "child.on('message', (message) => { console.log(JSON.stringify({ parent: process.pid, child: message })); });\n");
    const container = createContainer({ vfs });
    let captured: { parent?: { pid: number; ppid: number }; child?: { pid: number; ppid: number } } | undefined;
    const seen = await container.run('node /work/parent.js', {
      cwd: '/work',
      processToken: '1',
      onStdout(data) {
        const line = data.split('\n').find((text) => text.startsWith('{'));
        if (!line || captured) return;
        const body = JSON.parse(line) as { parent: number; child: { pid: number; ppid: number } };
        captured = {
          parent: container.runPid('1'),
          child: container.processByPid(body.child.pid),
        };
      },
    });
    const body = JSON.parse(seen.stdout.split('\n').find((text) => text.startsWith('{'))!);
    expect(captured?.parent?.pid).toBe(body.parent);
    expect(captured?.child?.pid).toBe(body.child.pid);
    expect(captured?.child?.ppid).toBe(body.parent);
  }, 20_000);
});
