/**
 * A process's native addons, as its kernel's substrate loads them (ADR-0011 §7).
 *
 * On Linux `dlopen(3)` maps a shared object into the process's address space and binds its imports. A tab's addon is a
 * WALI Node-API side module (browser-substrate ADR-0231), and the substrate's own dynamic linker places it in the
 * process's one user memory, binds its `wali` imports to the calling task, and instantiates it again in each of the
 * process's thread workers. A tree that is a client of a kernel offers that one call under `TREE_NATIVE`; the engine
 * supplies the Node-API side of the imports (emnapi's) and calls the module's initializer.
 *
 * A tree that offers no `TREE_NATIVE` loads no addon.
 */
import { callingTree } from './host-sockets';

/** The key a tree offers its process's addon loads under. */
export const TREE_NATIVE = Symbol.for('tabnode.tree.native');

/** The module a thread's worker imports for its side of an addon's imports (`threadImports`, `native-thread.ts`). */
export const NATIVE_THREAD_MODULE = '@volter/tabnode/native-thread';

/** One addon load. */
export interface NativeLoadRequest {
  /** The file's path, as `dlopen` names it in its errors. */
  readonly path: string;
  /** The file's bytes: a WebAssembly side module with a `dylink.0` section. */
  readonly bytes: Uint8Array;
  /** The engine's imports, beside the process's `wali` imports and the linker's own: `env`, `napi`, `emnapi`. */
  readonly imports: WebAssembly.Imports;
  /**
   * A thread's side of `imports`: each thread worker the process starts for this module imports `module` and calls its
   * `threadImports(queue)` for the imports it instantiates the module with.
   */
  readonly thread: { readonly module: string; readonly queue: SharedArrayBuffer };
}

/** A loaded addon: its instance in the process's memory, and that memory and table. */
export interface NativeLoaded {
  readonly instance: WebAssembly.Instance;
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly table: WebAssembly.Table;
}

/** The addon loads of one process. */
export interface TreeNative {
  /**
   * Loads one module into the process's user memory by the substrate's dynamic linker, running its relocations and
   * constructors, or answers the linker's own refusal (an ABI other than the process's, an import nothing answers).
   */
  load(request: NativeLoadRequest): NativeLoaded | { readonly error: string };
}

/** The addon loads a tree offers, where it offers them. */
function treeNativeOf(tree: unknown): TreeNative | undefined {
  if (tree === null || (typeof tree !== 'object' && typeof tree !== 'function')) return undefined;
  const offered = (tree as Record<symbol, unknown>)[TREE_NATIVE];
  return offered !== null && typeof offered === 'object' ? offered as TreeNative : undefined;
}

/** The addon loads of the process that is calling (its tree's, `callingTree`). */
export function callingNative(): TreeNative | undefined {
  return treeNativeOf(callingTree());
}
