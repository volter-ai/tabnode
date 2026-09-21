// A synchronous child the runtime cannot start must answer, not wait.
//
// The report this lane started from: the World runtime's `up` hangs in a tab
// with no output, no error and no port. It spawns its twin host, then
// `spawnSync("ps", [...])` for a process census, then
// `spawnSync("openssl", ["version"])`. A tab has neither binary. Before the
// engine had real synchronous children the call answered ENOSYS and the
// World's own code took a fallback from the error; blocking gives it nothing
// to fall back from.
//
// So what is measured here is the whole shape Node answers with for a child
// that never started -- `status` null, `signal` null, a pid, no output at all,
// and an `error` carrying `code`, `errno`, `syscall`, `path` and `spawnargs` --
// and its neighbours: a path that is there and is not a program (EACCES), an
// empty file name (which Node refuses before it spawns anything), and a
// program that ran and failed (a status, and no error at all). The same
// program runs under the host's own `node` and under the engine and the two
// are compared field for field.
//
// The engine is taken from its build, not from its source, because a
// synchronous child runs a second engine on a thread and a thread loads a
// module, not a TypeScript file. `npm run build:lib` before this test.
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const files: Record<string, string> = {
  'failing.js': 'process.stderr.write("bad"); process.exit(3);\n',
  'plain.txt': 'not a program\n',
  'probe.js': [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const notExecutable = path.join(__dirname, 'plain.txt');",
    "fs.chmodSync(notExecutable, 0o644);",
    "const failing = path.join(__dirname, 'failing.js');",
    // The paths a message carries are the tree's, so the two runs are compared
    // with the file each ran on named rather than spelled.
    "const shown = (text) => String(text).split(notExecutable).join('<not-executable>').split(failing).join('<failing>');",
    "const shape = (r) => ({",
    "  keys: Object.keys(r).sort(),",
    "  status: r.status,",
    "  signal: r.signal,",
    "  pidIsNumber: typeof r.pid === 'number',",
    "  stdout: r.stdout === undefined ? 'undefined' : r.stdout === null ? 'null' : String(r.stdout),",
    "  stderr: r.stderr === undefined ? 'undefined' : r.stderr === null ? 'null' : String(r.stderr),",
    "  output: r.output === null ? null : r.output.length,",
    "  error: r.error ? { name: r.error.name, code: r.error.code, errno: r.error.errno, syscall: shown(r.error.syscall), path: shown(r.error.path), spawnargs: r.error.spawnargs, message: shown(r.error.message) } : null,",
    "});",
    "const out = {};",
    "out.missing = shape(cp.spawnSync('definitely-not-a-program-here', ['x']));",
    "out.missingEncoded = shape(cp.spawnSync('definitely-not-a-program-here', ['x'], { encoding: 'utf8' }));",
    "out.notExecutable = shape(cp.spawnSync(notExecutable, ['x']));",
    "try { out.empty = shape(cp.spawnSync('')); } catch (error) { out.empty = { threw: error.code, message: String(error.message) }; }",
    "out.ranAndFailed = shape(cp.spawnSync(process.execPath, [failing]));",
    "try { cp.execFileSync('definitely-not-a-program-here', ['x']); out.execFileThrew = null; } catch (error) {",
    "  out.execFileThrew = { code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, status: error.status, message: String(error.message).split('\\n')[0] };",
    "}",
    "try { cp.execSync('definitely-not-a-program-here x 2>/dev/null'); out.execThrew = null; } catch (error) {",
    "  out.execThrew = { status: error.status, hasStdout: error.stdout !== undefined };",
    "}",
    "console.log('<<' + JSON.stringify(out) + '>>');",
    "",
  ].join('\n'),
};

/** The one printed object the probe leaves behind. */
function printed(text: string, which: string): Record<string, unknown> {
  if (!text.includes('<<')) throw new Error(`${which} printed nothing to read: ${text}`);
  return JSON.parse(text.slice(text.indexOf('<<') + 2, text.lastIndexOf('>>'))) as Record<string, unknown>;
}

/** What Node itself answers for the same program. */
function nodeAnswers(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'sync-child-not-started-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  // A login shell finds node: importing the engine replaces the host's `process`, so its env is not the host's.
  return printed(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'probe.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }), 'node');
}

/** What the engine answers, running the same program over its own tree. */
async function engineAnswers(): Promise<Record<string, unknown>> {
  const built = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(built)) throw new Error('the engine is not built; run `npm run build:lib` before this test');
  const engine = (await import(built.href)) as { VirtualFS: new () => unknown; createContainer: (options: unknown) => { run(command: string, options?: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }> } };
  const vfs = new engine.VirtualFS() as { mkdirSync(path: string, options?: unknown): void; writeFileSync(path: string, data: string): void };
  vfs.mkdirSync('/work', { recursive: true });
  for (const [name, text] of Object.entries(files)) vfs.writeFileSync(`/work/${name}`, text);
  const container = engine.createContainer({ vfs });
  const result = await container.run('node /work/probe.js', { cwd: '/work' });
  return printed(result.stdout, `engine (${result.stderr})`);
}

describe('a synchronous child that never started', () => {
  let node: Record<string, unknown>;
  let engine: Record<string, unknown>;
  beforeAll(async () => {
    node = nodeAnswers();
    engine = await engineAnswers();
  }, 180_000);

  it('answers ENOENT for a program this runtime has no binary for, as Node does', () => {
    expect((engine.missing as { error: { code: string } }).error.code).toBe('ENOENT');
    expect(engine.missing).toEqual(node.missing);
  });

  it('answers the same way whatever encoding was asked for, as Node does', () => {
    expect(engine.missingEncoded).toEqual(node.missingEncoded);
  });

  it('answers EACCES for a path that is there and is not a program, as Node does', () => {
    expect((engine.notExecutable as { error: { code: string } }).error.code).toBe('EACCES');
    expect(engine.notExecutable).toEqual(node.notExecutable);
  });

  it('refuses an empty file name before it spawns anything, as Node does', () => {
    expect(engine.empty).toEqual({ threw: 'ERR_INVALID_ARG_VALUE', message: "The argument 'file' cannot be empty. Received ''" });
    expect(engine.empty).toEqual(node.empty);
  });

  // The other half of the rule: a child that did run and failed is not an
  // error, it is a status. A caller that reads `error` to decide whether the
  // program is there must not see one here.
  it('answers a program that ran and failed with its status and no error, as Node does', () => {
    expect(engine.ranAndFailed).toEqual(node.ranAndFailed);
    expect((engine.ranAndFailed as { error: unknown }).error).toBe(null);
  });

  it('throws that error from `execFileSync`, as Node does', () => {
    expect(engine.execFileThrew).toEqual(node.execFileThrew);
  });

  it('leaves `execSync` of a missing program to the shell, which answers 127, as Node does', () => {
    expect(engine.execThrew).toEqual(node.execThrew);
  });
});
