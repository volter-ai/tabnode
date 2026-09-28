// A Request or Response body may be any async iterable, as Node's fetch
// (undici) reads it: a Node stream, an IncomingMessage, an async generator. A
// browser's constructors take such an object for a string ("[object
// Object]"). Next's App Router hands every route handler a request whose body
// is the Node request itself, so in a tab each POST a route handler read was
// that string. The test process is Node, whose own constructors already read
// such bodies, so the realm is first given constructors with a browser's
// body rule; the program must then read, under the engine, what Node reads.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import createContainer from '../src/index';
import { VirtualFS } from '../src/virtual-fs';
import { restoreHostGlobals } from '../src/host-globals';

const PROGRAM = [
  "const { Readable } = require('stream');",
  "const http = require('http');",
  "async function* generator() { yield 'g='; yield new TextEncoder().encode('1'); yield Buffer.from('&h=2'); }",
  "(async () => {",
  "  const out = {};",
  "  out.readable = await new Request('http://x.test/p', { method: 'POST', body: Readable.from([Buffer.from('a=1&json=true')]), duplex: 'half' }).text();",
  "  out.generator = await new Request('http://x.test/p', { method: 'POST', body: generator(), duplex: 'half' }).text();",
  "  out.response = await new Response(Readable.from(['r', 'e', 's'])).text();",
  "  out.plain = await new Request('http://x.test/p', { method: 'POST', body: 'plain' }).text();",
  "  out.params = await new Request('http://x.test/p', { method: 'POST', body: new URLSearchParams({ q: '1' }) }).text();",
  "  // Next's shape: an http server's request handed on as the body of a web Request.",
  "  const server = http.createServer(async (req, res) => {",
  "    const web = new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: req, duplex: 'half' });",
  "    const body = Object.fromEntries(new URLSearchParams(await web.text()));",
  "    res.end(JSON.stringify(body));",
  "  });",
  "  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));",
  "  const port = server.address().port;",
  "  out.server = await new Promise((ok) => {",
  "    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/callback/credentials', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => ok(JSON.parse(d))); });",
  "    r.end('csrfToken=t&json=true');",
  "  });",
  "  server.close();",
  "  console.log(JSON.stringify(out));",
  "})().catch((e) => { console.log(JSON.stringify({ error: String(e) })); });",
].join('\n');

function fromNode(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'body-'));
  writeFileSync(join(dir, 'p.js'), PROGRAM);
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'p.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

/** What a browser does with a body that is none of its kinds: its string. */
const browserBody = (body: unknown): unknown => {
  if (body === null || body === undefined || typeof body !== 'object') return body;
  if (body instanceof ReadableStream || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
    || body instanceof FormData || body instanceof URLSearchParams) return body;
  return String(body);
};

const undiciRequest = globalThis.Request;
const undiciResponse = globalThis.Response;
afterEach(() => {
  restoreHostGlobals();
  globalThis.Request = undiciRequest;
  globalThis.Response = undiciResponse;
});

describe('a body that is an async iterable', () => {
  it('is read as Node reads it, over a realm whose constructors have a browser\'s body rule', async () => {
    restoreHostGlobals();
    class BrowserRequest extends undiciRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init && 'body' in init ? { ...init, body: browserBody(init.body) as BodyInit } : init);
      }
    }
    class BrowserResponse extends undiciResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) { super(browserBody(body) as BodyInit, init); }
    }
    expect(await new BrowserRequest('http://x.test', { method: 'POST', body: (async function* () { yield 'x'; })() as unknown as BodyInit, duplex: 'half' } as RequestInit).text()).toBe('[object AsyncGenerator]');
    globalThis.Request = BrowserRequest;
    globalThis.Response = BrowserResponse;

    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/p.js', PROGRAM);
    let stdout = '';
    const result = await createContainer({ vfs }).run('node /app/p.js', { cwd: '/app', onStdout: (text: string) => { stdout += text; } });
    expect(result.exitCode, stdout).toBe(0);
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(seen).toEqual(fromNode());
    expect(seen.readable).toBe('a=1&json=true');
    expect(seen.generator).toBe('g=1&h=2');
    expect(seen.server).toEqual({ csrfToken: 't', json: 'true' });
  }, 30_000);
});
