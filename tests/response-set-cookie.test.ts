// A response keeps the Set-Cookie headers it was built with, as Node's does.
// A browser's `Response` applies the fetch specification's response guard and
// drops them silently, so every server that answers with a web Response
// (Next's route handlers, NextAuth's sign-in among them) lost its cookies in
// a tab. Node's own behaviour is the reference: the program below runs under
// Node and in the engine, and the two must agree; and the class is measured
// against a stand-in for the browser's guarded Response, which Node's own
// Response (undici's) does not reproduce.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import createContainer from '../src/index';
import { VirtualFS } from '../src/virtual-fs';
import { nodeResponseClass } from '../src/node-response';

const PROGRAM = [
  "const built = new Response('body', { status: 201, headers: [['set-cookie', 'a=1; Path=/; HttpOnly'], ['set-cookie', 'b=2, c; Max-Age=60'], ['content-type', 'text/plain']] });",
  "built.headers.append('set-cookie', 'd=4');",
  "class Framework extends Response {}",
  "const sub = new Framework(null, { status: 302, headers: { location: '/me', 'set-cookie': 'sid=s' } });",
  "const json = Response.json({ ok: true }, { headers: { 'set-cookie': 'j=1' } });",
  "const copy = built.clone();",
  "console.log(JSON.stringify({",
  "  cookies: built.headers.getSetCookie(),",
  "  joined: built.headers.get('set-cookie'),",
  "  entries: [...built.headers].filter(([name]) => name === 'set-cookie').length,",
  "  status: built.status,",
  "  sub: sub.headers.getSetCookie(), subLocation: sub.headers.get('location'), subIsFramework: sub instanceof Framework, subIsResponse: sub instanceof Response,",
  "  json: json.headers.getSetCookie(), jsonType: json.headers.get('content-type'), jsonIsResponse: json instanceof Response,",
  "  copy: copy.headers.getSetCookie(), copyStatus: copy.status,",
  "  errorIsResponse: Response.error() instanceof Response, errorIsFramework: Response.error() instanceof Framework,",
  "  redirect: Response.redirect('http://x.test/y', 307).headers.get('location'),",
  "  name: Response.name,",
  "}));",
].join('\n');

function fromNode(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'resp-'));
  writeFileSync(join(dir, 'p.js'), PROGRAM);
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'p.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

/** The browser's Response, as far as its response guard goes: Set-Cookie never reaches its headers. */
class GuardedResponse extends Response {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    const headers = new Headers(init?.headers);
    headers.delete('set-cookie');
    super(body, { ...init, headers });
  }
  get headers(): Headers {
    const headers = new Headers(super.headers);
    headers.delete('set-cookie');
    return headers;
  }
}

describe('a web Response built by a guest', () => {
  it('keeps every Set-Cookie it was given, as Node keeps them', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/p.js', PROGRAM);
    let stdout = '';
    const result = await createContainer({ vfs }).run('node /app/p.js', { cwd: '/app', onStdout: (text: string) => { stdout += text; } });
    expect(result.exitCode, stdout).toBe(0);
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(seen).toEqual(fromNode());
    expect(seen.cookies).toEqual(['a=1; Path=/; HttpOnly', 'b=2, c; Max-Age=60', 'd=4']);
  }, 30_000);

  it('keeps them where the platform Response guards them away', async () => {
    const guarded = new GuardedResponse('x', { headers: { 'set-cookie': 'a=1' } });
    expect(guarded.headers.getSetCookie()).toEqual([]);
    const NodeResponse = nodeResponseClass(GuardedResponse);
    const response = new NodeResponse('body', { status: 200, headers: [['set-cookie', 'a=1; HttpOnly'], ['set-cookie', 'b=2'], ['x-kept', 'yes']] });
    expect(response.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2']);
    expect(response.headers.get('set-cookie')).toBe('a=1; HttpOnly, b=2');
    expect(response.headers.get('x-kept')).toBe('yes');
    expect(await response.text()).toBe('body');
    response.headers.append('set-cookie', 'c=3');
    expect(response.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2', 'c=3']);
    expect(NodeResponse.json({}, { headers: { 'set-cookie': 'j=1' } }).headers.getSetCookie()).toEqual(['j=1']);
    const clone = new NodeResponse('z', { headers: { 'set-cookie': 'k=1' } }).clone();
    expect(clone.headers.getSetCookie()).toEqual(['k=1']);
    expect(new GuardedResponse('p') instanceof NodeResponse).toBe(true);
  });
});
