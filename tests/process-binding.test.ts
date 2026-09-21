// `process.binding` is a function on Node, deprecated and still there, and a
// bundle that feature-detects through it calls it before anything public. The
// engine had none, so the call was a TypeError. What it answers for
// `constants` is the engine's own table, grouped the way Node's binding
// groups it, and every other name is the error Node raises.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { Runtime, VirtualFS } from '../src/index';

function guest(): (body: string) => unknown {
  const fs = new VirtualFS();
  fs.mkdirSync('/g', { recursive: true });
  const runtime = new Runtime(fs, { cwd: '/g' });
  return (body: string) => runtime.execute(`module.exports = (() => { ${body} })();`, '/g/main.cjs').exports;
}

/** What Node itself answers, run through a login shell so it is the host's node. */
function node(body: string, flags = ''): unknown {
  // One line: the body crosses a shell, where a newline inside the quoted
  // program is a line of its own.
  const one = body.split('\n').map((line) => line.trim()).join(' ');
  const out = execFileSync('/bin/sh', ['-lc', `node ${flags} -e ${JSON.stringify(`Promise.resolve((() => { ${one} })()).then((value) => console.log(JSON.stringify(value)))`)}`], {
    encoding: 'utf8',
    env: { HOME: userInfo().homedir },
  });
  return JSON.parse(out.trim());
}

describe('process.binding', () => {
  it('is a function, where the engine had nothing to call', () => {
    expect(guest()('return typeof process.binding')).toBe('function');
    expect(node('return typeof process.binding')).toBe('function');
  });

  it('hands out the same constants object every time, as Node does', () => {
    expect(guest()('return process.binding("constants") === process.binding("constants")')).toBe(true);
    expect(node('return process.binding("constants") === process.binding("constants")')).toBe(true);
  });

  it('groups the constants the way Node groups them', () => {
    const body = 'return Object.keys(process.binding("constants")).sort()';
    const engine = guest()(body) as string[];
    const host = node(body) as string[];
    expect(engine).toEqual(['crypto', 'fs', 'os', 'trace', 'zlib']);
    // Node's own list is this one, and whatever newer Node added beside it.
    for (const group of engine) expect(host).toContain(group);
  });

  it('names the same members of the os group Node names', () => {
    const body = 'return Object.keys(process.binding("constants").os).sort()';
    expect(guest()(body)).toEqual(['UV_UDP_REUSEADDR', 'dlopen', 'errno', 'priority', 'signals']);
    expect(node(body)).toEqual(['UV_UDP_REUSEADDR', 'dlopen', 'errno', 'priority', 'signals']);
  });

  it('carries Node\'s trace-event phases', () => {
    const body = 'return process.binding("constants").trace';
    expect(guest()(body)).toEqual(node(body));
  });

  // Node builds `lib/constants.js` by spreading the binding's groups flat, so
  // the two can never disagree. The engine's flat table is the source the
  // groups are read back out of, which is the same guarantee from the other
  // end: measured here as the property Node holds.
  it('names the extensionless format flags Node names, which match E[A-Z]+ in the gate', () => {
    const body = 'return { js: require("constants").EXTENSIONLESS_FORMAT_JAVASCRIPT, wasm: require("constants").EXTENSIONLESS_FORMAT_WASM }';
    expect(guest()(body)).toEqual({ js: 0, wasm: 1 });
    expect(node(body)).toEqual({ js: 0, wasm: 1 });
  });

  it('agrees with require("constants") name for name, as Node does', () => {
    const body = `
      const binding = process.binding("constants");
      const flat = require("constants");
      const groups = [binding.os.dlopen, binding.os.errno, binding.os.priority, binding.os.signals, binding.fs];
      const wrong = [];
      for (const [name, value] of Object.entries(flat)) {
        const holder = groups.find((group) => name in group);
        if (!holder) { if (!(name in binding.crypto)) wrong.push(name + ": in no group"); continue; }
        if (holder[name] !== value) wrong.push(name + ": " + holder[name] + " != " + value);
      }
      return wrong;
    `;
    expect(guest()(body)).toEqual([]);
    expect(node(body)).toEqual([]);
  });

  it('refuses a binding it cannot back with the error Node raises', () => {
    const body = 'try { process.binding("not-a-binding"); return "no throw"; } catch (error) { return [error.name, error.message, error.code ?? null]; }';
    expect(guest()(body)).toEqual(['Error', 'No such module: not-a-binding', null]);
    expect(node(body)).toEqual(['Error', 'No such module: not-a-binding', null]);
  });

  const warnings = 'const seen = []; process.on("warning", (w) => seen.push(w.code)); process.binding("constants"); process.binding("constants"); return new Promise((resolve) => setTimeout(() => resolve(seen), 20));';

  it('prints no deprecation warning unless the program asked for pending ones, as Node does', async () => {
    expect(await guest()(warnings)).toEqual([]);
    expect(node(warnings)).toEqual([]);
  });

  // Node raises DEP0111 only under `--pending-deprecation`, and once. The
  // engine reads the same flag off `process.execArgv`, which the `node`
  // command does not yet fill from its own options, so a guest that sets it
  // is how the branch is reached today.
  it('raises DEP0111 once for a program that asked for pending deprecations, as Node does', async () => {
    expect(await guest()(`process.execArgv = ["--pending-deprecation"]; ${warnings}`)).toEqual(['DEP0111']);
    expect(node(warnings, '--pending-deprecation')).toEqual(['DEP0111']);
  });
});
