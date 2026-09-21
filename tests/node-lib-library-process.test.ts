/**
 * A vendored Node file compiles where the realm has no `process`.
 *
 * Node compiles a builtin inside a bootstrapped process and Node's own files
 * read that process while they compile: `internal/util` reads
 * `process.versions.openssl` and `process.versions.amaro` at its top and
 * `process.platform` two lines later. The engine compiles Node's `net.js`
 * while its own bundle is still evaluating, `net` requires `events` and
 * `events` requires `internal/util`, so in a realm that has no `process`
 * global -- a browser page or worker, the engine loaded as a library -- the
 * whole engine failed to import with `TypeError: Cannot read properties of
 * undefined (reading 'openssl')`, measured in the substrate's execution
 * worker on v0.2.14-volter.59.
 */
import { describe, expect, it } from 'vitest';
import { loadNodeLibInstance, nodeLibProcessOf } from '../src/node-lib/load';
import { NODE_LTS_VERSION } from '../src/node-lib/node-versions';

/** Everything inside runs in one synchronous turn: nothing else may observe the realm without its process. */
function withoutRealmProcess<T>(body: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'process');
  Reflect.deleteProperty(globalThis, 'process');
  try {
    return body();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'process', saved);
  }
}

describe('a vendored file compiled where the realm has no process', () => {
  it('is handed Node’s own static facts rather than undefined', () => {
    const seen = withoutRealmProcess(() => {
      const process = nodeLibProcessOf();
      return {
        versions: process.versions as Record<string, string>,
        platform: process.platform,
        version: process.version,
        nextTick: typeof process.nextTick,
        has: 'versions' in process,
      };
    });
    expect(seen.versions.node).toBe(NODE_LTS_VERSION);
    expect(seen.platform).toBe('linux');
    expect(seen.version).toBe(`v${NODE_LTS_VERSION}`);
    expect(seen.nextTick).toBe('function');
    expect(seen.has).toBe(true);
  });

  it('compiles internal/util, which reads that process as it compiles', () => {
    // `isWindows` and `isMacOS` are `process.platform` read at compile time:
    // both false says the file read the library process, not this host's own
    // (these tests run on darwin).
    const util = withoutRealmProcess(() => loadNodeLibInstance('internal/util') as Record<string, unknown>);
    expect(typeof util.getSystemErrorName).toBe('function');
    expect(util.isWindows).toBe(false);
    expect(util.isMacOS).toBe(false);
  });

  it('compiles net, the file the engine loads while its own bundle evaluates', () => {
    const net = withoutRealmProcess(() => loadNodeLibInstance('net') as Record<string, unknown>);
    expect(typeof net.Socket).toBe('function');
    expect(typeof net.createServer).toBe('function');
  });
});
