// A child's `process.send` after the parent has gone is `ERR_IPC_CHANNEL_CLOSED`.
//
// Node's contract, measured on the host: when the parent exits, or destroys
// the child's channel with `disconnect()`, the child reads EOF, `connected`
// goes false, and the next `send` answers `ERR_IPC_CHANNEL_CLOSED` through
// the callback (or an `error` event). A write on a dead handle is never
// `EBADF`. A child's own IPC pipe stays writable until its `exit` listeners
// have run: a send from those listeners while the parent is still there is
// delivered. Written while reading openvscode-server's `bootstrap-fork.js`
// throw `write EBADF` from `process.send` after its parent had gone, which
// the tab's worker took as a dead host.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

function receiptsOf(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .filter((line) => /^\[run \d+\] /.test(line));
}

let spy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { spy?.mockRestore(); spy = undefined; });

const CHILD_SENDS = ""
  + "setInterval(() => {\n"
  + "  process.send('tick', (error) => {\n"
  + "    console.log('interval ' + (error && error.code) + ' connected ' + process.connected);\n"
  + "    if (error) process.exit(0);\n"
  + "  });\n"
  + "}, 10);\n"
  + "process.on('exit', () => {\n"
  + "  process.send('from-exit', (error) => {\n"
  + "    console.log('exit-send ' + (error && error.code) + ' connected ' + process.connected);\n"
  + "  });\n"
  + "  console.log('exit-connected ' + process.connected);\n"
  + "});\n"
  + "process.on('error', (error) => { console.log('error ' + error.code); });\n"
  + "process.on('disconnect', () => { console.log('disconnect connected ' + process.connected); });\n";

describe('a child whose parent has gone', () => {
  it('refuses send with ERR_IPC_CHANNEL_CLOSED, connected false, and no uncaught', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync('/work/child.js', CHILD_SENDS);
    vfs.writeFileSync(
      '/work/parent.js',
      "const { fork } = require('child_process');\n"
        + "const child = fork('/work/child.js');\n"
        + "child.on('exit', (code) => { console.log('child-exit ' + code); });\n"
        + "setTimeout(() => { child.disconnect(); }, 40);\n"
        + "setTimeout(() => {}, 400);\n",
    );
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
    const text = seen.stdout + seen.stderr;
    expect(text).toContain('disconnect connected false');
    expect(text).toContain('interval ERR_IPC_CHANNEL_CLOSED connected false');
    expect(text).not.toContain('EBADF');
    expect(receiptsOf(spy!).some((line) => /uncaught:.*EBADF/.test(line))).toBe(false);
    expect(seen.exitCode).toBe(0);
  }, 20_000);

  it('delivers a send from the child s exit listener while the parent is still there', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync(
      '/work/child.js',
      "process.send('ready');\n"
        + "process.on('message', (message) => { if (message === 'die') process.exit(0); });\n"
        + "process.on('exit', () => { process.send('from-exit'); console.log('exit-send-connected ' + process.connected); });\n",
    );
    vfs.writeFileSync(
      '/work/parent.js',
      "const { fork } = require('child_process');\n"
        + "const child = fork('/work/child.js');\n"
        + "child.on('message', (message) => {\n"
        + "  console.log('got ' + message);\n"
        + "  if (message === 'ready') child.send('die');\n"
        + "});\n"
        + "child.on('exit', (code) => { console.log('child-exit ' + code); });\n",
    );
    const seen = await createContainer({ vfs }).run('node /work/parent.js', { cwd: '/work' });
    expect(seen.stdout).toContain('got ready');
    expect(seen.stdout).toContain('got from-exit');
    expect(seen.stdout + seen.stderr).not.toContain('EBADF');
    expect(seen.exitCode).toBe(0);
  }, 20_000);

  it('refuses send the same way when the parent exits rather than disconnects', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync(
      '/work/child.js',
      "const fs = require('fs');\n"
        + "const log = (line) => { fs.appendFileSync('/work/child.log', line + '\\n'); };\n"
        + "setInterval(() => {\n"
        + "  process.send('tick', (error) => {\n"
        + "    log('interval ' + (error && error.code) + ' connected ' + process.connected);\n"
        + "    if (error) process.exit(0);\n"
        + "  });\n"
        + "}, 10);\n"
        + "process.on('exit', () => {\n"
        + "  process.send('from-exit', (error) => { log('exit-send ' + (error && error.code) + ' connected ' + process.connected); });\n"
        + "  log('exit-connected ' + process.connected);\n"
        + "});\n"
        + "process.on('error', (error) => { log('error ' + error.code + ' ' + error.message); });\n"
        + "process.on('disconnect', () => { log('disconnect connected ' + process.connected); });\n"
        + "process.on('uncaughtException', (error) => { log('uncaught ' + error.code + ' ' + error.message); });\n",
    );
    vfs.writeFileSync(
      '/work/parent.js',
      "const { fork } = require('child_process');\n"
        + "fork('/work/child.js');\n"
        + "setTimeout(() => { process.exit(0); }, 40);\n",
    );
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = createContainer({ vfs });
    const seen = await container.run('node /work/parent.js', { cwd: '/work' });
    // The child outlives the parent; its interval is the host's own timer.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const log = vfs.existsSync('/work/child.log') ? vfs.readFileSync('/work/child.log', 'utf8') : '';
    expect(seen.exitCode).toBe(0);
    expect(log).toContain('disconnect connected false');
    expect(log).toContain('interval ERR_IPC_CHANNEL_CLOSED connected false');
    expect(log).not.toContain('EBADF');
    expect(log).not.toMatch(/uncaught /);
    expect(receiptsOf(spy!).some((line) => /uncaught:.*EBADF/.test(line))).toBe(false);
  }, 20_000);
});
