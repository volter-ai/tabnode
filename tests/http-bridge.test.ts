// The page's path to a guest's server, end to end in the engine.
//
// The bridge used to reach a guest's server by calling a method on the
// engine's own `http.Server` object. `http` is Node's own file now and its
// `Server` has no such method -- it has a socket -- so the bridge is a client:
// it finds the port in the net binding's listening registry, connects to it
// through the same loopback pairing any guest client uses, and speaks HTTP.
// These two tests are that path, with nothing imitated on either end: a real
// `http.createServer` answering, and the real `ws` package -- the one this
// repo installs -- taking over an upgraded connection.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { ServerBridge } from '../src/server-bridge';

/** The installed `ws`, copied into the guest's tree as an installed package is. */
function installWs(vfs: VirtualFS, from: string): void {
  const copy = (source: string, target: string): void => {
    for (const name of readdirSync(source)) {
      const sourcePath = join(source, name);
      const targetPath = `${target}/${name}`;
      if (statSync(sourcePath).isDirectory()) {
        vfs.mkdirSync(targetPath, { recursive: true });
        copy(sourcePath, targetPath);
      } else if (name.endsWith('.js') || name.endsWith('.json')) {
        vfs.writeFileSync(targetPath, readFileSync(sourcePath, 'utf8'));
      }
    }
  };
  vfs.mkdirSync('/workspace/app/node_modules/ws', { recursive: true });
  copy(from, '/workspace/app/node_modules/ws');
}

/** A guest, started and left running; the promise settles when its entry has run. */
function startGuest(vfs: VirtualFS, source: string): Promise<unknown> {
  vfs.writeFileSync('/workspace/app/server.js', source);
  const runtime = new Runtime(vfs, { cwd: '/workspace/app' });
  return runtime.runFileAsync('/workspace/app/server.js');
}

/** The bridge says when a guest has taken a port; that is what the page waits for. */
function listeningPort(bridge: ServerBridge): Promise<number> {
  return new Promise<number>((resolve) => {
    const seen = bridge.getServerPorts();
    if (seen.length > 0) { resolve(seen[0]!); return; }
    bridge.on('server-ready', (port: number) => resolve(port));
  });
}

describe('the page bridge over a real connection', () => {
  it('streams a guest server\'s chunks to the caller as they are written', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/workspace/app', { recursive: true });
    const bridge = new ServerBridge();
    await startGuest(vfs, `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-guest': 'yes' });
        res.write('first,');
        setTimeout(() => { res.write('second,'); res.end('last'); }, 20);
      }).listen(0);
    `);
    const port = await listeningPort(bridge);
    const seen: string[] = [];
    let status = 0;
    let header = '';
    const handled = await bridge.handleStreamingRequest(port, 'GET', '/stream', {}, undefined, {
      start: (statusCode, _message, headers) => { status = statusCode; header = String(headers['x-guest']); },
      chunk: (chunk) => { seen.push(new TextDecoder().decode(chunk)); },
      end: () => { seen.push('<end>'); },
    });
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(header).toBe('yes');
    expect(seen.join('')).toBe('first,second,last<end>');
  }, 20_000);

  it('answers a request from a guest http.createServer with its status, headers and body', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/workspace/app', { recursive: true });
    const bridge = new ServerBridge();
    await startGuest(vfs, `
      const http = require('http');
      http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(201, { 'content-type': 'application/json', 'x-seen': req.headers['x-probe'] });
          res.end(JSON.stringify({ method: req.method, url: req.url, body }));
        });
      }).listen(8411);
    `);
    const port = await listeningPort(bridge);
    expect(port).toBe(8411);

    const answer = await bridge.handleRequest(8411, 'POST', '/page?q=1', { 'x-probe': 'yes' }, new TextEncoder().encode('from the page').buffer);
    expect(answer.statusCode).toBe(201);
    expect(answer.headers['content-type']).toBe('application/json');
    expect(answer.headers['x-seen']).toBe('yes');
    expect(JSON.parse(answer.body!.toString())).toEqual({ method: 'POST', url: '/page?q=1', body: 'from the page' });
    bridge.close();
  });

  it('carries a frame to a guest ws.WebSocketServer and back through the upgrade path', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/workspace/app', { recursive: true });
    // Not `process.cwd()`: a Runtime has been made by now and the engine
    // answers the realm's `process` with a guest's, whose cwd is the guest's.
    installWs(vfs, join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ws'));
    const bridge = new ServerBridge();
    await startGuest(vfs, `
      const http = require('http');
      const { WebSocketServer } = require('ws');
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      wss.on('connection', (socket) => {
        socket.on('message', (data) => { socket.send('echo:' + data.toString()); });
      });
      server.listen(8412);
    `);
    const port = await listeningPort(bridge);
    expect(port).toBe(8412);

    // The page's side of the upgrade, which is what the bridge's channel does
    // for a virtual websocket: connect, send a frame, read the answer.
    const { __upgradeOverLoopback } = await import('../src/node-lib/http-bridge');
    const result = await __upgradeOverLoopback(8412, 'GET', '/', {
      Host: '127.0.0.1:8412',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    });
    expect(result.statusCode).toBe(101);
    expect(result.socket).not.toBeNull();

    const answer = await new Promise<string>((resolve) => {
      const chunks: Uint8Array[] = [];
      result.socket!.on('data', (chunk: Uint8Array) => {
        chunks.push(chunk);
        const all = Buffer.concat(chunks.map((one) => Buffer.from(one)));
        // A server's frame is unmasked: opcode, length, then the payload.
        if (all.length >= 2 && (all[0]! & 0x0f) === 1) {
          const length = all[1]! & 0x7f;
          if (all.length >= 2 + length) resolve(all.subarray(2, 2 + length).toString());
        }
      });
      // A client's frame is masked, as RFC 6455 requires of a client.
      const payload = Buffer.from('hello');
      const mask = Buffer.from([1, 2, 3, 4]);
      const frame = Buffer.alloc(6 + payload.length);
      frame[0] = 0x81;
      frame[1] = 0x80 | payload.length;
      mask.copy(frame, 2);
      for (let index = 0; index < payload.length; index += 1) frame[6 + index] = payload[index]! ^ mask[index % 4]!;
      result.socket!.write(frame);
    });
    expect(answer).toBe('echo:hello');
    result.socket!.destroy();
    bridge.close();
  });
});
