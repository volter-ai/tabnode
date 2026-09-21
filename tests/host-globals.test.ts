/**
 * The realm belongs to whoever owns the process.
 *
 * Importing the engine's build into a plain Node process used to replace that
 * process's own `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`
 * and `Promise.prototype.then`, swap its `Proxy`, add engine names to its
 * global, and open a `BroadcastChannel` whose `MessagePort` the loop counts —
 * so `node --test` over a file that only imported the engine ran its tests
 * and then hung, and the substrate's gate ran it with `--test-force-exit`.
 *
 * These run the measurement in a child `node`, over the built engine, because
 * that is the case: a host process that imported a library. The vitest realm
 * is not a fair witness — it has already loaded the engine's source.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const engine = path.join(__dirname, '../dist/index.mjs');
const built = fs.existsSync(engine);
const describeBuilt = built ? describe : describe.skip;

/** Run a script in a fresh Node process and answer what it printed. */
function inFreshNode(source: string, args: string[] = []): { stdout: string; stderr: string; status: number | null } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabnode-host-')), 'probe.mjs');
  fs.writeFileSync(file, source.replace(/__ENGINE__/g, JSON.stringify(engine)));
  try {
    const run = spawnSync(process.execPath, [...args, file], { encoding: 'utf8', timeout: 60_000 });
    return { stdout: run.stdout ?? '', stderr: run.stderr ?? '', status: run.signal ? null : run.status };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

describeBuilt('the host keeps its own globals', () => {
  it('importing the engine replaces nothing the host owns', () => {
    const run = inFreshNode(`
      const names = Object.getOwnPropertyNames(globalThis);
      const before = new Map();
      for (const name of names) { try { before.set(name, globalThis[name]); } catch {} }
      const then = Promise.prototype.then;
      const captureStackTrace = Error.captureStackTrace;
      await import(__ENGINE__);
      const changed = [];
      for (const name of names) {
        if (name === 'NaN') continue;
        try { if (before.get(name) !== globalThis[name]) changed.push(name); } catch {}
      }
      const added = Object.getOwnPropertyNames(globalThis).filter(name => !names.includes(name));
      console.log(JSON.stringify({
        changed,
        added,
        then: then === Promise.prototype.then,
        captureStackTrace: captureStackTrace === Error.captureStackTrace,
      }));
      process.exit(0);
    `);
    expect(run.stderr).toBe('');
    const seen = JSON.parse(run.stdout.trim());
    expect(seen.changed).toEqual([]);
    expect(seen.added).toEqual([]);
    expect(seen.then).toBe(true);
    expect(seen.captureStackTrace).toBe(true);
  });

  it('importing the engine opens no handle the host must wait on', () => {
    // The baseline is a Node builtin, not an empty process: loading `node:util`
    // materialises the host's own stderr, a `PipeWrap`, whenever stdio is a
    // pipe. That handle is the host's and Node's, and it is what the engine's
    // import is measured against — what the engine must add is nothing.
    const run = inFreshNode(`
      await import('node:util');
      const before = process.getActiveResourcesInfo();
      await import(__ENGINE__);
      console.log(JSON.stringify({ before, after: process.getActiveResourcesInfo() }));
      process.exit(0);
    `);
    const seen = JSON.parse(run.stdout.trim());
    expect(seen.after).toEqual(seen.before);
  });

  it('a host process that imported the engine exits on its own', () => {
    const run = inFreshNode(`
      await import(__ENGINE__);
      console.log('done');
    `);
    expect(run.stdout.trim()).toBe('done');
    expect(run.status).toBe(0);
  });

  it('a callback the host scheduled still sees the host process', () => {
    const run = inFreshNode(`
      await import(__ENGINE__);
      setTimeout(() => {
        try {
          process.kill(process.pid, 0);
          console.log(JSON.stringify({ pid: process.pid, exit: typeof process.exit, kill: 'ok' }));
        } catch (error) {
          console.log(JSON.stringify({ kill: String(error && error.message) }));
        }
        process.exit(0);
      }, 1);
    `);
    const seen = JSON.parse(run.stdout.trim());
    expect(seen.kill).toBe('ok');
    expect(seen.pid).toBeGreaterThan(0);
    expect(seen.exit).toBe('function');
  });

  // Import was the first half of the rule; use is the second. A bridge is
  // built the moment a container exists, and it opened a `BroadcastChannel`
  // for the guest's virtual websockets that it neither stored nor closed —
  // one referenced `MessagePort`, enough that a host which called
  // `createContainer()` and nothing else never reached `beforeExit`, and that
  // the substrate's `verify:pnpm-workspace` had to run with
  // `--test-force-exit`.
  it('a host process that created a container and ran a guest exits on its own', () => {
    const run = inFreshNode(`
      const engine = await import(__ENGINE__);
      const container = engine.createContainer();
      console.log(container.execute('module.exports = 1 + 1').exports);
    `);
    // `inFreshNode` reports a killed child as status null, so a process that
    // had to be timed out fails here: a host that cannot exit is the defect.
    expect(run.stdout.trim()).toBe('2');
    expect(run.status).toBe(0);
  });

  it('creating a container opens no handle the host must wait on', () => {
    // `node:process` by name: a container installs the guest's realm, and
    // `globalThis.process` is then the guest's, whose `exit` only records a
    // code. The host's own handles are read off the host's own process.
    const run = inFreshNode(`
      import nodeProcess from 'node:process';
      await import('node:util');
      const engine = await import(__ENGINE__);
      const before = nodeProcess.getActiveResourcesInfo();
      const container = engine.createContainer();
      container.execute('module.exports = 1 + 1');
      console.log(JSON.stringify({ before, after: nodeProcess.getActiveResourcesInfo() }));
      nodeProcess.exit(0);
    `);
    expect(run.stderr).toBe('');
    const seen = JSON.parse(run.stdout.trim());
    expect(seen.after).toEqual(seen.before);
  });

  it('node --test over a file that creates a container exits without --test-force-exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnode-node-test-container-'));
    const file = path.join(dir, 'container.test.mjs');
    fs.writeFileSync(file, [
      `import test from 'node:test';`,
      `import assert from 'node:assert';`,
      `import * as engine from ${JSON.stringify(engine)};`,
      `test('a guest runs', () => { assert.equal(engine.createContainer().execute('module.exports = 1 + 1').exports, 2); });`,
      '',
    ].join('\n'));
    try {
      const run = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 60_000 });
      expect(run.signal).toBe(null);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('pass 1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('node --test over a file that imports the engine exits without --test-force-exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnode-node-test-'));
    const file = path.join(dir, 'engine.test.mjs');
    fs.writeFileSync(file, [
      `import test from 'node:test';`,
      `import assert from 'node:assert';`,
      `import * as engine from ${JSON.stringify(engine)};`,
      `test('the engine imports', () => { assert.equal(typeof engine.createContainer, 'function'); });`,
      '',
    ].join('\n'));
    try {
      const run = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 60_000 });
      expect(run.signal).toBe(null);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('pass 1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeBuilt('a runtime installs what a guest needs, and hands it back', () => {
  it('the corrections a guest reads through the realm arrive with the first runtime', () => {
    const run = inFreshNode(`
      const engine = await import(__ENGINE__);
      const before = {
        Request: globalThis.Request,
        TextDecoder: globalThis.TextDecoder,
        Proxy: globalThis.Proxy,
        setTimeout: globalThis.setTimeout,
        then: Promise.prototype.then,
      };
      const container = engine.createContainer();
      const after = {
        Request: globalThis.Request,
        TextDecoder: globalThis.TextDecoder,
        Proxy: globalThis.Proxy,
        setTimeout: globalThis.setTimeout,
        then: Promise.prototype.then,
      };
      const patched = Object.keys(before).filter(name => before[name] !== after[name]).sort();
      engine.restoreHostGlobals();
      const restored = Object.keys(before).filter(name => before[name] !== (name === 'then' ? Promise.prototype.then : globalThis[name])).sort();
      console.log(JSON.stringify({
        patched,
        restored,
        heldWork: '__browserRuntimeHeldWork' in globalThis,
        ran: container.execute('module.exports = 1 + 1').exports,
      }));
      process.exit(0);
    `);
    const seen = JSON.parse(run.stdout.trim());
    // What a guest can only reach through the realm: a constructor it reads by
    // bare name, and the store-carrying continuations. Nothing else.
    expect(seen.patched).toEqual(['Proxy', 'Request', 'TextDecoder', 'setTimeout', 'then']);
    expect(seen.restored).toEqual([]);
    expect(seen.heldWork).toBe(false);
    expect(seen.ran).toBe(2);
  });

  it("a guest's timers answer Node's Timeout, and the host's still answer the host's", () => {
    const run = inFreshNode(`
      const engine = await import(__ENGINE__);
      const container = engine.createContainer();
      const guest = container.execute([
        'const timer = setTimeout(() => {}, 50);',
        'const shape = { unref: typeof timer.unref, refresh: typeof timer.refresh, hasRef: typeof timer.hasRef };',
        'clearTimeout(timer);',
        'module.exports = shape;',
      ].join('\\n')).exports;
      // The realm's own timer is wrapped to carry a store, which is a guest's
      // correction the realm cannot avoid; what it still answers is Node's own
      // Timeout, not the engine's stand-in for one.
      const hostTimer = setTimeout(() => {}, 50);
      const host = { name: hostTimer.constructor.name, engineShape: '_id' in hostTimer };
      clearTimeout(hostTimer);
      console.log(JSON.stringify({ guest, host }));
      process.exit(0);
    `);
    const seen = JSON.parse(run.stdout.trim());
    expect(seen.guest).toEqual({ unref: 'function', refresh: 'function', hasRef: 'function' });
    expect(seen.host).toEqual({ name: 'Timeout', engineShape: false });
  });
});

describeBuilt("the engine's own build", () => {
  it('opens no BroadcastChannel at module scope', () => {
    const source = fs.readFileSync(engine, 'utf8');
    const lines = source.split('\n');
    const opened = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(entry => entry.line.startsWith('messageChannel = new BroadcastChannel'));
    // The one construction left is inside `wsChannel()`, which a websocket
    // calls; none of them is at the top level of the module.
    expect(opened.length).toBeGreaterThan(0);
    for (const entry of opened) expect(lines[entry.index].startsWith('    ')).toBe(true);
  });
});
