/**
 * The internals Node's own files name that are not vendored.
 *
 * Node's own `internal/util`, `internal/async_hooks`, `internal/timers` and
 * the rest are large files whose subject is a Node the engine does not have:
 * an async-hooks graph, a timer wheel, a snapshot builder. What the vendored
 * files actually take from each is a handful of names, so each is bound by
 * hand to exactly those, over the engine's own modules. This table is the
 * whole list; anything a vendored file asks for that is not here, not
 * vendored and not a public module fails loudly in `load.ts` rather than
 * arriving as `undefined` inside Node's code.
 */
import { internalUtilTypes } from './util';
import {
  internalConsoleGlobal, internalProcessExecution,
  internalProcessWarning, internalSourceMapCache, internalUndici, internalReadlineInterface, internalJsTransferable,
} from './events-util';
import {
  internalAsyncHooks, internalTimers, internalStreamsState, internalTaskQueues,
  internalEventTarget, internalOptions, internalPerfObserve, internalAssert,
  internalStartupSnapshot, internalPermission,
} from './runtime';
import { internalSocketAddress, internalBlockList } from './addresses';
import { internalFsUtils, internalDgram } from './child-process';
import {
  internalAbortController, internalBlob, internalFile, internalWebStreamsAdapters,
} from './buffer-and-streams';
import { internalBootstrapRealm, internalUrl, internalEncoding } from './modules';

/** Built on the first ask, for the reason `./binding/index.ts` gives. */
// eslint-disable-next-line no-var, vars-on-top
var __table: Record<string, () => unknown> | undefined;
export function nodeLibInternal(name: string): (() => unknown) | undefined {
  __table ??= {
  'internal/util/types': () => internalUtilTypes,
  'internal/async_hooks': () => internalAsyncHooks,
  'internal/timers': () => internalTimers,
  'internal/streams/state': () => internalStreamsState,
  'internal/process/task_queues': () => internalTaskQueues,
  'internal/process/permission': () => internalPermission,
  'internal/event_target': () => internalEventTarget,
  'internal/options': () => internalOptions,
  'internal/perf/observe': () => internalPerfObserve,
  'internal/assert': () => internalAssert,
  'internal/v8/startup_snapshot': () => internalStartupSnapshot,
  'internal/fs/utils': () => internalFsUtils,
  'internal/dgram': () => internalDgram,
  'internal/abort_controller': () => internalAbortController,
  'internal/blob': () => internalBlob,
  'internal/file': () => internalFile,
  'internal/webstreams/adapters': () => internalWebStreamsAdapters,
  'internal/socketaddress': () => internalSocketAddress,
  'internal/blocklist': () => internalBlockList,
  'internal/bootstrap/realm': () => internalBootstrapRealm,
  'internal/url': () => internalUrl,
  'internal/encoding': () => internalEncoding,
  'internal/console/global': () => internalConsoleGlobal,
  'internal/process/execution': () => internalProcessExecution,
  'internal/process/warning': () => internalProcessWarning,
  'internal/source_map/source_map_cache': () => internalSourceMapCache,
  'internal/deps/undici/undici': () => internalUndici,
  'internal/readline/interface': () => internalReadlineInterface,
  'internal/worker/js_transferable': () => internalJsTransferable,
};;
  return __table[name];
}
