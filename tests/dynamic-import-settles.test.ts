import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { createContainer } from '../src/index';

async function runFile(files: Record<string, string>, entry: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/app/node_modules/dep', { recursive: true });
  vfs.writeFileSync('/app/node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }));
  vfs.writeFileSync('/app/node_modules/dep/index.js', 'module.exports = { answer: 42 };\n');
  for (const [name, text] of Object.entries(files)) vfs.writeFileSync(`/app/${name}`, text);
  const container = createContainer({ vfs });
  let stdout = '', stderr = '';
  const result = await container.run(`node /app/${entry}`, { cwd: '/app', onStdout: (t) => { stdout += t; }, onStderr: (t) => { stderr += t; } });
  return { stdout: stdout || result.stdout, stderr: stderr || result.stderr, exitCode: result.exitCode };
}

describe('a dynamic import from a guest file settles, as in Node', () => {
  it('resolves a bare package name from a .mjs file', async () => {
    const r = await runFile({ 'a.mjs': 'import("dep").then((m) => console.log("OK", m.default.answer), (e) => console.log("FAIL", e.message));\n' }, 'a.mjs');
    expect(r.stdout).toContain('OK 42');
  }, 30_000);
  it('resolves a bare package name from a .cjs file', async () => {
    const r = await runFile({ 'a.cjs': 'import("dep").then((m) => console.log("OK", m.default.answer), (e) => console.log("FAIL", e.message));\n' }, 'a.cjs');
    expect(r.stdout).toContain('OK 42');
  }, 30_000);
  it('resolves a file: URL of a CommonJS file', async () => {
    const r = await runFile({ 'a.cjs': 'const u = require("url").pathToFileURL("/app/node_modules/dep/index.js").toString(); import(u).then((m) => console.log("OK", m.default.answer), (e) => console.log("FAIL", e.message));\n' }, 'a.cjs');
    expect(r.stdout).toContain('OK 42');
  }, 30_000);
});
