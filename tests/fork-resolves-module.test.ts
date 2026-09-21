// `child_process.fork(modulePath)` resolves its module path as `require`
// resolves a path: the file itself, then `.js`, `.mjs`, `.cjs`, `.json`, then
// a directory's `main` or `index.js`. openvscode-server forks its pty host as
// `<server>/out/bootstrap-fork`, where the file is `bootstrap-fork.js`; the
// engine opened the path as written, answered
// `ENOENT: no such file or directory, open '.../out/bootstrap-fork'`, and the
// pty host died before the integrated terminal ever got a shell.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

async function runParent(programs: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
  for (const [name, source] of Object.entries(programs)) vfs.writeFileSync(`/work/${name}`, source);
  return await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
}

describe('fork resolves its module path', () => {
  it('forks ./child where the file is child.js, as require resolves a path', async () => {
    const seen = await runParent({
      'parent.js': "const { fork } = require('child_process');\nconst child = fork('./child');\nchild.on('exit', (code) => console.log('exit ' + code));\n",
      'child.js': "console.log('child ran');\nprocess.exit(0);\n",
    });
    expect(seen.stdout).toContain('child ran');
    expect(seen.stdout).toContain('exit 0');
    expect(seen.stderr).not.toContain('ENOENT');
  }, 20_000);

  // `fork` runs node on the path; the path is the CHILD's to resolve, and a
  // child that cannot find its module says so on its own stderr and exits 1,
  // which is what the host's node does. What must never appear is an ENOENT
  // from opening the path as written, which is how the pty host died.
  it('reports a path nothing resolves as Cannot find module, never as ENOENT', async () => {
    const seen = await runParent({
      'parent.js': "const { fork } = require('child_process');\nconst child = fork('./missing', { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });\nlet said = '';\nchild.stderr.on('data', (chunk) => { said += chunk; });\nchild.on('close', (code) => console.log('exit ' + code + ' ' + said.trim()));\n",
    });
    expect(seen.stdout).toContain('exit 1');
    expect(seen.stdout).toContain('Cannot find module');
    expect(seen.stdout).not.toContain('ENOENT');
    expect(seen.stderr).not.toContain('ENOENT');
  }, 20_000);
});
