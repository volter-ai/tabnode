// A guest spawn whose fd 0 is a pipe delivers the bytes written on that turn
// to a page-registered program, as Node delivers them to the child's fd 0.
//
// OpenVSCode's git extension commits with `spawn('git', ['commit', '--file', '-'])`
// and the message on stdin. The host path used to pass only stdinStream, which
// this spawn never set, so the program ran with an empty fd 0.
import { afterEach, describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

const HOST = Symbol.for('@volter/browser-runtime/child-process-executor');

const PARENT = `
const { spawn } = require('child_process');
console.log('parent start');
const child = spawn('git', ['commit', '--quiet', '--allow-empty-message', '--file', '-']);
console.log('spawned pid ' + child.pid + ' err ' + (child.spawnfile || ''));
child.on('error', (err) => { console.log('spawn error ' + err.code + ' ' + err.message); });
child.stdin.write('the commit message\\n');
child.stdin.end();
child.on('exit', (code, signal) => { console.log('exit ' + code + ' ' + signal); });
`;

describe('a guest spawn with piped stdin, routed to the host', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, HOST);
  });

  it('hands the host the bytes written on the spawn turn', async () => {
    const seen: Array<{ command: string; stdin?: string }> = [];
    Reflect.set(globalThis, HOST, {
      // The outer `container.run('node …')` is itself a routed command; one
      // bypass lets the parent start in the engine, so the host sees the
      // child's `git`.
      bypass: 1,
      run: async (command: string, request: { stdin?: string }) => {
        seen.push({ command, stdin: request.stdin });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/parent.js', PARENT);
    const result = await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
    const transcript = `exitCode ${result.exitCode}\nstdout ${JSON.stringify(result.stdout)}\nstderr ${JSON.stringify(result.stderr)}\nseen ${JSON.stringify(seen)}`;
    expect(result.stdout, transcript).toContain('exit 0');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.stdin).toBe('the commit message\n');
  }, 10_000);
});
