/**
 * Runtime Interface - Common interface for main-thread and worker runtimes
 */
import type { VirtualFS } from './virtual-fs';
export interface IRuntimeOptions {
    cwd?: string;
    env?: Record<string, string>;
    onConsole?: (method: string, args: unknown[]) => void;
}
export interface IModule {
    id: string;
    filename: string;
    exports: unknown;
    loaded: boolean;
    children: IModule[];
    paths: string[];
}
export interface IExecuteResult {
    exports: unknown;
    module: IModule;
}
/**
 * Common runtime interface implemented by both MainThreadRuntime and WorkerRuntime
 */
export interface IRuntime {
    /**
     * Execute code as a module
     */
    execute(code: string, filename?: string): Promise<IExecuteResult>;
    /**
     * Run a file from the virtual file system
     */
    runFile(filename: string): Promise<IExecuteResult>;
    /**
     * Clear the module cache
     */
    clearCache(): void;
    /**
     * Get the virtual file system (only available on main thread runtime)
     */
    getVFS?(): VirtualFS;
    /**
     * Terminate the runtime (only applicable to worker runtime)
     */
    terminate?(): void;
}
/**
 * Options for creating a runtime
 */
export interface CreateRuntimeOptions extends IRuntimeOptions {
    /**
     * Which thread the guest runs on.
     * - false (default): the caller's thread
     * - true: a worker of the engine's own
     * - 'auto': a worker where the realm has them, the caller's thread otherwise
     *
     * A worker is a thread, not an origin: it reaches the page's storage and
     * its network. An embedder that needs origin isolation serves the run from
     * an origin of its own, which is the substrate's isolation worker.
     */
    useWorker?: boolean | 'auto';
}
/**
 * VFS snapshot for transferring to worker
 */
export interface VFSSnapshot {
    files: VFSFileEntry[];
}
export interface VFSFileEntry {
    path: string;
    type: 'file' | 'directory';
    content?: string;
}
//# sourceMappingURL=runtime-interface.d.ts.map