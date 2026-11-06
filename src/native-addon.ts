/**
 * `process.dlopen` of a `.node` that is a WALI Node-API module (ADR-0011). The file is validated by the engine's own
 * WebAssembly compiler before anything of it is trusted (§2), loaded into its process's memory by the substrate's
 * dynamic linker (`TREE_NATIVE`, §7), given emnapi's Node-API (§4), and initialised on its caller's `module.exports` as
 * Node initialises an addon (§1). Its process owns it (§6). A file that is not one fails as Node's `dlopen` fails,
 * `ERR_DLOPEN_FAILED`.
 */
import { createNapiModule, type NapiModule } from '@emnapi/core';
import { Context, type Env } from '@emnapi/runtime';
import { callingNative, NATIVE_THREAD_MODULE } from './host-native';
import { createNativeQueue, receiveNative, stopNative } from './native-queue';
import { __adoptHandle, ownedRun, ownerOf, registerHandle, releaseHandle, startHandle, stopHandle, withNodeResourceScope,
  type OwnedHandle } from './node-lib/binding/handles';
import { bufferModule } from './node-lib/buffer-module';
import { __tokenForProcess, type ProcessToken } from './process-tokens';
import type { Process } from './shims/process';
import { pathToFileURL } from './shims/url';

const dlopenFailed = (message: string): Error => Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' });

type CleanupHook = Parameters<Context['addCleanupHook']>[1];

/**
 * emnapi's context, one per process (§6), which knows each environment's cleanup hooks so that one environment can be
 * torn down alone, as `destroy` tears down every one, and which hands each environment it makes to its process.
 */
class ProcessContext extends Context {
  private readonly hooks = new Map<Env, Array<[CleanupHook, number]>>();
  /** The environment the last `createEnv` made: the one a failed initializer leaves. */
  made: Env | undefined;

  constructor(private readonly onEnv: (env: Env) => void) { super(); }

  override createEnv(...args: Parameters<Context['createEnv']>): Env {
    const env = super.createEnv(...args);
    this.onEnv(env);
    this.made = env;
    return env;
  }

  override addCleanupHook(env: Env, fn: CleanupHook, arg: number): void {
    super.addCleanupHook(env, fn, arg);
    let hooks = this.hooks.get(env);
    if (!hooks) this.hooks.set(env, hooks = []);
    hooks.push([fn, arg]);
  }

  override removeCleanupHook(env: Env, fn: CleanupHook, arg: number): void {
    super.removeCleanupHook(env, fn, arg);
    const hooks = this.hooks.get(env);
    const at = hooks ? hooks.findIndex(([hook, value]) => hook === fn && value === arg) : -1;
    if (at >= 0) hooks!.splice(at, 1);
    if (hooks?.length === 0) this.hooks.delete(env);
  }

  /** One environment's teardown: its cleanup hooks, newest first, as `destroy` drains them; the last releases it. */
  teardown(env: Env): void {
    for (let hooks = this.hooks.get(env); hooks?.length; hooks = this.hooks.get(env)) {
      const [fn, arg] = hooks[hooks.length - 1]!;
      this.removeCleanupHook(env, fn, arg);
      if (typeof fn === 'number') env.makeDynCall_vp(fn)(arg);
      else fn(arg);
    }
  }

  override destroy(): void {
    try { super.destroy(); } finally { this.hooks.clear(); }
  }
}

/**
 * A process's context. emnapi's `Context` subscribes its `destroy` to the ambient `process`'s `beforeExit` and refs a
 * `MessagePort` of its own while requests wait; the process's owner does both here, so it is made with no ambient
 * `process` to subscribe to.
 */
function processContext(made: (env: Env) => void): ProcessContext {
  const ambient = Object.getOwnPropertyDescriptor(globalThis, 'process');
  Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });
  try { return new ProcessContext(made); }
  finally {
    if (ambient) Object.defineProperty(globalThis, 'process', ambient);
    else delete (globalThis as { process?: unknown }).process;
  }
}

/** One opened file: its instance, its emnapi module, its queue, and the JavaScript copies lent in the current call. */
interface Library {
  readonly napi: NapiModule;
  readonly loaded: { instance: WebAssembly.Instance; module: WebAssembly.Module; memory: WebAssembly.Memory; table: WebAssembly.Table };
  readonly queue: SharedArrayBuffer;
  readonly lent: Set<ArrayBuffer | SharedArrayBuffer>;
}

/** Every process's addons (§6). */
const owners = new WeakMap<object, ProcessAddons>();

/**
 * One process's addons (ADR-0011 §6): its context, its opened files and its loop holds, as one owned handle of the
 * process, registered stopped, so that it holds the loop only while an addon asks it and is closed with every other
 * handle of the run when the run ends, however it ends.
 */
class ProcessAddons implements OwnedHandle {
  readonly context: ProcessContext;
  readonly libraries = new Map<string, Library>();
  private readonly token: ProcessToken | null;
  private holds = 0;
  private depth = 0;
  private ended = false;

  constructor(private readonly process: object) {
    this.context = processContext((env) => {
      // Every call into the module (an addon function, its initializer, a finalizer, a callback into JavaScript) is
      // its environment's `callIntoModule`, so that is where the boundary of §4 is.
      const enter = env.callIntoModule.bind(env);
      env.callIntoModule = ((fn: (env: Env) => unknown, handleException?: (env: Env, value: unknown) => void) =>
        this.call(() => enter(fn, handleException))) as Env['callIntoModule'];
    });
    // The main thread's `uv_async_send`, emnapi's `uv_close` and its next tick are `_emnapi_set_immediate`, which is
    // the context's `setImmediate`.
    const schedule = this.context.feature.setImmediate;
    this.context.feature.setImmediate = (callback: () => void): void => schedule(() => this.deliver(callback, 'native-immediate'));
    this.context.feature.Buffer = bufferModule.Buffer as unknown as Context['feature']['Buffer'];
    this.token = __tokenForProcess(process as Process);
    registerHandle(this, false, false);
    if (ownerOf(this) !== this.token) __adoptHandle(this, this.token);
    owners.set(process, this);
  }

  /** emnapi-mt's `runtime_keepalive`: the loop is held while any of the process's addons asks it. */
  readonly push = (): void => { if (this.holds++ === 0 && !this.ended) startHandle(this); };
  readonly pop = (): void => { if (this.holds > 0 && --this.holds === 0) stopHandle(this); };

  /** A callback from the loop into the process's addons: dropped once the process has ended, else run as the process. */
  deliver(callback: () => void, kind: string): void {
    if (this.ended) return;
    ownedRun(this.token, () => this.call(callback), true, kind);
  }

  /**
   * The outermost call into the process's addons (§4), run as the process: when it returns, by a value or a throw, each
   * JavaScript copy lent in it is written back to its bytes.
   */
  call<T>(body: () => T): T {
    if (this.depth > 0) return body();
    this.depth = 1;
    try { return withNodeResourceScope(this.process, () => ownedRun(this.token, body) as T); }
    finally {
      this.depth = 0;
      for (const library of this.libraries.values()) returnLent(library);
    }
  }

  /** The process's end: nothing more is delivered, every environment is torn down, every queue is stopped. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    owners.delete(this.process);
    try { this.context.destroy(); }
    finally {
      for (const library of this.libraries.values()) stopNative(library.queue);
      this.holds = 0;
      releaseHandle(this);
    }
  }
}

/** Each lent copy's bytes, written back to its JavaScript buffer with emnapi's own `syncMemory`. */
function returnLent(library: Library): void {
  if (library.lent.size === 0) return;
  for (const buffer of library.lent) {
    try { library.napi.emnapi.syncMemory(false, buffer as ArrayBuffer); } catch { /* a buffer whose copy is gone has nothing to write */ }
  }
  library.lent.clear();
}

/**
 * The Node-API answers that hand an addon a pointer into a JavaScript copy (§4): the argument that is that pointer (or
 * asks for it), where the value is (an argument's handle, or the handle written at an argument's address), and whether
 * the copy must first be made to hold its buffer's bytes (`napi_create_buffer_copy`'s holds zeros).
 */
const LENDS: Readonly<Record<string, { pointer: number; handle: 'in' | 'out'; at: number; refresh?: true }>> = {
  napi_get_buffer_info: { pointer: 2, handle: 'in', at: 1 },
  napi_get_arraybuffer_info: { pointer: 2, handle: 'in', at: 1 },
  napi_get_typedarray_info: { pointer: 4, handle: 'in', at: 1 },
  napi_get_dataview_info: { pointer: 3, handle: 'in', at: 1 },
  napi_create_arraybuffer: { pointer: 2, handle: 'out', at: 3 },
  node_api_create_sharedarraybuffer: { pointer: 2, handle: 'out', at: 3 },
  napi_create_buffer_copy: { pointer: 3, handle: 'out', at: 4, refresh: true },
  napi_create_external_arraybuffer: { pointer: 1, handle: 'out', at: 5 },
};

/** `napi`'s imports with each answer of `LENDS` recording the copy it lent. */
function lendingImports(napi: Record<string, unknown>, context: Context, library: () => Library): Record<string, unknown> {
  const imports: Record<string, unknown> = { ...napi };
  for (const [name, lend] of Object.entries(LENDS)) {
    const answer = napi[name];
    if (typeof answer !== 'function') continue;
    imports[name] = (...args: number[]): number => {
      const status = (answer as (...values: number[]) => number)(...args);
      if (status !== 0 || !args[lend.pointer]) return status;
      const { napi: module, loaded, lent } = library();
      const at = args[lend.at]! >>> 0;
      const id = lend.handle === 'in' ? at : new DataView(loaded.memory.buffer).getUint32(at, true);
      const value = (context.handleStore.get(id) as { value?: unknown } | undefined)?.value;
      const buffer = ArrayBuffer.isView(value) ? value.buffer : value;
      if (!(buffer instanceof ArrayBuffer) && !(typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer)) return status;
      if (lend.refresh) module.emnapi.syncMemory(true, buffer as ArrayBuffer);
      // A buffer that is the addon's memory itself has no copy (its address is 0); every other has one.
      if (module.emnapi.getMemoryAddress(buffer as ArrayBuffer).address) lent.add(buffer);
      return status;
    };
  }
  return imports;
}

/**
 * Opens `path` in `process` (§2): validated, its imports answered, loaded by the substrate's linker, its queue read.
 * A refusal leaves nothing behind, the process's record included where this was its first.
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
  const native = callingNative();
  if (!native) throw dlopenFailed(path + ': a tab runs no native code');

  const fresh = !owners.has(process);
  const owner = owners.get(process) ?? new ProcessAddons(process);
  try {
    let library: Library | undefined;
    const napi = createNapiModule({ context: owner.context, filename: path });
    const table = (): WebAssembly.Table => library!.loaded.table;
    const env = {
      ...napi.imports.env,
      _emnapi_runtime_keepalive_push: owner.push,
      _emnapi_runtime_keepalive_pop: owner.pop,
      _emnapi_next_tick: (callback: number, data: number): void =>
        queueMicrotask(() => owner.deliver(() => (table().get(callback) as (data: number) => void)(data), 'native-tick')),
    };
    // libuv's ABI is not Node-API's, and the engine has no libuv: a `uv_*` import is an unresolved symbol, as is a
    // Node-API function emnapi does not have (an experimental one).
    const answered: WebAssembly.Imports = {
      env, napi: lendingImports(napi.imports.napi, owner.context, () => library!) as WebAssembly.ModuleImports, emnapi: napi.imports.emnapi,
    };
    for (const { module: from, name } of WebAssembly.Module.imports(compiled)) {
      const offered = answered[from];
      if (name.startsWith('uv_') || (from !== 'env' && offered && !(name in offered))) throw dlopenFailed(`${path}: undefined symbol: ${name}`);
    }
    const queue = createNativeQueue();
    const loaded = native.load({ path, bytes, imports: answered, thread: { module: NATIVE_THREAD_MODULE, queue } });
    if ('error' in loaded) throw dlopenFailed(loaded.error);
    library = { napi, loaded, queue, lent: new Set() };
    owner.libraries.set(path, library);
    // A thread's `uv_async_send`: emnapi's main side calls the callback through the module's table, as its own send
    // listener does, on the realm's loop, as the process that loaded the addon.
    receiveNative(queue, (callback, data) => owner.deliver(() => (table().get(callback) as (data: number) => void)(data), 'native-async'));
    return library;
  } catch (error) {
    if (fresh && owner.libraries.size === 0) owner.close();
    throw error;
  }
}

/**
 * `process.dlopen(target, path)` of a file whose bytes are `bytes` (ADR-0011 §1): the file opened once in its process
 * (§2), and its initializer called with a new environment on `exports` (`target.exports` as an object), its answer
 * `target.exports` where it is another value. An initializer that throws has its environment torn down (§6), and the
 * error is the load's.
 */
export function dlopenNative(process: object, target: { exports?: unknown; filename?: unknown }, exports: object, path: string,
  bytes: Uint8Array): void {
  const library = owners.get(process)?.libraries.get(path) ?? openLibrary(process, path, bytes);
  const owner = owners.get(process)!;
  const { napi } = library;
  // Each initialization is the module's own `init` again over the one instance: it makes a new environment where it
  // holds none (`envObject`, kept only by an `init` that failed) and has not loaded.
  napi.loaded = false;
  delete (napi as { envObject?: unknown }).envObject;
  napi.exports = exports;
  // Node names the environment by the target's `module.filename`, as a file URL.
  napi.filename = typeof target.filename === 'string' ? pathToFileURL(target.filename).href : '';
  owner.context.made = undefined;
  let answer: unknown;
  try {
    answer = napi.init({ instance: library.loaded.instance, module: library.loaded.module, memory: library.loaded.memory, table: library.loaded.table });
  } catch (error) {
    const made = owner.context.made;
    delete (napi as { envObject?: unknown }).envObject;
    if (made) owner.context.teardown(made);
    throw error;
  } finally {
    owner.context.made = undefined;
  }
  if (answer !== exports) target.exports = answer;
}
