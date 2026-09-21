// `subprocess.kill()` on a child that has already exited does nothing and
// returns false, and a child's `exit` and `close` fire once per child, ever.
// VS Code's pty-host supervisor kills its child from its own `exit` listener;
// against a `kill` that re-emitted `exit` that was kill -> exit -> kill, until
// `RangeError: Maximum call stack size exceeded` ended the host.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

describe('kill on a child that has exited', () => {
  it('does nothing, returns false, and exit fires once', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync('/work/child.js', "process.exit(0);\n");
    vfs.writeFileSync(
      '/work/parent.js',
      "const { fork } = require('child_process');\n"
        + "const child = fork('./child.js');\n"
        + "child.on('exit', () => { console.log('exit'); console.log('kill returned ' + child.kill()); });\n",
    );
    const seen = await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
    expect(seen.stdout.split('\n').filter((line) => line === 'exit')).toHaveLength(1);
    expect(seen.stdout).toContain('kill returned false');
    expect(seen.stderr).not.toContain('RangeError');
    expect(seen.exitCode).toBe(0);
  }, 20_000);
});
