/**
 * The public modules a vendored Node file names.
 *
 * Node's own files `require('dns')`, `require('timers')` and the rest as any
 * program does, and get the runtime's modules. Here they get the engine's
 * shims through the requesting process's module graph, so a
 * `net.Socket` is a `stream.Duplex` of the same `stream` the guest imports,
 * and an `instanceof` across the two holds. A name that is itself a vendored
 * file — `events`, `util`, `buffer`, `stream` — is never asked of this table:
 * the loader finds the file first.
 *
 * Each entry is a thunk: the shim is read when a vendored file asks, not when
 * this module is loaded, so a cycle between a shim and the loader settles
 * before either is used.
 */
import { createDnsModule } from '../shims/dns';
import { processHostsReaderOf } from '../process-hostname';
import * as clusterShim from '../shims/cluster';
import asyncHooksShim from '../shims/async_hooks';
import v8Shim from '../shims/v8';
import * as cryptoShim from '../shims/crypto';
import * as vmShim from '../shims/vm';
import * as workerThreadsShim from '../shims/worker_threads';
import * as http2Shim from '../shims/http2';
import * as inspectorShim from '../shims/inspector';
import * as perfHooksShim from '../shims/perf_hooks';
import { nodeLibInternalRequire } from './load';
import { createTimersModule } from './timers';
import { guestTimerFunctions } from '../guest-timers';
import { AsyncResource } from './internals/runtime';

/** Built on the first ask, for the reason `./binding/index.ts` gives. */
// eslint-disable-next-line no-var, vars-on-top
var __table: Record<string, () => unknown> | undefined;
export function nodeLibPublic(name: string, require?: (name: string) => any, _process?: object): (() => unknown) | undefined {
  if (_process && name === 'dns') return () => createDnsModule(processHostsReaderOf(_process));
  if (_process && name === 'timers') return () => createTimersModule(guestTimerFunctions(_process));
  if (require && name === 'crypto') return () => cryptoShim.createCryptoModule(require);
  __table ??= {
  timers: createTimersModule,
  dns: createDnsModule,
  cluster: () => clusterShim,
  v8: () => v8Shim,
  // Node's `events.js` builds `EventEmitterAsyncResource` by extending this
  // binding's `AsyncResource`. The shim's class answers `asyncId` 0, which
  // is not an id a resource has.
  async_hooks: () => ({ ...asyncHooksShim, AsyncResource }),
  crypto: () => cryptoShim,
  vm: () => vmShim,
  worker_threads: () => workerThreadsShim,
  http2: () => http2Shim,
  inspector: () => inspectorShim,
  perf_hooks: () => perfHooksShim,
  // `internal/fs/cp/cp.js` requires the public alias; it is the same object
  // as `internal/util/types`, which is `util.types`.
  'util/types': () => nodeLibInternalRequire('internal/util/types'),
  // `internal/fs/promises.js` exports `{ exports, FileHandle }`; the public
  // `fs/promises` module is the inner `exports` object, as `fs.js` reads it.
  'fs/promises': () => (nodeLibInternalRequire('internal/fs/promises') as { exports: unknown }).exports,
  };

  return __table[name];
}
