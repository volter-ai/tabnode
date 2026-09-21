// Node's IPC carries a handle beside the message: `subprocess.send(message,
// sendHandle)` hands the child a `net.Socket` or a `net.Server`, and the
// child's `process.on('message', (message, handle) => …)` receives both; the
// child-side `process.send(message, sendHandle)` sends one back the same way.
//
// openvscode-server hands its extension host the workbench's connection over
// exactly this door: the server accepts the connection, forks the host, and
// sends `{ type: 'VSCODE_EXTHOST_IPC_SOCKET', … }` with the raw socket as the
// handle; the host waits for that message, wraps the handle as its socket and
// speaks the extension-host protocol on it. The engine's `send` took a message
// and a callback and emitted `'message'` with the message alone, so the handle
// never arrived: measured in the tab on 2026-09-20, "Launched Extension Host
// Process" was followed by "Extension Host Process exited with code: 0" a
// moment later, never relaunched, and Source Control sat on "Scanning folder
// for Git repositories…" forever.
//
// What these cases pin is the delivery: the second argument arrives, it is the
// socket itself and not a clone of it (the child writes and the parent's
// client reads what it wrote), and it travels in both directions. The engine
// runs parent and child in one realm, so the handle is the same object on both
// sides; there is no descriptor to duplicate.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

const PORT = 45921;
const PORT_BACK = 45922;

async function runParent(programs: Record<string, string>, entry: string) {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
  for (const [name, source] of Object.entries(programs)) vfs.writeFileSync(`/work/${name}`, source);
  return await createContainer({ vfs }).run(`node /work/${entry}`, { cwd: '/work' });
}

describe('an IPC send carries its handle', () => {
  it('delivers the socket to the child, which writes on it', async () => {
    const seen = await runParent({
      'parent.js': [
        "const net = require('net');",
        "const { fork } = require('child_process');",
        "let child;",
        "const server = net.createServer((accepted) => {",
        "  child = fork('./child.js');",
        "  child.send({ type: 'sock' }, accepted, (error) => console.log('sent ' + error));",
        "});",
        `server.listen(${PORT}, () => {`,
        `  const client = net.connect(${PORT}, '127.0.0.1');`,
        "  client.on('data', (chunk) => {",
        "    const text = String(chunk);",
        "    console.log('client read ' + text);",
        // A quiet interval, then one more word down the same socket: the child
        // is still there to answer it, holding nothing but the handle it was
        // given.
        "    if (text.indexOf('hello from') === 0) setTimeout(() => client.write('ping'), 1200);",
        // A forked child is a run of its own now, and Node's IPC channel holds
        // it open while it is listening for messages -- measured on the host's
        // node, this program never exits until the parent disconnects, which
        // is what a parent that is done with its child does.
        "    else { client.end(); server.close(); child.disconnect(); }",
        "  });",
        "});",
      ].join('\n'),
      // The child sets no timer: the socket it was handed is all it has.
      'child.js': [
        "process.on('message', (message, sock) => {",
        "  console.log('child got ' + message.type + ' ' + typeof sock.write);",
        "  sock.on('data', () => sock.write('child still here'));",
        "  sock.write('hello from ' + message.type);",
        "});",
      ].join('\n'),
    }, 'parent.js');

    expect(seen.stdout).toContain('child got sock function');
    expect(seen.stdout).toContain('client read hello from sock');
    // The send callback is Node's, called with null once the message is away.
    expect(seen.stdout).toContain('sent null');
    // The child answered on the handle after 1200 ms of quiet, with no timer
    // of its own: the socket it was handed is a live socket, and holding it is
    // being at work.
    expect(seen.stdout).toContain('client read child still here');
    expect(seen.exitCode).toBe(0);
  }, 30_000);

  it('carries a handle from the child back to the parent, which writes on it', async () => {
    const seen = await runParent({
      'parent.js': [
        "const net = require('net');",
        "const { fork } = require('child_process');",
        "const server = net.createServer((accepted) => {",
        "  const child = fork('./child.js');",
        "  child.on('message', (message, handle) => {",
        "    console.log('parent got ' + message.type + ' ' + typeof handle.write);",
        "    handle.write('parent wrote');",
        "    child.disconnect();",
        "  });",
        "  child.send({ type: 'sock' }, accepted);",
        "});",
        `server.listen(${PORT_BACK}, () => {`,
        `  const client = net.connect(${PORT_BACK}, '127.0.0.1');`,
        "  client.on('data', (chunk) => {",
        "    console.log('client read ' + String(chunk));",
        "    client.end();",
        "    server.close();",
        "  });",
        "});",
      ].join('\n'),
      'child.js': [
        "process.on('message', (message, sock) => {",
        "  if (message.type === 'sock') process.send({ type: 'back' }, sock);",
        "});",
      ].join('\n'),
    }, 'parent.js');

    expect(seen.stdout).toContain('parent got back function');
    expect(seen.stdout).toContain('client read parent wrote');
    expect(seen.exitCode).toBe(0);
  }, 30_000);

  it('reads a function in the handle s place as the callback, as Node does', async () => {
    const seen = await runParent({
      'parent.js': [
        "const { fork } = require('child_process');",
        "const child = fork('./child.js');",
        "child.on('exit', (code) => console.log('child exit ' + code));",
        "child.send({ type: 'plain' }, (error) => console.log('sent ' + error));",
      ].join('\n'),
      'child.js': [
        "process.on('message', (message, sock) => {",
        "  console.log('child got ' + message.type + ' handle ' + typeof sock);",
        "  process.exit(0);",
        "});",
      ].join('\n'),
    }, 'parent.js');

    expect(seen.stdout).toContain('sent null');
    expect(seen.stdout).toContain('child got plain handle undefined');
    expect(seen.stdout).toContain('child exit 0');
    expect(seen.exitCode).toBe(0);
  }, 20_000);
});
