// A module runs under its own name and its own line numbers. Node compiles a
// module from its file behind a one-line wrapper, so a frame of its body names
// the file and counts the file's lines, and a call site of that frame answers
// `getFileName()` with the file. The engine evaluated a module behind a
// sixteen-line header, so every stack a guest printed in the tab read
// `at eval (eval at runModuleBody (.../node-execution-worker.js:84621:17), <anonymous>:96:613)`:
// no file, and a line offset by the header. The `bindings` package — how
// `@vscode/spdlog` and `@vscode/native-watchdog` find their `.node` file —
// reads its caller's `getFileName()` and calls `.indexOf` on it, and
// openvscode-server's extension host died in `TypeError: Cannot read
// properties of undefined (reading 'indexOf') at bindings.getFileName`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { VirtualFS, createContainer } from '../src/index';

// The program's own directory, in the engine's file system and, under the
// name the host gave it, in the host's.
const app = '/work/app';

const programs: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app' }),
  // The throw is this file's own line 3, inside a function the entry calls.
  'lib/thrower.js': '// line 1\nfunction thrower() {\n  throw new Error("named");\n}\nmodule.exports = { thrower };\n',
  'main.js': "const { thrower } = require('./lib/thrower.js');\ntry { thrower(); } catch (e) { console.log(e.stack); }\n",
  // The `bindings` pattern: the call sites a guest reads through
  // `Error.prepareStackTrace` name the file the frame is in.
  'where.js': 'Error.prepareStackTrace = (e, sites) => sites.map((s) => s.getFileName());\nconsole.log(new Error().stack[0]);\n',
  // A module that will not compile at all still says which file it is.
  'lib/broken.js': 'this is not javascript;\nmodule.exports = 1;\n',
  'needs-broken.js': "try { require('./lib/broken.js'); } catch (e) { console.log(String(e.stack).split('\\n')[0]); }\n",
};

let dir: string;
// `Error.prepareStackTrace` is the realm's, and a guest that sets one sets it
// for the realm, as a Node program sets it for its process. On a Node host
// that realm is the test runner's, so what it had is put back after each run.
let hostPrepare: unknown;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'module-stack-')));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  for (const [name, source] of Object.entries(programs)) writeFileSync(join(dir, name), source);
  hostPrepare = (Error as { prepareStackTrace?: unknown }).prepareStackTrace;
});
afterEach(() => {
  (Error as { prepareStackTrace?: unknown }).prepareStackTrace = hostPrepare;
  rmSync(dir, { recursive: true, force: true });
});

/** What Node prints, read as if the program's directory were the engine's. */
function nodePrints(name: string): string {
  const run = spawnSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, name))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
  return run.stdout.split(dir).join(app);
}

async function enginePrints(name: string): Promise<string> {
  const vfs = new VirtualFS();
  vfs.mkdirSync(`${app}/lib`, { recursive: true });
  for (const [file, source] of Object.entries(programs)) vfs.writeFileSync(`${app}/${file}`, source);
  const result = await createContainer({ vfs }).run(`node ${app}/${name}`, { cwd: app });
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

/** The frames of a printed stack that are the guest's own files. */
function guestFrames(stack: string): string[] {
  return stack.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at ') && line.includes(app));
}

describe('a module in a stack', () => {
  it('names its file and the file s own line, as Node does', async () => {
    const seen = await enginePrints('main.js');
    expect(seen).toContain(`${app}/lib/thrower.js:3`);
    expect(guestFrames(seen)[0]).toBe(`at thrower (${app}/lib/thrower.js:3:9)`);
    expect(guestFrames(nodePrints('main.js'))[0]).toBe(`at thrower (${app}/lib/thrower.js:3:9)`);
    // The wrapper is gone from the guest's frames: it named none of them.
    expect(guestFrames(seen).join('\n')).not.toContain('<anonymous>');
  }, 30_000);

  it('answers getFileName() with that file on a prepareStackTrace call site, as Node does', async () => {
    const seen = await enginePrints('where.js');
    expect(seen).toBe(`${app}/where.js\n`);
    expect(nodePrints('where.js')).toBe(seen);
  }, 30_000);

  it('names the file of a module that will not compile, as Node does', async () => {
    const seen = await enginePrints('needs-broken.js');
    expect(seen).toContain(`${app}/lib/broken.js`);
    expect(nodePrints('needs-broken.js')).toContain(`${app}/lib/broken.js`);
  }, 30_000);
});
