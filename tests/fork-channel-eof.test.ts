// A child that exits closes its end of the IPC channel, and the parent's next
// `send` is refused rather than written.
//
// Node's contract: the child's exit closes its end of the pipe, the parent's
// channel reads EOF, `internal/child_process.js` runs `target.disconnect()`
// and `connected` goes false, so the next `send` answers
// `ERR_IPC_CHANNEL_CLOSED`, which a caller can catch -- never a write on a
// dead handle. Pinned against the host's own node, which answers: disconnect,
// exit 1, connected false, send callback ERR_IPC_CHANNEL_CLOSED.
//
// Written while reading openvscode-server's extension host dying in the tab,
// where an uncaught `Error: write EBADF` out of `target._send` was the
// suspected cause. It is not: the engine already answers this contract, in
// this shape, in the watcher's own shape (a child that dies of a failed
// require while piping its console over `send`), and three levels deep. The
// EBADF in the tab belonged to the server's own file-watcher child, and the
// extension host died of something else (see tests/fs-module-define.test.ts).
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

/** The watcher's shape: a child that exits from inside its own message handler. */
const CHILD = "process.on('message', () => { process.exit(1); });\nprocess.send('ready');\n";
const PARENT = "const { fork } = require('child_process');\n"
  + "const child = fork('/work/child.js');\n"
  + "child.on('message', () => { child.send('die'); });\n"
  + "child.on('disconnect', () => { console.log('disconnect'); });\n"
  + "child.on('exit', (code) => {\n"
  + "  console.log('exit ' + code);\n"
  + "  setTimeout(() => {\n"
  + "    console.log('connected ' + child.connected);\n"
  + "    try { child.send('after', (error) => { console.log('send callback ' + (error && error.code)); }); }\n"
  + "    catch (error) { console.log('send threw ' + error.code); }\n"
  + "  }, 50);\n"
  + "});\n";

describe('the parent of a child that has exited', () => {
  it('reads EOF on the channel and refuses the next send, as Node does', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync('/work/child.js', CHILD);
    vfs.writeFileSync('/work/parent.js', PARENT);
    const seen = await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
    // Node's own answer to this program, run on the host: disconnect, exit 1,
    // connected false, send callback ERR_IPC_CHANNEL_CLOSED.
    expect(seen.stdout).toContain('exit 1');
    expect(seen.stdout).toContain('disconnect');
    expect(seen.stdout).toContain('connected false');
    expect(seen.stdout).toContain('send callback ERR_IPC_CHANNEL_CLOSED');
    expect(seen.stdout + seen.stderr).not.toContain('EBADF');
  }, 20_000);
});
