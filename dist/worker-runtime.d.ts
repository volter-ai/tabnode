/**
 * WorkerRuntime - Runs code in a Web Worker for non-blocking execution
 *
 * This class provides the same IRuntime interface as Runtime,
 * but executes code in a separate Web Worker thread.
 */
import type { VirtualFS } from './virtual-fs';
import type { IRuntime, IExecuteResult, IRuntimeOptions } from './runtime-interface';
/**
 * WorkerRuntime - Executes code in a Web Worker
 */
export declare class WorkerRuntime implements IRuntime {
    private worker;
    private workerApi;
    private vfs;
    private options;
    private initialized;
    private changeListener;
    private deleteListener;
    constructor(vfs: VirtualFS, options?: IRuntimeOptions);
    /**
     * Initialize the worker with VFS snapshot and options
     */
    private initWorker;
    /**
     * Set up listeners for VFS changes to sync to worker
     */
    private setupVFSListeners;
    /**
     * Execute code in the worker
     */
    execute(code: string, filename?: string): Promise<IExecuteResult>;
    /**
     * Run a file from the VFS in the worker
     */
    runFile(filename: string): Promise<IExecuteResult>;
    /**
     * Clear the module cache in the worker
     */
    clearCache(): void;
    /**
     * Get the VFS (main thread instance)
     */
    getVFS(): VirtualFS;
    /**
     * Terminate the worker
     */
    terminate(): void;
}
//# sourceMappingURL=worker-runtime.d.ts.map