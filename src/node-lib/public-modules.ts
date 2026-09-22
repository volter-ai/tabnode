/**
 * The public modules a vendored Node file names.
 *
 * Node's own files `require('dns')`, `require('timers')` and the rest as any
 * program does, and get the runtime's modules. Here they get the engine's
 * shims — the same objects the engine's module table hands a guest — so a
 * `net.Socket` is a `stream.Duplex` of the same `stream` the guest imports,
 * and an `instanceof` across the two holds. A name that is itself a vendored
 * file — `events`, `util`, `buffer`, `stream` — is never asked of this table:
 * the loader finds the file first.
 *
 * Each entry is a thunk: the shim is read when a vendored file asks, not when
 * this module is loaded, so a cycle between a shim and the loader settles
 * before either is used.
 */
import * as dnsShim from '../shims/dns';
import * as clusterShim from '../shims/cluster';
import * as dgramShim from '../shims/dgram';
import asyncHooksShim from '../shims/async_hooks';
import stringDecoderShim, { createStringDecoderModule } from '../shims/string_decoder';
import v8Shim from '../shims/v8';
import * as pathShim from '../shims/path';
import * as tlsShim from '../shims/tls';
import * as cryptoShim from '../shims/crypto';
import * as vmShim from '../shims/vm';
import * as workerThreadsShim from '../shims/worker_threads';
import * as http2Shim from '../shims/http2';
import * as inspectorShim from '../shims/inspector';
import * as perfHooksShim from '../shims/perf_hooks';
import { nodeLibInternalRequire } from './load';
import { nodeTimeout, timerHandleOf } from './timers';
import { AsyncResource } from './internals/runtime';

/**
 * `timers`: the realm's own, called on the realm and answering Node's shape.
 *
 * This is the module Node's own files take their timers from --
 * `_http_server.js` opens with `const { setInterval, clearInterval } =
 * require('timers')` and then writes `setInterval(...).unref()` the moment a
 * server listens -- so what it answers has to be Node's `Timeout`
 * ({@link nodeTimeout}), not a browser's number. It handed back the realm's
 * raw function, and in the tab every guest that called `listen` died with
 * `setInterval(...).unref is not a function`, openvscode-server among them.
 * The function is also called on the realm here: a worker's `setInterval`
 * invoked with this module as its receiver throws `Illegal invocation`, which
 * is what a guest's own `require('timers').setInterval` did.
 *
 * A guest's global timers are the same shape, built per run in
 * `src/runtime.ts` where they are counted against that run's loop; a timer
 * made through either is cleared through either, which is why the shape has
 * one home.
 */
const timersModule = {
  setTimeout(fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) {
    return nodeTimeout(globalThis.setTimeout(fn as () => void, ms, ...rest));
  },
  clearTimeout(id: unknown) { return globalThis.clearTimeout(timerHandleOf(id) as number); },
  setInterval(fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) {
    return nodeTimeout(globalThis.setInterval(fn as () => void, ms, ...rest));
  },
  clearInterval(id: unknown) { return globalThis.clearInterval(timerHandleOf(id) as number); },
  setImmediate(fn: (...a: unknown[]) => void, ...args: unknown[]) {
    const realm = globalThis as unknown as { setImmediate?: (fn: (...a: unknown[]) => void, ...args: unknown[]) => unknown };
    return nodeTimeout(realm.setImmediate
      ? realm.setImmediate(fn, ...args)
      : globalThis.setTimeout(fn as () => void, 0, ...args));
  },
  clearImmediate(id: unknown) {
    const realm = globalThis as unknown as { clearImmediate?: (id: unknown) => void };
    const handle = timerHandleOf(id);
    return realm.clearImmediate ? realm.clearImmediate(handle) : globalThis.clearTimeout(handle as number);
  },
};

/** Built on the first ask, for the reason `./binding/index.ts` gives. */
// eslint-disable-next-line no-var, vars-on-top
var __table: Record<string, () => unknown> | undefined;
export function nodeLibPublic(name: string, require?: (name: string) => any, _process?: object): (() => unknown) | undefined {
  if (require && name === 'crypto') return () => cryptoShim.createCryptoModule(require);
  if (require && name === 'tls') return () => tlsShim.createTlsModule(require);
  if (require && name === 'string_decoder') return () => createStringDecoderModule(() => require('buffer').Buffer);
  __table ??= {
  timers: () => timersModule,
  dns: () => dnsShim,
  cluster: () => clusterShim,
  string_decoder: () => stringDecoderShim,
  v8: () => v8Shim,
  dgram: () => dgramShim,
  // Node's `events.js` builds `EventEmitterAsyncResource` by extending this
  // binding's `AsyncResource`. The shim's class answers `asyncId` 0, which
  // is not an id a resource has.
  async_hooks: () => ({ ...asyncHooksShim, AsyncResource }),
  tls: () => tlsShim,
  crypto: () => cryptoShim,
  vm: () => vmShim,
  worker_threads: () => workerThreadsShim,
  http2: () => http2Shim,
  inspector: () => inspectorShim,
  perf_hooks: () => perfHooksShim,
  // `internal/fs/cp/cp.js` requires the public alias; it is the same object
  // as `internal/util/types`, which is `util.types`.
  'util/types': () => nodeLibInternalRequire('internal/util/types'),
  // The same object a guest's `require("path")` answers with: Node's own
  // `path.posix`, out of the vendored `path.js` the engine's shim evaluates.
  path: () => pathShim.posix,
  // `internal/fs/promises.js` exports `{ exports, FileHandle }`; the public
  // `fs/promises` module is the inner `exports` object, as `fs.js` reads it.
  'fs/promises': () => (nodeLibInternalRequire('internal/fs/promises') as { exports: unknown }).exports,
  };

  return __table[name];
}
