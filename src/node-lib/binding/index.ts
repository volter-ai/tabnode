/**
 * The binding: one entry per `internalBinding` name Node's `net` and
 * `child_process` ask for.
 *
 * The rule for every file under this directory is the one the contract sets:
 * the binding implements nothing Node's own files implement. It is the libuv
 * surface and the engine's own doors behind it — the loopback pairing, the
 * port and path registries, the run's count of open handles — and nothing
 * about sockets, servers, half-open, timeouts or buffering, nor about
 * `ChildProcess`, `fork`'s IPC protocol or `exec`'s buffering: all of those
 * are `net.js`'s and `child_process.js`'s, and both are vendored.
 */
import uvBinding from './uv';
import streamWrapBinding from './stream_wrap';
import tcpWrapBinding from './tcp_wrap';
import pipeWrapBinding from './pipe_wrap';
import caresWrapBinding from './cares_wrap';
import processWrapBinding from './process_wrap';
import spawnSyncBinding from './spawn_sync';
import ttyWrapBinding from './tty_wrap';
import { udpWrapBinding } from './stubs';
import httpParserBinding from './http_parser';
import bufferBinding from './buffer';
import { constantsBinding, osBinding, configBinding, errorsBinding, credentialsBinding, encodingBinding, typesBinding, stringDecoderBinding, traceEventsBinding, messagingBinding } from './misc';
import utilBinding from './util';
import fsBinding, { fsDirBinding, fsEventWrapBinding } from './fs';
import blobBinding from './blob';
import zlibBinding from './zlib';
import { AsyncResource } from '../internals/runtime';

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
  stream_wrap: () => streamWrapBinding,
  tcp_wrap: () => tcpWrapBinding,
  pipe_wrap: () => pipeWrapBinding,
  cares_wrap: () => caresWrapBinding,
  process_wrap: () => processWrapBinding,
  spawn_sync: () => spawnSyncBinding,
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
  fs: () => fsBinding,
  blob: () => blobBinding,
  async_wrap: () => ({ AsyncResource }),
  zlib: () => zlibBinding,
  fs_dir: () => fsDirBinding,
  fs_event_wrap: () => fsEventWrapBinding,
};;
  return __table[name];
}

export {
  __ownedHandleCount, __releaseOwnedHandles, __adoptHandle, currentOwner,
} from './handles';
