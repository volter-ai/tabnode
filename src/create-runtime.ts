/**
 * A runtime, on the thread the caller asks for.
 *
 * The engine runs a guest on the page's own thread or on a worker of its
 * own; which one is the embedder's call, and both answer the same interface.
 * Isolation is the embedder's to place -- the substrate gives a run its own
 * origin through a worker it serves itself -- so nothing here decides it.
 */

import { Runtime } from './runtime';
import { WorkerRuntime } from './worker-runtime';
import type { VirtualFS } from './virtual-fs';
import type { IRuntime, IExecuteResult, CreateRuntimeOptions, IRuntimeOptions } from './runtime-interface';

/**
 * Check if Web Workers are available in the current environment
 */
function isWorkerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Wrapper that makes the synchronous Runtime conform to the async IRuntime interface
 */
class AsyncRuntimeWrapper implements IRuntime {
  private runtime: Runtime;

  constructor(vfs: VirtualFS, options: IRuntimeOptions = {}) {
    this.runtime = new Runtime(vfs, options);
  }

  async execute(code: string, filename?: string): Promise<IExecuteResult> {
    return Promise.resolve(this.runtime.execute(code, filename));
  }

  async runFile(filename: string): Promise<IExecuteResult> {
    return Promise.resolve(this.runtime.runFile(filename));
  }

  clearCache(): void {
    this.runtime.clearCache();
  }

  getVFS(): VirtualFS {
    return this.runtime.getVFS();
  }

  /**
   * Get the underlying sync Runtime for direct access to sync methods
   */
  getSyncRuntime(): Runtime {
    return this.runtime;
  }
}

/**
 * Create a runtime on the thread the options name.
 *
 * `useWorker` puts the guest on a worker of the engine's own, `'auto'` does
 * so where the realm has workers, and the default runs it on the caller's
 * thread behind the same asynchronous interface.
 */
export async function createRuntime(
  vfs: VirtualFS,
  options: CreateRuntimeOptions = {}
): Promise<IRuntime> {
  const { useWorker = false, ...runtimeOptions } = options;

  const shouldUseWorker = useWorker === true || useWorker === 'auto' ? isWorkerAvailable() : false;

  if (shouldUseWorker) {
    const workerRuntime = new WorkerRuntime(vfs, runtimeOptions);
    // The worker answers once it has booted; a first execute is that answer.
    await workerRuntime.execute('/* worker ready check */', '/__worker_init__.js');
    return workerRuntime;
  }

  return new AsyncRuntimeWrapper(vfs, runtimeOptions);
}

export { Runtime } from './runtime';
export { WorkerRuntime } from './worker-runtime';
export type {
  IRuntime,
  IExecuteResult,
  IRuntimeOptions,
  CreateRuntimeOptions,
  VFSSnapshot,
} from './runtime-interface';
