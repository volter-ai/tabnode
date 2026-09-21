// The path openvscode-server's extension host connection takes, end to end
// in the engine: the page's virtual socket reaches a guest server's `upgrade`
// listener, the server answers its own 101 raw, hands the socket to a forked
// child over IPC, and the child speaks on it. Then the page reconnects and the
// server hands the child a second socket. Measured in the tab on fork .59: the
// workbench's ExtensionHost socket closed unclean (1006) after every reconnect
// while the Management socket held; this is the instrument that says which
// end closes.
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { ServerBridge } from '../src/server-bridge';
import { __upgradeOverLoopback } from '../src/node-lib/http-bridge';

function startGuest(vfs: VirtualFS, source: string): Promise<unknown> {
  vfs.writeFileSync('/workspace/app/server.js', source);
  const runtime = new Runtime(vfs, { cwd: '/workspace/app' });
  return runtime.runFileAsync('/workspace/app/server.js');
}

function listeningPort(bridge: ServerBridge): Promise<number> {
  return new Promise<number>((resolve) => {
    const seen = bridge.getServerPorts();
    if (seen.length > 0) { resolve(seen[0]!); return; }
    bridge.on('server-ready', (port: number) => resolve(port));
  });
}

async function connectRaw(port: number): Promise<{ socket: any; events: string[]; text: () => string }> {
  const result = await __upgradeOverLoopback(port, 'GET', '/exthost', { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' });
  expect(result.statusCode).toBe(101);
  const socket = result.socket as any;
  const chunks: string[] = [];
  const events: string[] = [];
  socket.on('data', (c: Uint8Array) => chunks.push(new TextDecoder().decode(c)));
  socket.on('end', () => events.push('end'));
  socket.on('close', () => events.push('close'));
  socket.on('error', (e: Error) => events.push('error:' + e.message));
  return { socket, events, text: () => chunks.join('') };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a socket handed from a guest server to its forked child', () => {
  it('stays open for the page while the child speaks on it, and again after a reconnect', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/workspace/app', { recursive: true });
    vfs.writeFileSync('/workspace/app/child.js', `
      process.on('message', (msg, sock) => {
        if (!sock) return;
        process.stdout.write('child got socket ' + msg + '\\n');
        sock.on('data', (d) => { sock.write('child-echo:' + d); });
        sock.on('close', () => process.stdout.write('child socket close\\n'));
        sock.on('error', (e) => process.stdout.write('child socket error ' + e.message + '\\n'));
        sock.write('hello-from-child:' + msg);
      });
      process.send('ready');
    `);
    const bridge = new ServerBridge();
    await startGuest(vfs, `
      const http = require('http');
      const { fork } = require('child_process');
      const child = fork('/workspace/app/child.js');
      let ready = false; const queue = [];
      child.on('message', (m) => { if (m === 'ready') { ready = true; for (const s of queue) child.send(s.n, s.sock); queue.length = 0; } });
      let n = 0;
      const server = http.createServer();
      server.on('upgrade', (req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
        n += 1;
        socket.on('close', () => process.stdout.write('parent socket ' + n + ' close\\n'));
        if (ready) child.send(String(n), socket); else queue.push({ n: String(n), sock: socket });
      });
      server.listen(8420);
    `);
    const port = await listeningPort(bridge);
    expect(port).toBe(8420);

    const first = await connectRaw(port);
    await wait(400);
    expect(first.text()).toContain('hello-from-child:1');
    first.socket.write('ping');
    await wait(300);
    expect(first.text()).toContain('child-echo:ping');
    expect(first.events).toEqual([]);

    // The page drops the connection and comes back, as the workbench does.
    first.socket.destroy();
    await wait(300);
    const second = await connectRaw(port);
    await wait(400);
    expect(second.text()).toContain('hello-from-child:2');
    second.socket.write('again');
    await wait(300);
    expect(second.text()).toContain('child-echo:again');
    expect(second.events).toEqual([]);
    bridge.close();
  }, 20_000);
});
