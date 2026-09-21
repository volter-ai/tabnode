/**
 * A vendored Node file that `require`s a public name the engine still serves
 * as a shim -- `tls`, `crypto`, `util/types`, `assert/strict` -- must get
 * that module, the way it already got `util` and `path`.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

function guest() {
  const fs = new VirtualFS();
  fs.mkdirSync('/g', { recursive: true });
  const runtime = new Runtime(fs, { cwd: '/g' });
  return (body: string) => runtime.execute(`module.exports = (() => { ${body} })();`, '/g/main.cjs').exports;
}

describe('vendored files reach the engine shims by public name', () => {
  it('answers tls, dns, crypto, vm, worker_threads, dgram, http2, cluster, inspector, perf_hooks, v8', () => {
    const run = guest();
    expect(run(`
      return {
        tls: typeof require('tls').createServer,
        dns: typeof require('dns').lookup,
        crypto: typeof require('crypto').createHash,
        vm: typeof require('vm').runInNewContext,
        worker: typeof require('worker_threads').isMainThread,
        dgram: typeof require('dgram').createSocket,
        http2: typeof require('http2').connect,
        cluster: typeof require('cluster').fork,
        inspector: typeof require('inspector').Session,
        perf: typeof require('perf_hooks').performance,
        v8: typeof require('v8').serialize,
      };
    `)).toEqual({
      tls: 'function', dns: 'function', crypto: 'function', vm: 'function',
      worker: 'boolean', dgram: 'function', http2: 'function', cluster: 'function',
      inspector: 'function', perf: 'object', v8: 'function',
    });
  });

  it("maps util/types to internal/util/types, as cp.js requires", () => {
    const run = guest();
    expect(run(`
      const types = require('util/types');
      const internal = require('internal/util/types');
      return { same: types === internal, map: types.isMap(new Map()), date: types.isDate(new Date()) };
    `)).toEqual({ same: true, map: true, date: true });
  });

  it('answers assert/strict as Node\'s own file, which is assert.strict', () => {
    const run = guest();
    expect(run(`
      const strict = require('assert/strict');
      const assert = require('assert');
      const threw = (() => { try { strict.equal(1, '1'); return false; } catch (e) { return e.name; } })();
      return { same: strict === assert.strict, threw };
    `)).toEqual({ same: true, threw: 'AssertionError' });
  });
});
