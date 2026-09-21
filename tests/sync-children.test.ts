// A child run to its end before the call returns, as `child_process.spawnSync`
// and `execSync` do in Node, measured against Node itself: the same two
// programs run here and under the real `node`, and the answers are compared
// field for field.
//
// The engine is taken from its build, not from its source, because a
// synchronous child runs a second engine on a thread and a thread loads a
// module, not a TypeScript file. `npm run build:lib` before this test, as
// Node's own suite is run against a build.
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const files: Record<string, string> = {
  // The child: one that prints and ends, one that fails, one that says
  // something only on stderr, and one that ends only after a turn of its own
  // loop — the shape almost every real child has, and the one a caller that
  // cannot block could never wait for.
  'child.js': [
    "const which = process.argv[2];",
    "if (which === 'ok') { console.log('to stdout'); console.error('to stderr'); process.exit(0); }",
    "else if (which === 'fail') { console.log('partial'); console.error('boom'); process.exit(7); }",
    "else if (which === 'stderr') { process.stderr.write('only stderr'); }",
    "else if (which === 'async') { setTimeout(() => { console.log('after a turn'); process.exit(0); }, 20); }",
    "else if (which === 'writes') { require('fs').writeFileSync(process.argv[3], 'written by the child'); }",
    "",
  ].join('\n'),
  'probe.js': [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const child = path.join(__dirname, 'child.js');",
    "const node = process.execPath;",
    "const shape = (r) => ({",
    "  keys: Object.keys(r).sort(),",
    "  status: r.status,",
    "  signal: r.signal,",
    "  pidIsNumber: typeof r.pid === 'number',",
    "  stdout: r.stdout === undefined || r.stdout === null ? String(r.stdout) : String(r.stdout),",
    "  stderr: r.stderr === undefined || r.stderr === null ? String(r.stderr) : String(r.stderr),",
    "  output: r.output === null ? null : { length: r.output.length, first: r.output[0], second: String(r.output[1]) },",
    "  stdoutIsBuffer: Buffer.isBuffer(r.stdout),",
    "  errorCode: r.error ? r.error.code : null,",
    "  errorSyscall: r.error ? r.error.syscall : null,",
    "});",
    "// The paths a message carries are the tree's, so the two runs are compared",
    "// with the node and the directory each ran in named rather than spelled.",
    "const shown = (message) => String(message).split('\\n')[0].split(JSON.stringify(node)).join('\"<node>\"').split(JSON.stringify(child)).join('\"<child>\"').split(node).join('<node>').split(child).join('<child>');",
    "const out = {};",
    "out.ok = shape(cp.spawnSync(node, [child, 'ok']));",
    "out.fail = shape(cp.spawnSync(node, [child, 'fail']));",
    "out.stderrOnly = shape(cp.spawnSync(node, [child, 'stderr']));",
    "out.asyncChild = shape(cp.spawnSync(node, [child, 'async']));",
    "out.encoded = shape(cp.spawnSync(node, [child, 'ok'], { encoding: 'utf8' }));",
    "const line = JSON.stringify(node) + ' ' + JSON.stringify(child);",
    "out.execOk = String(cp.execSync(line + ' ok'));",
    "out.execOkIsBuffer = Buffer.isBuffer(cp.execSync(line + ' ok'));",
    "out.execUtf8 = cp.execSync(line + ' ok', { encoding: 'utf8' });",
    "try { cp.execSync(line + ' fail'); out.threw = null; } catch (e) {",
    "  out.threw = { status: e.status, signal: e.signal, stdout: String(e.stdout), stderr: String(e.stderr), first: shown(e.message), has: ['status','signal','output','pid','stdout','stderr'].filter((k) => k in e) };",
    "}",
    "try { cp.execFileSync(node, [child, 'fail']); out.threwFile = null; } catch (e) {",
    "  out.threwFile = { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr), first: shown(e.message) };",
    "}",
    "out.missing = shape(cp.spawnSync('definitely-not-a-program-here', ['x']));",
    // A child writes where the parent reads a statement later, as two
    // processes over one filesystem do.
    "const note = path.join(__dirname, 'note.txt');",
    "cp.spawnSync(node, [child, 'writes', note]);",
    "out.wrote = fs.readFileSync(note, 'utf8');",
    "console.log('<<' + JSON.stringify(out) + '>>');",
    "",
  ].join('\n'),
};

/** What Node itself answers for the same two programs. */
function nodeAnswers(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'sync-children-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  // A login shell finds node: importing the engine replaces the host's `process`, so its env is not the host's.
  const printed = execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
  return JSON.parse(printed.slice(printed.indexOf('<<') + 2, printed.lastIndexOf('>>'))) as Record<string, unknown>;
}

/** What the engine answers, running the same two programs over its own tree. */
async function engineAnswers(): Promise<Record<string, unknown>> {
  const built = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(built)) throw new Error('the engine is not built; run `npm run build:lib` before this test');
  const engine = (await import(built.href)) as { VirtualFS: new () => unknown; createContainer: (options: unknown) => { run(command: string, options?: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }> } };
  const vfs = new engine.VirtualFS() as { mkdirSync(path: string, options?: unknown): void; writeFileSync(path: string, data: string): void };
  vfs.mkdirSync('/work', { recursive: true });
  for (const [name, text] of Object.entries(files)) vfs.writeFileSync(`/work/${name}`, text);
  const container = engine.createContainer({ vfs });
  const result = await container.run('node /work/probe.js', { cwd: '/work' });
  const printed = result.stdout;
  if (!printed.includes('<<')) throw new Error(`the probe printed nothing to read: ${result.stderr || printed}`);
  return JSON.parse(printed.slice(printed.indexOf('<<') + 2, printed.lastIndexOf('>>'))) as Record<string, unknown>;
}

describe('a synchronous child', () => {
  let node: Record<string, unknown>;
  let engine: Record<string, unknown>;
  beforeAll(async () => {
    node = nodeAnswers();
    engine = await engineAnswers();
  }, 120_000);

  it('answers a child that ended well with its output and status 0, as Node does', () => {
    expect(engine.ok).toEqual(node.ok);
  });

  it('answers a child that failed with its status and both of its streams, as Node does', () => {
    expect(engine.fail).toEqual(node.fail);
  });

  it('answers a child that spoke only on stderr, as Node does', () => {
    expect(engine.stderrOnly).toEqual(node.stderrOnly);
  });

  it('waits for a child that ends only after a turn of its own loop, as Node does', () => {
    expect(engine.asyncChild).toEqual(node.asyncChild);
  });

  it('gives the result the encoding it was asked for, as Node does', () => {
    expect(engine.encoded).toEqual(node.encoded);
  });

  it('gives back `execSync` output as bytes, and as text where text was asked for, as Node does', () => {
    expect([engine.execOk, engine.execOkIsBuffer, engine.execUtf8]).toEqual([node.execOk, node.execOkIsBuffer, node.execUtf8]);
  });

  it('throws from `execSync` on a non-zero status, carrying status, stdout and stderr, as Node does', () => {
    expect(engine.threw).toEqual(node.threw);
  });

  it('throws from `execFileSync` the same way, naming the command it ran, as Node does', () => {
    expect(engine.threwFile).toEqual(node.threwFile);
  });

  it('answers a program it has no command for as absent, as Node answers one that is not on the machine', () => {
    expect(engine.missing).toEqual(node.missing);
  });

  it('lets the parent read what the child wrote, as two processes over one filesystem do', () => {
    expect(engine.wrote).toEqual(node.wrote);
  });
});
