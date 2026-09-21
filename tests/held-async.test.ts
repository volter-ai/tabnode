// A guest waiting on work the host is doing for it is not finished. Node keeps
// a process alive for an outstanding request, not for a promise: an awaited
// compile keeps it alive, a promise that never settles does not. The engine
// counted a guest's timers and its own held work but never the host work a
// guest awaited, so `await WebAssembly.instantiate(bytes)` — the shape every
// one of Node's WASI tests and every napi-rs wasm loader is written in — was
// ended mid-await and the line after it never ran.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import createContainer from '../src/index';
import { VirtualFS } from '../src/virtual-fs';

/** A module that exports nothing, the smallest thing WebAssembly will compile. */
const MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

const AWAITED = [
  "const bytes = new Uint8Array([0,97,115,109,1,0,0,0]);",
  "(async () => {",
  "  const one = await WebAssembly.compile(bytes);",
  "  console.log('COMPILED ' + (one instanceof WebAssembly.Module));",
  "  const two = await WebAssembly.instantiate(bytes, {});",
  "  console.log('INSTANTIATED ' + (two.instance instanceof WebAssembly.Instance));",
  "})();",
].join('\n');

/** The same program under real Node. */
function fromNode(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'held-'));
  writeFileSync(join(dir, 'p.js'), source);
  return execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'p.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
}

async function inTab(source: string): Promise<{ stdout: string; exitCode: number }> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/app', { recursive: true });
  vfs.writeFileSync('/app/p.js', source);
  const container = createContainer({ vfs });
  let stdout = '';
  const result = await container.run('node /app/p.js', { cwd: '/app', onStdout: (text: string) => { stdout += text; } });
  return { stdout, exitCode: result.exitCode };
}

describe('a guest waiting on the host', () => {
  it('runs what follows an awaited compile and instantiate, as Node does', async () => {
    const answer = await inTab(AWAITED);
    expect(answer.stdout, `exit ${answer.exitCode}`).toContain('COMPILED true');
    expect(answer.stdout).toContain('INSTANTIATED true');
    expect(fromNode(AWAITED)).toBe('COMPILED true\nINSTANTIATED true\n');
  }, 30_000);

  it('still ends a program that waits on a promise nothing settles, as Node ends one', async () => {
    const answer = await inTab("console.log('BEFORE');\nnew Promise(() => {}).then(() => console.log('NEVER'));\n");
    expect(answer.stdout).toContain('BEFORE');
    expect(answer.stdout).not.toContain('NEVER');
    expect(fromNode("console.log('BEFORE');\nnew Promise(() => {}).then(() => console.log('NEVER'));\n")).toBe('BEFORE\n');
  }, 30_000);

  it('leaves the host namespace itself untouched: the synchronous constructors are the host s own', async () => {
    const answer = await inTab([
      "const bytes = new Uint8Array([0,97,115,109,1,0,0,0]);",
      "const module = new WebAssembly.Module(bytes);",
      "console.log('SYNC ' + (module instanceof WebAssembly.Module) + ' ' + WebAssembly.validate(bytes) + ' ' + (typeof WebAssembly.Memory));",
    ].join('\n'));
    expect(answer.stdout).toContain('SYNC true true function');
  }, 30_000);
});

// The bytes above are the module a compile is given; kept beside them so a
// reader can see the two agree.
if (MODULE.length !== 8) throw new Error('the smallest module is eight bytes');
