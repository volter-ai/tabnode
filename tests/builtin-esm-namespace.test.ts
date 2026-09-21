// A builtin's ESM namespace carries every key of `module.exports` as a named
// export, and `default` is the module object, as Node builds it. openvscode-server's
// request layer does `(await import("https")).request` and the engine answered
// `r is not a function` because the namespace had no `request`.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Runtime, VirtualFS } from '../src/index';

const DYNAMIC = `
const names = [
  'https', 'fs', 'net', 'path', 'child_process',
  'node:https', 'node:fs', 'node:net', 'node:path', 'node:child_process',
];
const out = {};
for (const name of names) {
  const m = await import(name);
  out[name] = {
    request: typeof m.request,
    readFile: typeof m.readFile,
    connect: typeof m.connect,
    join: typeof m.join,
    fork: typeof m.fork,
    defaultType: typeof m.default,
    defaultIsModule: m.default === (await import(name)).default,
  };
}
export default out;
`;

const NAMED = `
import { request } from 'https';
export default typeof request;
`;

function engineDynamic(): Promise<unknown> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
  vfs.writeFileSync('/work/dyn.mjs', DYNAMIC);
  return new Runtime(vfs, { cwd: '/work' }).runFileAsync('/work/dyn.mjs')
    .then((result) => (result.exports as { default: unknown }).default);
}

function engineNamed(): Promise<unknown> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work', type: 'module' }));
  vfs.writeFileSync('/work/named.mjs', NAMED);
  return new Runtime(vfs, { cwd: '/work' }).runFileAsync('/work/named.mjs')
    .then((result) => (result.exports as { default: unknown }).default);
}

function nodeAnswers(): { dynamic: unknown; named: unknown } {
  const dir = mkdtempSync(join(tmpdir(), 'esm-ns-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'work', type: 'module' }));
  writeFileSync(join(dir, 'dyn.mjs'), DYNAMIC);
  writeFileSync(join(dir, 'named.mjs'), NAMED);
  writeFileSync(join(dir, 'probe.mjs'),
    "const dynamic = (await import('./dyn.mjs')).default;\n"
    + "const named = (await import('./named.mjs')).default;\n"
    + "console.log(JSON.stringify({ dynamic, named }));\n");
  const out = execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.mjs'))}`], {
    encoding: 'utf8',
    env: { HOME: userInfo().homedir },
  });
  return JSON.parse(out.trim()) as { dynamic: unknown; named: unknown };
}

describe("a builtin's ESM namespace", () => {
  it('exposes the module keys as named exports, including request on https', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    const openssl = new Runtime(vfs, { cwd: '/work' }).execute(
      'module.exports = typeof process.versions.openssl;',
      '/work/versions.js',
    ).exports;
    expect(openssl).toBe('string');
    const dynamic = await engineDynamic() as Record<string, Record<string, unknown>>;
    const named = await engineNamed();
    expect(dynamic.https?.request).toBe('function');
    expect(dynamic.fs?.readFile).toBe('function');
    expect(dynamic.net?.connect).toBe('function');
    expect(dynamic.path?.join).toBe('function');
    expect(dynamic.child_process?.fork).toBe('function');
    expect(dynamic['node:https']?.request).toBe('function');
    expect(dynamic['node:fs']?.readFile).toBe('function');
    expect(dynamic['node:net']?.connect).toBe('function');
    expect(dynamic['node:path']?.join).toBe('function');
    expect(dynamic['node:child_process']?.fork).toBe('function');
    expect(named).toBe('function');
    const node = nodeAnswers();
    expect(dynamic.https?.request).toBe((node.dynamic as { https: { request: string } }).https.request);
    expect(named).toBe(node.named);
  });
});
