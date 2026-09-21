// `process.stdin` is a readable stream on Node, and the engine's was a plain
// object carrying `on` and `pipe`. byline, which Prisma's own code generator
// reads its JSON-RPC requests through, checks `instanceof stream.Readable` and
// throws; so does anything that pipes standard input, iterates it, asks it to
// `read()`, or waits on 'readable' or 'end'. A tab has no terminal, so the
// case this models is Node's pipe: the guest's standard input is what the
// shell put on its fd 0, complete when the guest starts, so the stream carries
// those bytes and then ends -- `printf ... | node probe.js` on the host, and
// `container.run('node probe.js', { stdin })` under the engine, and the
// answers compared field for field.
//
// The engine is taken from its build, not from its source, because standard
// input arrives through the shell's `node` command, which a container run is
// the only way to reach. `npm run build:lib` before this test.
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/** What every probe is given on fd 0. */
const INPUT = '{"jsonrpc":"2.0","method":"getManifest"}\nsecond line\n';

const files: Record<string, string> = {
  // The shape of the thing: what a program sees when it looks at standard
  // input before reading it.
  'shape.js': [
    "const stream = require('stream');",
    "const out = {};",
    "out.isReadable = process.stdin instanceof stream.Readable;",
    "out.readable = process.stdin.readable;",
    "out.notATty = !process.stdin.isTTY;",
    "out.iterable = typeof process.stdin[Symbol.asyncIterator];",
    "for (const name of ['pipe','read','resume','pause','setEncoding','unpipe','isPaused','unshift','on','once','removeListener','destroy']) out[name] = typeof process.stdin[name];",
    "console.log('<<' + JSON.stringify(out) + '>>');",
    "",
  ].join('\n'),
  // Flowing mode: the oldest way to read standard input.
  'flowing.js': [
    "const chunks = [];",
    "process.stdin.on('data', (chunk) => chunks.push(String(chunk)));",
    "process.stdin.on('end', () => { console.log('<<' + JSON.stringify({ read: chunks.join(''), ended: process.stdin.readableEnded }) + '>>'); });",
    "",
  ].join('\n'),
  // Paused mode: 'readable' then `read()`, which is what a parser does.
  'paused.js': [
    "const chunks = [];",
    "process.stdin.on('readable', () => { let chunk; while ((chunk = process.stdin.read()) !== null) chunks.push(String(chunk)); });",
    "process.stdin.on('end', () => { console.log('<<' + JSON.stringify({ read: chunks.join('') }) + '>>'); });",
    "",
  ].join('\n'),
  // `for await (const chunk of process.stdin)`, which a program written today uses.
  'iterated.js': [
    "(async () => {",
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) chunks.push(String(chunk));",
    "  console.log('<<' + JSON.stringify({ read: chunks.join('') }) + '>>');",
    "})();",
    "",
  ].join('\n'),
  // byline's own shape: a Transform subclassed the pre-class way, fed by
  // piping standard input into it. This is the program that died twice.
  'byline.js': [
    "const stream = require('stream');",
    "const util = require('util');",
    "function LineStream(input, options) {",
    "  if (!(input instanceof stream.Readable)) throw new Error('expected a stream.Readable');",
    "  stream.Transform.call(this, options);",
    "  this.rest = '';",
    "  input.pipe(this);",
    "}",
    "util.inherits(LineStream, stream.Transform);",
    "LineStream.prototype._transform = function (chunk, encoding, callback) {",
    "  const text = this.rest + String(chunk);",
    "  const lines = text.split('\\n');",
    "  this.rest = lines.pop();",
    "  for (const line of lines) this.push(line);",
    "  callback();",
    "};",
    "LineStream.prototype._flush = function (callback) { if (this.rest) this.push(this.rest); callback(); };",
    "const lines = [];",
    "const reader = new LineStream(process.stdin, { objectMode: true });",
    "reader.on('data', (line) => lines.push(String(line)));",
    "reader.on('end', () => console.log('<<' + JSON.stringify({ lines }) + '>>'));",
    "",
  ].join('\n'),
};

/** The one printed object a probe leaves behind. */
function printed(text: string, which: string): unknown {
  if (!text.includes('<<')) throw new Error(`${which} printed nothing to read: ${text}`);
  return JSON.parse(text.slice(text.indexOf('<<') + 2, text.lastIndexOf('>>')));
}

/** What Node itself answers for the same programs, with the same bytes on fd 0. */
function nodeAnswers(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'process-stdin-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, 'input'), INPUT);
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(files)) {
    // A login shell finds node: importing the engine replaces the host's `process`, so its env is not the host's.
    const text = execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, name))} < ${JSON.stringify(join(dir, 'input'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
    out[name] = printed(text, `node ${name}`);
  }
  return out;
}

/** What the engine answers, running the same programs with the same bytes on fd 0. */
async function engineAnswers(): Promise<Record<string, unknown>> {
  const built = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(built)) throw new Error('the engine is not built; run `npm run build:lib` before this test');
  const engine = (await import(built.href)) as { VirtualFS: new () => unknown; createContainer: (options: unknown) => { run(command: string, options?: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }> } };
  const vfs = new engine.VirtualFS() as { mkdirSync(path: string, options?: unknown): void; writeFileSync(path: string, data: string): void };
  vfs.mkdirSync('/work', { recursive: true });
  for (const [name, text] of Object.entries(files)) vfs.writeFileSync(`/work/${name}`, text);
  const container = engine.createContainer({ vfs });
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(files)) {
    const result = await container.run(`node /work/${name}`, { cwd: '/work', stdin: INPUT });
    out[name] = printed(result.stdout, `engine ${name}`);
  }
  return out;
}

describe('process.stdin', () => {
  let node: Record<string, unknown>;
  let engine: Record<string, unknown>;
  beforeAll(async () => {
    node = nodeAnswers();
    engine = await engineAnswers();
  }, 180_000);

  it('is a readable stream with a readable stream\'s methods, as Node\'s is', () => {
    expect(engine['shape.js']).toEqual(node['shape.js']);
  });

  it('gives a flowing reader the bytes on fd 0 and then ends, as Node does', () => {
    expect(engine['flowing.js']).toEqual({ read: INPUT, ended: true });
    expect(engine['flowing.js']).toEqual(node['flowing.js']);
  });

  it('gives a paused reader the same bytes through `read()`, as Node does', () => {
    expect(engine['paused.js']).toEqual({ read: INPUT });
    expect(engine['paused.js']).toEqual(node['paused.js']);
  });

  it('is iterable with `for await`, as Node\'s is', () => {
    expect(engine['iterated.js']).toEqual({ read: INPUT });
    expect(engine['iterated.js']).toEqual(node['iterated.js']);
  });

  it('can be piped into a Transform subclassed the pre-class way, which is what byline does', () => {
    expect(engine['byline.js']).toEqual({ lines: ['{"jsonrpc":"2.0","method":"getManifest"}', 'second line'] });
    expect(engine['byline.js']).toEqual(node['byline.js']);
  });
});
