/**
 * The page bridge's loopback client answers one response per request.
 *
 * `__requestOverLoopback` connects, writes one request and parses one
 * response. If a connection is reused (keep-alive) or the parser does not
 * stop at the message's end, later bytes bleed into an earlier body: a 200
 * whose body is a mix of 400/408/431/413 fragments and the real payload.
 * One connection per request, Connection: close, the parser ending at
 * Content-Length or the chunked terminator, the socket destroyed then.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { ServerBridge } from '../src/server-bridge';
import { netModule, type Socket } from '../src/node-lib/net-module';

function startGuest(vfs: VirtualFS, source: string): Promise<unknown> {
  vfs.mkdirSync('/workspace/app', { recursive: true });
  vfs.writeFileSync('/workspace/app/server.js', source);
  return new Runtime(vfs, { cwd: '/workspace/app' }).runFileAsync('/workspace/app/server.js');
}

function listeningPort(bridge: ServerBridge): Promise<number> {
  return new Promise<number>((resolve) => {
    const seen = bridge.getServerPorts();
    if (seen.length > 0) { resolve(seen[0]!); return; }
    bridge.on('server-ready', (port: number) => resolve(port));
  });
}

describe('the loopback client keeps one response per request', () => {
  it('three concurrent handleRequest calls each receive exactly the body their server wrote', async () => {
    const vfs = new VirtualFS();
    const bridge = new ServerBridge();
    await startGuest(vfs, `
      const http = require('http');
      http.createServer((req, res) => {
        if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('BODY200'); return; }
        if (req.url === '/bad') { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('BODY400'); return; }
        res.writeHead(413, { 'content-type': 'text/plain' }); res.end('BODY413');
      }).listen(0);
    `);
    const port = await listeningPort(bridge);

    const received: Buffer[] = [];
    const original = netModule.connect.bind(netModule);
    netModule.connect = ((options: { port: number; host?: string }, listener?: () => void) => {
      const socket = original(options, listener) as unknown as Socket;
      if (options.port === port) {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Uint8Array) => { chunks.push(Buffer.from(chunk)); });
        socket.on('close', () => { received.push(Buffer.concat(chunks)); });
      }
      return socket;
    }) as typeof netModule.connect;

    try {
      const [ok, bad, big] = await Promise.all([
        bridge.handleRequest(port, 'GET', '/ok', {}),
        bridge.handleRequest(port, 'GET', '/bad', {}),
        bridge.handleRequest(port, 'GET', '/big', {}),
      ]);

      expect([ok.statusCode, ok.body!.toString()]).toEqual([200, 'BODY200']);
      expect([bad.statusCode, bad.body!.toString()]).toEqual([400, 'BODY400']);
      expect([big.statusCode, big.body!.toString()]).toEqual([413, 'BODY413']);

      const tags = ['BODY200', 'BODY400', 'BODY413'] as const;
      expect(received).toHaveLength(3);
      const seen = received.map((bytes) => {
        const text = bytes.toString();
        const matches = tags.filter((tag) => text.includes(tag));
        expect(matches, `raw bytes mixed: ${JSON.stringify(text)}`).toEqual([matches[0]]);
        return matches[0];
      });
      expect(new Set(seen)).toEqual(new Set(tags));
    } finally {
      netModule.connect = original;
      bridge.close();
    }
  }, 20_000);

  it('bytes after the first message on one socket are not part of its body', async () => {
    const vfs = new VirtualFS();
    const bridge = new ServerBridge();
    await startGuest(vfs, `
      const http = require('http');
      http.createServer((req, res) => {
        // One write, two messages: the parser that does not stop at
        // Content-Length will join BODY400 onto the 200.
        const two =
          'HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\n\\r\\nBODY200' +
          'HTTP/1.1 400 Bad Request\\r\\nContent-Length: 7\\r\\n\\r\\nBODY400';
        req.socket.write(two);
      }).listen(0);
    `);
    const port = await listeningPort(bridge);
    const answer = await bridge.handleRequest(port, 'GET', '/ok', {});
    expect(answer.statusCode).toBe(200);
    expect(answer.body!.toString()).toBe('BODY200');
    bridge.close();
  }, 20_000);
});
