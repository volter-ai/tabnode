/**
 * `require('timers')` answers Node's `Timeout`, called on the realm.
 *
 * Node's own files take their timers from the module, not from the realm:
 * `lib/_http_server.js` opens with `const { setInterval, clearInterval } =
 * require('timers')` and writes `setInterval(...).unref()` the moment a server
 * listens. The module handed back the realm's raw function, so in a browser --
 * where a timer is a number and a `WorkerGlobalScope` method refuses another
 * receiver -- every guest that called `listen` died with
 * `TypeError: setInterval(...).unref is not a function` at
 * `node:_http_server:530`, openvscode-server among them, and a guest's own
 * `require('timers').setInterval` died with `Illegal invocation`. Measured in
 * the substrate's tab on v0.2.14-volter.60 through the page's shell.
 *
 * A Node host hides both: its timers already answer a `Timeout` and its
 * globals take any receiver, which is why `test-http-*` never saw this. These
 * tests put a browser's timers on the realm for the turn that needs them.
 */
import { describe, expect, it } from 'vitest';
// The engine's own graph first: `public-modules` imported ahead of it leaves
// the shims it pulls in mid-cycle, which is what every hoisted `var` in
// `src/node-lib/` is about.
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { nodeLibPublic } from '../src/node-lib/public-modules';

interface RealmTimers {
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
}

/** The realm's timers as a browser answers them: a number, and only the realm may call them. */
function installBrowserTimers(): () => void {
  const host = globalThis as unknown as Record<string, unknown>;
  const saved = {
    setTimeout: host.setTimeout, setInterval: host.setInterval,
    clearTimeout: host.clearTimeout, clearInterval: host.clearInterval,
  } as unknown as RealmTimers;
  const handles = new Map<number, unknown>();
  let next = 1;
  const own = function (this: unknown): void {
    if (this !== undefined && this !== host) throw new TypeError('Illegal invocation');
  };
  host.setTimeout = function (this: unknown, fn: () => void, ms?: number, ...rest: unknown[]) {
    own.call(this);
    const id = next++;
    handles.set(id, (saved.setTimeout as (...a: never[]) => unknown)(fn as never, ms as never, ...rest as never[]));
    return id;
  };
  host.setInterval = function (this: unknown, fn: () => void, ms?: number, ...rest: unknown[]) {
    own.call(this);
    const id = next++;
    handles.set(id, (saved.setInterval as (...a: never[]) => unknown)(fn as never, ms as never, ...rest as never[]));
    return id;
  };
  host.clearTimeout = function (this: unknown, id: unknown) {
    own.call(this);
    const handle = handles.get(Number(id));
    handles.delete(Number(id));
    return (saved.clearTimeout as (h: never) => void)((handle ?? id) as never);
  };
  host.clearInterval = function (this: unknown, id: unknown) {
    own.call(this);
    const handle = handles.get(Number(id));
    handles.delete(Number(id));
    return (saved.clearInterval as (h: never) => void)((handle ?? id) as never);
  };
  return () => {
    for (const handle of handles.values()) (saved.clearInterval as (h: never) => void)(handle as never);
    Object.assign(host, saved);
  };
}

describe('the timers module where the realm answers a browser’s', () => {
  it('answers Node’s Timeout and takes it back', () => {
    const restore = installBrowserTimers();
    try {
      const timers = (nodeLibPublic('timers') as () => Record<string, (...args: unknown[]) => unknown>)();
      // Called as a method, the way `const { setInterval } = require('timers')`
      // is not but `require('timers').setInterval(...)` is.
      const repeating = timers.setInterval(() => {}, 1_000) as { unref(): unknown; ref(): unknown } | number;
      expect(typeof (repeating as { unref?: unknown }).unref).toBe('function');
      expect((repeating as { unref(): unknown }).unref()).toBe(repeating);
      expect(() => timers.clearInterval(repeating)).not.toThrow();
      const once = timers.setTimeout(() => {}, 1_000) as { unref?: unknown };
      expect(typeof once.unref).toBe('function');
      timers.clearTimeout(once);
      const immediate = timers.setImmediate(() => {}) as { unref?: unknown };
      expect(typeof immediate.unref).toBe('function');
      timers.clearImmediate(immediate);
    } finally {
      restore();
    }
  });

  it('lets a guest’s http server listen, which is where Node’s own file unrefs one', async () => {
    const restore = installBrowserTimers();
    try {
      const vfs = new VirtualFS();
      vfs.mkdirSync('/workspace/app', { recursive: true });
      vfs.writeFileSync('/workspace/app/server.js', `
        const http = require('http');
        const fs = require('fs');
        const server = http.createServer((req, res) => { res.end('ok'); });
        // The listen callback runs after 'listening', which is where Node's
        // own _http_server unrefs its connection-checking interval: the
        // TypeError this test is about happened before the callback did.
        server.listen(8431, () => { fs.writeFileSync('/workspace/app/listened', String(server.address().port)); server.close(); });
      `);
      const runtime = new Runtime(vfs, { cwd: '/workspace/app' });
      await runtime.runFileAsync('/workspace/app/server.js').catch(() => undefined);
      expect(vfs.existsSync('/workspace/app/listened')).toBe(true);
      expect(new TextDecoder().decode(vfs.readFileSync('/workspace/app/listened') as Uint8Array)).toBe('8431');
    } finally {
      restore();
    }
  }, 20_000);
});
