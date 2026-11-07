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
import { loadDependencyFor, nodeLibGlobalFor } from './node-lib/load';
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

/** Every process's addon runtime (§6), kept for the process's whole life. */
const owners = new WeakMap<object, ProcessAddons>();

/**
 * The process's own `@emnapi/runtime` (ADR-0011 §6): evaluated once for it, so the `process`, `MessageChannel`,
 * `Buffer` and global it takes from its host are that process's, and its `setImmediate` is the process's addon
 * runtime's, which lives as long as the evaluation does.
 */
const runtimeOf = (process: object, setImmediate: (callback: () => void) => void): typeof EmnapiRuntime =>
  loadDependencyFor(process, '@emnapi/runtime', EMNAPI_RUNTIME, ['setImmediate', 'MessageChannel', 'Buffer'], { setImmediate }) as typeof EmnapiRuntime;

/** The process global's own `setImmediate` and `clearImmediate`: the process's immediates (`guest-timers.ts`). */
type Immediates = { setImmediate(callback: () => void): unknown; clearImmediate(id: unknown): void };

type CleanupHook = EmnapiRuntime.CleanupHookCallbackFunction;

/**
 * The process's emnapi context (ADR-0011 §6, "One context per process"): emnapi's own, its public doors carrying what
 * the process's end needs. Each cleanup hook runs as a teardown call of the process (`teardownCall`), so a throw from
 * one leaves the rest to run. A registration is one (env, fn, arg), as Node's `CleanupQueue` keys one: a duplicate of a
 * live one is refused by emnapi's own queue, one removed is skipped, and one re-added after its removal is a new
 * registration; one removed while the queue drains stays in emnapi's queue until the drain takes it, so the drain's
 * own removal finds it, and is skipped there.
 */
function processContext(runtime: typeof EmnapiRuntime, owner: ProcessAddons): EmnapiRuntime.Context {
  const live = new Map<EmnapiRuntime.Env, Map<CleanupHook, Map<number, (arg: number) => void>>>();
  const take = (env: EmnapiRuntime.Env, fn: CleanupHook, arg: number): ((arg: number) => void) | undefined => {
    const byArg = live.get(env)?.get(fn);
    const guarded = byArg?.get(arg);
    byArg?.delete(arg);
    return guarded;
  };
  let draining = false;
  class ProcessContext extends runtime.Context {
    override addCleanupHook(env: EmnapiRuntime.Env, fn: CleanupHook, arg: number): void {
      let byFn = live.get(env);
      if (!byFn) { byFn = new Map(); live.set(env, byFn); }
      let byArg = byFn.get(fn);
      if (!byArg) { byArg = new Map(); byFn.set(fn, byArg); }
      const current = byArg.get(arg);
      // A duplicate of a live registration is emnapi's queue's to refuse ("Can not add same fn and arg twice").
      if (current) { super.addCleanupHook(env, current, arg); return; }
      const guarded = (value: number): void => {
        if (live.get(env)?.get(fn)?.get(arg) !== guarded) return;
        take(env, fn, arg);
        owner.teardownCall(() => { if (typeof fn === 'number') env.makeDynCall_vp(fn)(value); else fn(value); });
      };
      byArg.set(arg, guarded);
      super.addCleanupHook(env, guarded, arg);
    }

    override removeCleanupHook(env: EmnapiRuntime.Env, fn: CleanupHook, arg: number): void {
      const guarded = take(env, fn, arg);
      if (guarded && !draining) super.removeCleanupHook(env, guarded, arg);
    }

    override runCleanup(): void {
      draining = true;
      try { super.runCleanup(); } finally { draining = false; }
    }

    override increaseWaitingRequestCounter(): void {
      owner.requestWaits();
      super.increaseWaitingRequestCounter();
    }

    override decreaseWaitingRequestCounter(): void {
      super.decreaseWaitingRequestCounter();
      owner.requestDone();
    }
  }
  return new ProcessContext();
}

/**
 * One process's addon runtime (ADR-0011 §6): its emnapi evaluation and context, its opened files, emnapi's native
 * immediates and its waiting native requests, as one owned handle of the process, registered stopped. It is made at
 * the process's first open that reaches the linker and ended only by the process's end, however it ends.
 */
class ProcessAddons implements OwnedHandle {
  readonly context: EmnapiRuntime.Context;
  readonly libraries = new Map<string, Library>();
  readonly token: ProcessToken | null;
  /**
   * emnapi's native immediates still to run (Node's `Environment::native_immediates_`): each scheduled as the process's
   * own immediate while it lives, and run by its end rather than cancelled with its ordinary work.
   */
  private readonly immediates = new Map<() => void, unknown>();
  /** emnapi-mt's native requests in flight (Node's `request_waiting_`), counted through the context's doors. */
  private waiting = 0;
  /** Whether the process's end has begun. */
  ending = false;
  /** The end's native teardown, settled when it is done (`OwnedHandle.released`). */
  released?: Promise<void>;
  /** What the teardown waits on between turns: the next native event. */
  private wake: (() => void) | null = null;
  /** Throws no run could take as its own, which the teardown's completion carries. */
  private readonly failures: unknown[] = [];

  constructor(readonly process: object, private readonly guest: Immediates) {
    this.context = processContext(runtimeOf(process, this.setImmediate), this);
    this.token = __tokenForProcess(process as Process);
    registerHandle(this, false, false);
    if (ownerOf(this) !== this.token) __adoptHandle(this, this.token);
    owners.set(process, this);
  }

  /** emnapi's `setImmediate`: a native immediate of the process (`immediates`). */
  readonly setImmediate = (callback: () => void): void => {
    const run = (): void => { if (this.immediates.delete(run)) callback(); };
    this.immediates.set(run, this.ending ? undefined : this.guest.setImmediate(run));
    this.wake?.();
  };

  requestWaits(): void {
    this.waiting += 1;
  }

  requestDone(): void {
    if (this.waiting > 0) this.waiting -= 1;
    this.wake?.();
  }

  /**
   * A call of the runtime's cleanup, in the process's run. While the process lives (emnapi's own `beforeExit` destroy)
   * a throw is its uncaught exception, one no run takes kept for the end; once the end has begun the process has
   * exited and runs no report of its own, so a throw is the end's failure. Either way the cleanup goes on.
   */
  teardownCall(call: () => void): void {
    try { ownedRun(this.token, call, !this.ending, 'native-teardown'); }
    catch (error) { this.failures.push(error); }
  }

  /** A thread's `uv_async_send`, called through the table as emnapi's own listener calls it, in the process's run. */
  deliver(library: Library, callback: number, data: number): void {
    const call = (): void => (library.loaded.table.get(callback) as (data: number) => void)(data);
    if (!this.ending) { ownedRun(this.token, call, true, 'native-async'); return; }
    this.teardownCall(call);
    this.wake?.();
  }

  /** The process's end (ADR-0011 §6, "A process's end"): its native teardown starts, settling `released`. */
  close(): void {
    if (this.ending) return;
    this.ending = true;
    this.released = this.teardown();
  }

  /**
   * As Node's `FreeEnvironment` and `RunCleanup`: the context destroyed (no call into JavaScript, every cleanup hook),
   * then every native immediate run and the cleanup queue run again, at once while either left a native immediate
   * queued, and on the next native event while only a native request waits (the thread queues keep delivering); then
   * the thread queues stopped.
   */
  private async teardown(): Promise<void> {
    this.teardownCall(() => this.context.destroy());
    for (;;) {
      for (let next = this.immediates.entries().next(); !next.done; next = this.immediates.entries().next()) {
        const [run, id] = next.value;
        if (id !== undefined) this.guest.clearImmediate(id);
        this.teardownCall(run);
      }
      this.teardownCall(() => this.context.runCleanup());
      // Runnable work goes again now, as `RunCleanup` repeats `CleanupHandles` while native immediates remain.
      if (this.immediates.size > 0) continue;
      if (this.waiting === 0) break;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
    for (const library of this.libraries.values()) stopNative(library.queue);
    releaseHandle(this);
    if (this.failures.length === 1) throw this.failures[0];
    if (this.failures.length > 1) throw new AggregateError(this.failures, 'the process\'s native teardown failed');
  }
}

/**
 * Opens `path` in `process` (§2): validated, its imports answered, loaded by the loading process's tree, its queue
 * read. A refusal leaves the process's addon runtime as it was (§6).
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

  const owner = owners.get(process) ?? new ProcessAddons(process, nodeLibGlobalFor(process) as Immediates);
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
}

/**
 * `process.dlopen(target, path)` of a file whose bytes are `bytes` (ADR-0011 §1): the file opened once in its process
 * (§2), and its initializer called with an environment of its own on `exports` (`target.exports` as an object), its
 * answer `target.exports` where it is another value (§6).
 */
export function dlopenNative(process: object, target: { exports?: unknown; filename?: unknown }, exports: object, path: string,
  bytes: Uint8Array): void {
  // No JavaScript runs once Node's environment is being freed (§6).
  if (owners.get(process)?.ending) throw dlopenFailed(path + ': the process is exiting');
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
