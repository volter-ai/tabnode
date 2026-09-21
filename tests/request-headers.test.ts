// A request keeps the headers it was built with, as Node keeps them. Node's
// fetch does not apply the fetch specification's forbidden-request-header
// guard and a browser's `Request` constructor does, so
// `new Request(url, { headers: { host } })` keeps the header on Node and
// silently loses it in a tab. Every framework that wraps a request it was
// handed in a web `Request` then reads null where Node shows a value: Next's
// middleware adapter does, and Dub's middleware died on its first line.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import createContainer from '../src/index';
import { VirtualFS } from '../src/virtual-fs';

/** Reads back the headers a request was built with, the forbidden names among them. */
const PROGRAM = [
  "const built = new Request('http://example.test/x', { headers: { host: 'app.localhost:8888', authorization: 'Bearer t', 'content-length': '3' } });",
  "const copied = new Request(built);",
  "const plain = new Headers({ host: 'only.headers:1' });",
  "console.log(JSON.stringify({",
  "  host: built.headers.get('host'),",
  "  authorization: built.headers.get('authorization'),",
  "  copiedHost: copied.headers.get('host'),",
  "  fromHeaders: plain.get('host'),",
  "  isRequest: built instanceof Request,",
  "  name: Request.name,",
  "  url: built.url,",
  "  method: built.method,",
  "}));",
].join('\n');

function fromNode(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'req-'));
  writeFileSync(join(dir, 'p.js'), PROGRAM);
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'p.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

describe('a web Request built by a guest', () => {
  it('keeps every header it was given, as Node keeps them', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/p.js', PROGRAM);
    let stdout = '';
    const result = await createContainer({ vfs }).run('node /app/p.js', { cwd: '/app', onStdout: (text: string) => { stdout += text; } });
    expect(result.exitCode, stdout).toBe(0);
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(seen).toEqual(fromNode());
    expect(seen.host).toBe('app.localhost:8888');
    expect(seen.copiedHost).toBe('app.localhost:8888');
    expect(seen.authorization).toBe('Bearer t');
    expect(seen.isRequest).toBe(true);
    expect(seen.name).toBe('Request');
    expect(seen.url).toBe('http://example.test/x');
  }, 30_000);
});
