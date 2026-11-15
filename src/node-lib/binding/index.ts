/**
 * The binding: one entry per `internalBinding` name Node's `net` and
 * `child_process` ask for.
 *
 * The rule for every file under this directory is the one the contract sets:
 * the binding implements nothing Node's own files implement. It is the libuv
 * surface and the engine's own doors behind it — the process's kernel
 * sockets (ADR-0009), the pipe pairing and path registry, the run's count of
 * open handles — and nothing
 * about sockets, servers, half-open, timeouts or buffering, nor about
 * `ChildProcess`, `fork`'s IPC protocol or `exec`'s buffering: all of those
 * are `net.js`'s and `child_process.js`'s, and both are vendored.
 */
import uvBinding from './uv';
import ipcSerdesBinding from './ipc_serdes';
import { createDiagnosticsChannelBinding } from './diagnostics_channel';
import streamWrapBinding from './stream_wrap';
import tcpWrapBinding from './tcp_wrap';
import pipeWrapBinding from './pipe_wrap';
import caresWrapBinding from './cares_wrap';
import processWrapBinding from './process_wrap';
import spawnSyncBinding from './spawn_sync';
import signalWrapBinding from './signal_wrap';
import ttyWrapBinding from './tty_wrap';
import udpWrapBinding from './udp_wrap';
import httpParserBinding from './http_parser';
import bufferBinding from './buffer';
import { constantsBinding, osBinding, configBinding, errorsBinding, credentialsBinding, encodingBinding, typesBinding, traceEventsBinding, messagingBinding, urlBinding, urlPatternBinding } from './misc';
import utilBinding from './util';
import { stringDecoderBinding } from './string_decoder';
import fsBinding, { fsDirBinding, fsEventWrapBinding } from './fs';
import blobBinding from './blob';
import zlibBinding from './zlib';
import modulesBinding from './modules';
import cryptoBinding from './crypto';
import tlsWrapBinding from './tls_wrap';
import jsStreamBinding from './js_stream';
import { handleOwnerSymbol } from './owner-symbol';
import { AsyncResource, asyncContextFrameBinding } from '../../shims/async_hooks';
import { createTimersBinding, taskQueueBinding } from './timers';

/**
 * The table, built on the first ask rather than when this module is
 * evaluated. `buffer` is a vendored file and the engine's own shims want
 * Node's `Buffer`, so the loader is asked for one from inside the import
 * graph that builds it; a module-scope table left this in its own temporal
 * dead zone and the engine failed to load. A hoisted function reading
 * already-evaluated leaf modules answers whatever order a bundler settles on.
 */
// eslint-disable-next-line no-var, vars-on-top
var __table: Record<string, () => unknown> | undefined;
export function nodeLibBinding(name: string): (() => unknown) | undefined {
  __table ??= {
  uv: () => uvBinding,
  ipc_serdes: () => ipcSerdesBinding,
  diagnostics_channel: () => createDiagnosticsChannelBinding(),
  stream_wrap: () => streamWrapBinding,
  tcp_wrap: () => tcpWrapBinding,
  pipe_wrap: () => pipeWrapBinding,
  cares_wrap: () => caresWrapBinding,
  process_wrap: () => processWrapBinding,
  spawn_sync: () => spawnSyncBinding,
  signal_wrap: () => signalWrapBinding,
  tty_wrap: () => ttyWrapBinding,
  udp_wrap: () => udpWrapBinding,
  http_parser: () => httpParserBinding,
  buffer: () => bufferBinding,
  config: () => configBinding,
  constants: () => constantsBinding,
  util: () => utilBinding,
  errors: () => errorsBinding,
  types: () => typesBinding,
  string_decoder: () => stringDecoderBinding,
  trace_events: () => traceEventsBinding,
  messaging: () => messagingBinding,
  os: () => osBinding,
  credentials: () => credentialsBinding,
  encoding_binding: () => encodingBinding,
  url: () => urlBinding,
  url_pattern: () => urlPatternBinding,
  fs: () => fsBinding,
  blob: () => blobBinding,
  async_wrap: () => ({ AsyncResource }),
  // Node's timers over the loop's timer and check handles (ADR-0018 item 2), the context frame they and Node's
  // AsyncLocalStorage keep their stores in, and V8's microtask queue.
  timers: createTimersBinding,
  async_context_frame: () => asyncContextFrameBinding,
  task_queue: () => taskQueueBinding,
  zlib: () => zlibBinding,
  modules: () => modulesBinding,
  // Node's TLS over OpenSSL in the process's libnode.so (ADR-0016 §4, ADR-0018 item 7): `crypto` as far as `tls` reaches it, `tls_wrap`, and the
  // JSStream a TLS socket over a JavaScript stream is made of.
  crypto: () => cryptoBinding,
  tls_wrap: () => tlsWrapBinding,
  js_stream: () => jsStreamBinding,
  // `internalBinding('symbols')` (env_properties.h PER_ISOLATE_SYMBOL_PROPERTIES), the names a vendored file
  // reads: `internal/tls/wrap.js` keys a PSK exchange by `onpskexchange`; `owner_symbol` is the engine's one.
  symbols: () => ({ onpskexchange: Symbol('onpskexchange'), owner_symbol: handleOwnerSymbol }),
  fs_dir: () => fsDirBinding,
  fs_event_wrap: () => fsEventWrapBinding,
};;
  return __table[name];
}

export {
  __ownedHandleCount, __adoptHandle, currentOwner,
} from './handles';
