// A response keeps the Set-Cookie headers it was built with, as Node's does.
// A browser's `Response` applies the fetch specification's response guard and
// drops them silently, so every server that answers with a web Response
// (Next's route handlers, NextAuth's sign-in among them) lost its cookies in
// a tab. The test process is Node, whose own Response already keeps them, so
// the realm is first given a Response with the browser's guard; the program
// below must then read, under the engine, exactly what Node reads.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import createContainer from '../src/index';
import { VirtualFS } from '../src/virtual-fs';
import { restoreHostGlobals } from '../src/host-globals';

const PROGRAM = [
  "const built = new Response('body', { status: 201, headers: [['set-cookie', 'a=1; Path=/; HttpOnly'], ['set-cookie', 'b=2, c; Max-Age=60'], ['content-type', 'text/plain']] });",
  "built.headers.append('set-cookie', 'd=4');",
  "class Framework extends Response { static json(data, init) { const r = super.json(data, init); return new Framework(r.body, r); } }",
  "const sub = new Framework(null, { status: 302, headers: { location: '/me', 'set-cookie': 'sid=s' } });",
  "sub.headers.append('set-cookie', 'later=1');",
  "const fjson = Framework.json({ ok: 1 }, { headers: { 'set-cookie': 'fj=1' } });",
  "const json = Response.json({ ok: true }, { headers: { 'set-cookie': 'j=1' } });",
  "const copy = built.clone();",
  "function* pairs() { yield ['set-cookie', 'g=1']; }",
  "const generated = new Response(null, { headers: pairs() });",
  "const legacy = new Response(null, { headers: { 'set-cookie2': 'z=1' } });",
  "const form = new Response('a=1&b=2'); form.headers.set('content-type', 'application/x-www-form-urlencoded');",
  "const redirect = Response.redirect('http://x.test/y', 307);",
  "let redirectMutable = true; try { redirect.headers.set('x', '1'); } catch { redirectMutable = false; }",
  "const error = Response.error();",
  "(async () => {",
  "  const formEntries = [...(await form.formData()).entries()];",
  "  console.log(JSON.stringify({",
  "    cookies: built.headers.getSetCookie(),",
  "    joined: built.headers.get('set-cookie'),",
  "    entries: [...built.headers].filter(([name]) => name === 'set-cookie').length,",
  "    status: built.status,",
  "    sub: sub.headers.getSetCookie(), subLocation: sub.headers.get('location'), subIsFramework: sub instanceof Framework, subIsResponse: sub instanceof Response,",
  "    fjson: fjson.headers.getSetCookie(), fjsonIsFramework: fjson instanceof Framework,",
  "    json: json.headers.getSetCookie(), jsonType: json.headers.get('content-type'), jsonIsResponse: json instanceof Response,",
  "    copy: copy.headers.getSetCookie(), copyStatus: copy.status, copyBody: await copy.text(), builtBody: await built.text(),",
  "    generated: generated.headers.getSetCookie(),",
  "    legacy: legacy.headers.get('set-cookie2'),",
  "    formEntries,",
  "    redirect: redirect.headers.get('location'), redirectMutable,",
  "    errorIsResponse: error instanceof Response, errorIsFramework: error instanceof Framework, errorType: error.type,",
  "    constructorIsResponse: error.constructor === Response, prototypeIsResponse: Object.getPrototypeOf(error) === Response.prototype,",
  "    name: Response.name, length: Response.length,",
  "  }));",
  "})();",
].join('\n');

function fromNode(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'resp-'));
  writeFileSync(join(dir, 'p.js'), PROGRAM);
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'p.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

const GUARDED = new Set(['set-cookie', 'set-cookie2']);

/** Headers under the fetch specification's "response" guard: the cookie names are dropped, at construction and after. */
class GuardedHeaders extends Headers {
  constructor(init?: HeadersInit) {
    super();
    new Headers(init).forEach((value, name) => { if (!GUARDED.has(name)) super.append(name, value); });
  }
  append(name: string, value: string): void { if (!GUARDED.has(name.toLowerCase())) super.append(name, value); }
  set(name: string, value: string): void { if (!GUARDED.has(name.toLowerCase())) super.set(name, value); }
}

/** A browser's `Response`, as far as its response guard goes. */
function guardedResponse(Undici: typeof Response): typeof Response {
  const guarded = new WeakMap<object, Headers>();
  // A redirect's and an error's headers are immutable, the platform's own, as a browser's are.
  const immutable = new WeakSet<object>();
  const platform = (response: Response): Response => { immutable.add(response); return Object.setPrototypeOf(response, GuardedResponse.prototype); };
  const own = Object.getOwnPropertyDescriptor(Undici.prototype, 'headers')!.get!;
  class GuardedResponse extends Undici {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init === undefined ? undefined : { ...init, headers: new GuardedHeaders(init.headers) });
    }
    get headers(): Headers {
      if (immutable.has(this)) return own.call(this) as Headers;
      let headers = guarded.get(this);
      if (!headers) { headers = new GuardedHeaders(own.call(this) as Headers); guarded.set(this, headers); }
      return headers;
    }
    // A browser's statics and clone answer its own class's instances; undici's answer undici's.
    static error(): Response { return platform(Undici.error()); }
    static redirect(url: string | URL, status?: number): Response { return platform(Undici.redirect(url, status)); }
    clone(): Response { return Object.setPrototypeOf(super.clone(), GuardedResponse.prototype); }
    static json(data: unknown, init?: ResponseInit): Response {
      return new GuardedResponse(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(() => { const out: Record<string, string> = {}; new GuardedHeaders(init?.headers).forEach((value, name) => { out[name] = value; }); return out; })() } });
    }
  }
  return GuardedResponse;
}

const undici = globalThis.Response;
afterEach(() => {
  restoreHostGlobals();
  globalThis.Response = undici;
});

async function inEngine(): Promise<Record<string, unknown>> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/app', { recursive: true });
  vfs.writeFileSync('/app/p.js', PROGRAM);
  let stdout = '';
  const result = await createContainer({ vfs }).run('node /app/p.js', { cwd: '/app', onStdout: (text: string) => { stdout += text; } });
  expect(result.exitCode, stdout).toBe(0);
  return JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
}

describe('a web Response built by a guest', () => {
  it('reads as Node reads it, over a realm whose Response has the browser\'s guard', async () => {
    restoreHostGlobals();
    const Guarded = guardedResponse(undici);
    expect(new Guarded('', { headers: { 'set-cookie': 'a=1' } }).headers.getSetCookie()).toEqual([]);
    globalThis.Response = Guarded;
    const seen = await inEngine();
    const node = fromNode() as Record<string, unknown>;
    // The stand-in guards the cookies; it is not a browser in the rest (its
    // redirect and error are undici's), so those are compared against Node too.
    expect(seen).toEqual(node);
    expect(seen.cookies).toEqual(['a=1; Path=/; HttpOnly', 'b=2, c; Max-Age=60', 'd=4']);
    expect(seen.sub).toEqual(['sid=s', 'later=1']);
    expect(seen.formEntries).toEqual([['a', '1'], ['b', '2']]);
  }, 30_000);
});
