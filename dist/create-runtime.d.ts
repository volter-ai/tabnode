/**
 * A runtime, on the thread the caller asks for.
 *
 * The engine runs a guest on the page's own thread or on a worker of its
 * own; which one is the embedder's call, and both answer the same interface.
 * Isolation is the embedder's to place -- the substrate gives a run its own
 * origin through a worker it serves itself -- so nothing here decides it.
 */
import type { VirtualFS } from './virtual-fs';
import type { IRuntime, CreateRuntimeOptions } from './runtime-interface';
/**
 * Create a runtime on the thread the options name.
 *
 * `useWorker` puts the guest on a worker of the engine's own, `'auto'` does
 * so where the realm has workers, and the default runs it on the caller's
 * thread behind the same asynchronous interface.
 */
export declare function createRuntime(vfs: VirtualFS, options?: CreateRuntimeOptions): Promise<IRuntime>;
export { Runtime } from './runtime';
export { WorkerRuntime } from './worker-runtime';
export type { IRuntime, IExecuteResult, IRuntimeOptions, CreateRuntimeOptions, VFSSnapshot, } from './runtime-interface';
//# sourceMappingURL=create-runtime.d.ts.map