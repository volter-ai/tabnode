/**
 * A guest write of a small Buffer answers with those bytes, not the pool.
 *
 * Node's `Buffer.from` of a short string is a view on an 8 KB shared pool.
 * A binding or bridge that takes `chunk.buffer` without `byteOffset` /
 * `byteLength` carries the neighbours that sit beside it in the pool —
 * nulls, other responses, `HTTP/1.1 400` fragments. The page's Fetch
 * Response is built from `body.slice().buffer`, so the body the page sees
 * is that ArrayBuffer whole.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { ServerBridge } from '../src/server-bridge';

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

/** What the page's Fetch Response is built from: the ArrayBuffer of a slice. */
function pageSees(body: Uint8Array): string {
  return Buffer.from(body.slice().buffer).toString();
}

describe('a write of a pooled Buffer answers with its named bytes', () => {
  it('handleRequest’s body is BODY-A, with no neighbour and no null from the pool', async () => {
    const vfs = new VirtualFS();
    const bridge = new ServerBridge();
    await startGuest(vfs, `
      const http = require('http');
      http.createServer((req, res) => {
        Buffer.from('NEIGHBOUR-1');
        Buffer.from('NEIGHBOUR-2');
        const body = Buffer.from('BODY-A');
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) });
        res.end(body);
      }).listen(0);
    `);
    const port = await listeningPort(bridge);
    const answer = await bridge.handleRequest(port, 'GET', '/', {});
    expect(answer.statusCode).toBe(200);
    expect(pageSees(answer.body as Uint8Array)).toBe('BODY-A');
    expect(answer.body).toBeDefined();
    expect(answer.body!.byteLength).toBe(6);
    expect(answer.body!.buffer.byteLength).toBe(6);
    expect(pageSees(answer.body as Uint8Array).includes('NEIGHBOUR')).toBe(false);
    expect(pageSees(answer.body as Uint8Array).includes('\0')).toBe(false);
    bridge.close();
  }, 20_000);
});
