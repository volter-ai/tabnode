/**
 * The public modules a vendored Node file names.
 *
 * Node's own files `require('dns')`, `require('async_hooks')` and the rest as any
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
import { asyncHooksModule } from '../shims/async_hooks';
import v8Shim from '../shims/v8';
import * as vmShim from '../shims/vm';
import * as workerThreadsShim from '../shims/worker_threads';
import * as http2Shim from '../shims/http2';
import * as inspectorShim from '../shims/inspector';
import * as perfHooksShim from '../shims/perf_hooks';
import { type EnginePublicId } from './engine-builtin-ids';
import * as replShim from '../shims/repl';
import * as domainShim from '../shims/domain';
import { nodeLibInternalRequire } from './load';

/** Built on the first ask, for the reason `./binding/index.ts` gives. */
// eslint-disable-next-line no-var, vars-on-top
var __table: Record<string, () => unknown> | undefined;
export function nodeLibPublic(name: string, require?: (name: string) => any, _process?: object): (() => unknown) | undefined {
  if (_process && name === 'dns') return () => createDnsModule(processHostsReaderOf(_process));
  if (require && name === 'async_hooks') return () => asyncHooksModule(require);
  __table ??= ({
  dns: createDnsModule,
  cluster: () => clusterShim,
  v8: () => v8Shim,
  // Node's `events.js` builds `EventEmitterAsyncResource` by extending its
  // `AsyncResource`; its `AsyncLocalStorage` is Node's own, of the graph that asks.
  async_hooks: () => asyncHooksModule(),
  vm: () => vmShim,
  worker_threads: () => workerThreadsShim,
  http2: () => http2Shim,
  inspector: () => inspectorShim,
  'inspector/promises': () => inspectorShim,
  perf_hooks: () => perfHooksShim,
  // A stand-in that refuses the REPL by name (shims/repl.ts says why it is not Node's file).
  repl: () => replShim,
  // The engine's own `domain` (BUILTINS.md Kind 2).
  domain: () => domainShim,
  // `internal/fs/cp/cp.js` requires the public alias; it is the same object
  // as `internal/util/types`, which is `util.types`.
  'util/types': () => nodeLibInternalRequire('internal/util/types'),
  // `internal/fs/promises.js` exports `{ exports, FileHandle }`; the public
  // `fs/promises` module is the inner `exports` object, as `fs.js` reads it.
  'fs/promises': () => (nodeLibInternalRequire('internal/fs/promises') as { exports: unknown }).exports,
  } satisfies Record<EnginePublicId, () => unknown>);


  return __table[name];
}
