/**
 * `process.dlopen` of a `.node` that is a WALI Node-API module (ADR-0011). The file is validated by the engine's own
 * WebAssembly compiler before anything of it is trusted (§2), loaded into its process's memory by the substrate's
 * dynamic linker (`TREE_NATIVE`, §7), given emnapi's Node-API (§4), and initialised on its caller's `module.exports` as
 * Node initialises an addon (§1). Its process owns it (§6). A file that is not one fails as Node's `dlopen` fails,
 * `ERR_DLOPEN_FAILED`.
 */
import { createNapiModule, type NapiModule } from '@emnapi/core';
import type * as EmnapiRuntime from '@emnapi/runtime';
import EMNAPI_RUNTIME from '@emnapi/runtime/dist/emnapi.cjs.min?raw';
import { callingNative, NATIVE_THREAD_MODULE } from './host-native';
import { createNativeQueue, receiveNative, stopNative } from './native-queue';
import { __adoptHandle, ownedRun, ownerOf, registerHandle, releaseHandle, withNodeResourceScope, type OwnedHandle } from './node-lib/binding/handles';
import { loadDependencyFor } from './node-lib/load';
import { __tokenForProcess, type ProcessToken } from './process-tokens';
import type { Process } from './shims/process';
import { pathToFileURL } from './shims/url';

const dlopenFailed = (message: string): Error => Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' });

/**
 * One opened file: its instance in the process's memory, the emnapi module whose imports it was instantiated with
 * (which its first initialization uses), and its thread queue.
 */
interface Library {
  readonly loaded: { instance: WebAssembly.Instance; module: WebAssembly.Module; memory: WebAssembly.Memory; table: WebAssembly.Table };
  readonly napi: NapiModule;
  readonly queue: SharedArrayBuffer;
  initialized: boolean;
}

/** Every process's addons (§6). */
const owners = new WeakMap<object, ProcessAddons>();

/**
 * The process's own `@emnapi/runtime` (ADR-0011 §6): evaluated once for it, so the `process`, `setImmediate`,
 * `MessageChannel`, `Buffer` and global it takes from its host are that process's.
 */
const runtimeOf = (process: object): typeof EmnapiRuntime =>
  loadDependencyFor(process, '@emnapi/runtime', EMNAPI_RUNTIME, ['setImmediate', 'MessageChannel', 'Buffer']) as typeof EmnapiRuntime;

/**
 * One process's addons (ADR-0011 §6): its emnapi context and its opened files, as one owned handle of the process,
 * registered stopped, closed with the run's other handles however the run ends.
 */
class ProcessAddons implements OwnedHandle {
  readonly context: EmnapiRuntime.Context;
  readonly libraries = new Map<string, Library>();
  readonly token: ProcessToken | null;
  private ended = false;

  constructor(readonly process: object) {
    this.context = runtimeOf(process).createContext();
    this.token = __tokenForProcess(process as Process);
    registerHandle(this, false, false);
    if (ownerOf(this) !== this.token) __adoptHandle(this, this.token);
    owners.set(process, this);
  }

  /** A thread's `uv_async_send`, called through the table as emnapi's own listener calls it, in the process's run. */
  deliver(library: Library, callback: number, data: number): void {
    ownedRun(this.token, () => (library.loaded.table.get(callback) as (data: number) => void)(data), true, 'native-async');
  }

  /** The process's end: its context destroyed (every environment's cleanup), its thread queues stopped. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    owners.delete(this.process);
    try { this.context.destroy(); }
    finally {
      for (const library of this.libraries.values()) stopNative(library.queue);
      releaseHandle(this);
    }
  }
}

/**
 * Opens `path` in `process` (§2): validated, its imports answered, loaded by the loading process's tree, its queue
 * read. A refusal leaves nothing behind, the process's record included where this was its first.
 */
function openLibrary(process: object, path: string, bytes: Uint8Array): Library {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw dlopenFailed(path + ': invalid ELF header');
  }
  let compiled: WebAssembly.Module;
  try { compiled = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>); }
  catch (error) { throw dlopenFailed(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!WebAssembly.Module.exports(compiled).some((entry) => entry.name === 'napi_register_wasm_v1')) {
    throw dlopenFailed(`Module did not self-register: '${path}'.`);
  }
  // A module with no dylink.0 is linked to fixed addresses, as an executable is, and has no place in its process's
  // memory beside another's: glibc's dlopen refuses an executable the same way.
  if (WebAssembly.Module.customSections(compiled, 'dylink.0').length === 0) throw dlopenFailed(path + ': cannot dynamically load executable');
  // The loading process's tree, whatever is ambient (§6).
  const native = withNodeResourceScope(process, () => callingNative());
  if (!native) throw dlopenFailed(path + ': a tab runs no native code');

  const fresh = !owners.has(process);
  const owner = owners.get(process) ?? new ProcessAddons(process);
  try {
    const napi = createNapiModule({ context: owner.context, filename: path });
    const env = napi.imports.env;
    // libuv's ABI is not Node-API's, and the engine has no libuv: a `uv_*` import is an unresolved symbol, as is a
    // Node-API function emnapi does not have (an experimental one).
    const answered: WebAssembly.Imports = { env, napi: napi.imports.napi, emnapi: napi.imports.emnapi };
    for (const { module: from, name } of WebAssembly.Module.imports(compiled)) {
      const offered = answered[from];
      if (name.startsWith('uv_') || (from !== 'env' && offered && !(name in offered))) throw dlopenFailed(`${path}: undefined symbol: ${name}`);
    }
    const queue = createNativeQueue();
    const loaded = withNodeResourceScope(process, () => native.load({ path, bytes, imports: answered, thread: { module: NATIVE_THREAD_MODULE, queue } }));
    if ('error' in loaded) throw dlopenFailed(loaded.error);
    const library: Library = { loaded, napi, queue, initialized: false };
    owner.libraries.set(path, library);
    receiveNative(queue, (callback, data) => owner.deliver(library, callback, data));
    return library;
  } catch (error) {
    if (fresh && owner.libraries.size === 0) owner.close();
    throw error;
  }
}

/**
 * `process.dlopen(target, path)` of a file whose bytes are `bytes` (ADR-0011 §1): the file opened once in its process
 * (§2), and its initializer called with an environment of its own on `exports` (`target.exports` as an object), its
 * answer `target.exports` where it is another value (§6).
 */
export function dlopenNative(process: object, target: { exports?: unknown; filename?: unknown }, exports: object, path: string,
  bytes: Uint8Array): void {
  const library = owners.get(process)?.libraries.get(path) ?? openLibrary(process, path, bytes);
  const owner = owners.get(process)!;
  // Node names the environment by the target's `module.filename`, as a file URL.
  const filename = typeof target.filename === 'string' ? pathToFileURL(target.filename).href : '';
  // Each initialization is an emnapi module's one `init` over the file's one instance, so one environment each: the
  // first is the module the instance's imports are, which `init` binds to the instance, and each later one its own.
  const initialization = library.initialized ? createNapiModule({ context: owner.context, filename }) : library.napi;
  library.initialized = true;
  initialization.filename = filename;
  initialization.exports = exports;
  const answer: unknown = initialization.init({ ...library.loaded });
  if (answer !== exports) target.exports = answer;
}
