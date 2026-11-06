/**
 * `process.dlopen` of a `.node` that is a WALI Node-API module (ADR-0011): recognised by its own bytes, loaded into
 * its process's memory by the substrate's dynamic linker (`TREE_NATIVE`), given emnapi's Node-API, and initialised as
 * Node initialises an addon. A file that is not one fails as Node's `dlopen` fails, `ERR_DLOPEN_FAILED`.
 */
import { createNapiModule } from '@emnapi/core';
import { getDefaultContext } from '@emnapi/runtime';
import { callingNative, NATIVE_THREAD_MODULE } from './host-native';
import { createNativeQueue, receiveNative } from './native-queue';
import { captureNodeResourceScope, registerHandle, releaseHandle, type OwnedHandle } from './node-lib/binding/handles';
import { withGuestCallback } from './guest-loop';

/** The Node-API version of the engine's Node line (v24.21.0). */
const NODE_API_VERSION = 10;
const dlopenFailed = (message: string): Error => Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' });

/** A module's imports and exports by name, from its import (2) and export (7) sections. */
function moduleInterface(bytes: Uint8Array): { imports: Array<[string, string]>; exports: Set<string>; dylink: boolean } {
  let at = 8;
  const unsigned = (): number => {
    let value = 0, shift = 0, byte: number;
    do { byte = bytes[at++]; value |= (byte & 127) << shift; shift += 7; } while (byte & 128);
    return value >>> 0;
  };
  const name = (): string => { const length = unsigned(); const text = new TextDecoder().decode(bytes.subarray(at, at + length)); at += length; return text; };
  const imports: Array<[string, string]> = [], exports = new Set<string>();
  let dylink = false;
  while (at < bytes.length) {
    const section = bytes[at++], length = unsigned(), end = at + length;
    if (section === 0 && name() === 'dylink.0') dylink = true;
    else if (section === 2) {
      for (let count = unsigned(); count > 0; count -= 1) {
        const module = name(), field = name(), kind = bytes[at++];
        imports.push([module, field]);
        if (kind === 0) unsigned();
        else if (kind === 1) { at += 1; const flags = unsigned(); unsigned(); if (flags & 1) unsigned(); }
        else if (kind === 2) { const flags = unsigned(); unsigned(); if (flags & 1) unsigned(); }
        else if (kind === 3) at += 2;
        else if (kind === 4) { at += 1; unsigned(); }
      }
    } else if (section === 7) {
      for (let count = unsigned(); count > 0; count -= 1) { exports.add(name()); at += 1; unsigned(); }
    }
    at = end;
  }
  return { imports, exports, dylink };
}

/** Whether the loop is held while an addon's emnapi asks it (`runtime_keepalive`: live thread-safe functions, queued work). */
function keepalive(): { push(): void; pop(): void } {
  let count = 0;
  // Process exit closes every handle its run owns, as it closes this one.
  const holder: OwnedHandle = { close: () => { count = 0; releaseHandle(holder); } };
  return {
    push: () => { if (count++ === 0) registerHandle(holder); },
    pop: () => { if (count > 0 && --count === 0) releaseHandle(holder); },
  };
}

/**
 * Loads `bytes`, the file at `path`, into `module`: its exports are what `napi_register_wasm_v1` answers. Fails as Node's
 * `dlopen` fails when the file is no WebAssembly module, has no Node-API initializer, asks a Node-API version the
 * engine's Node line has not, or imports what neither emnapi nor the process answers.
 */
export function loadNativeAddon(module: { exports: unknown }, path: string, bytes: Uint8Array): void {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw dlopenFailed(path + ': invalid ELF header');
  }
  const shape = moduleInterface(bytes);
  if (!shape.exports.has('napi_register_wasm_v1')) throw dlopenFailed(`Module did not self-register: '${path}'.`);
  // A module with no dylink.0 is linked to fixed addresses, as an executable is, and has no place in its process's
  // memory beside another's: glibc's dlopen refuses an executable the same way.
  if (!shape.dylink) throw dlopenFailed(path + ': cannot dynamically load executable');
  const native = callingNative();
  if (!native) throw dlopenFailed(path + ': a tab runs no native code');

  const napiModule = createNapiModule({ context: getDefaultContext(), filename: path });
  const loop = keepalive();
  const env = { ...napiModule.imports.env, _emnapi_runtime_keepalive_push: loop.push, _emnapi_runtime_keepalive_pop: loop.pop };
  // libuv's ABI is not Node-API's, and the engine has no libuv: a `uv_*` import is an unresolved symbol, as is a
  // Node-API function emnapi does not have (an experimental one).
  const answered: WebAssembly.Imports = { env, napi: napiModule.imports.napi, emnapi: napiModule.imports.emnapi };
  for (const [from, name] of shape.imports) {
    const offered = answered[from];
    if (name.startsWith('uv_') || (from !== 'env' && offered && !(name in offered))) throw dlopenFailed(`${path}: undefined symbol: ${name}`);
  }
  const queue = createNativeQueue();
  const loaded = native.load({ path, bytes, imports: answered, thread: { module: NATIVE_THREAD_MODULE, queue } });
  if ('error' in loaded) throw dlopenFailed(loaded.error);

  const version = loaded.instance.exports.node_api_module_get_api_version_v1;
  if (typeof version === 'function') {
    const asked = Number(version());
    if (asked > NODE_API_VERSION && asked !== 0x7fffffff) {
      throw dlopenFailed(`Module did not self-register: '${path}'. It asks Node-API version ${asked}; this Node line has ${NODE_API_VERSION}.`);
    }
  }
  // A thread's `uv_async_send`: emnapi's main side calls the callback through the module's table, as its own send
  // listener does, on the realm's loop, as the process that loaded the addon.
  let unloaded = false;
  const asLoader = captureNodeResourceScope();
  receiveNative(queue, (_kind, callback, data) => asLoader(() =>
    withGuestCallback(() => (loaded.table.get(callback) as (data: number) => void)(data), 'native-async')), () => unloaded);
  napiModule.exports = module.exports;
  try {
    module.exports = napiModule.init({ instance: loaded.instance, module: loaded.module, memory: loaded.memory, table: loaded.table });
  } catch (error) {
    unloaded = true;
    throw error;
  }
}
