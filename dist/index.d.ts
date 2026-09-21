/**
 * tabnode's public surface.
 *
 * The engine is a library the substrate embeds: a filesystem, a runtime, a
 * container over the two, the npm client that fills the tree, the bridge a
 * page's requests reach a guest's server through, and the resolver. What a
 * guest requires is not here -- a guest reaches its builtins through the
 * runtime's own module table, which is `runtime.ts`.
 */
export { restoreHostGlobals, guestRealmInstalled } from './host-globals';
export { VirtualFS } from './virtual-fs';
export type { FSNode, Stats, FSWatcher, WatchListener, WatchEventType } from './virtual-fs';
export { Runtime, execute } from './runtime';
export type { Module, RuntimeOptions, RequireFunction } from './runtime';
export { createRuntime, WorkerRuntime } from './create-runtime';
export type { IRuntime, IExecuteResult, CreateRuntimeOptions, IRuntimeOptions, VFSSnapshot } from './runtime-interface';
export { createFsShim } from './shims/fs';
export type { FsShim } from './shims/fs';
export { createProcess } from './shims/process';
export type { Process, ProcessEnv } from './shims/process';
export * as path from './shims/path';
export { httpModule as http, httpsModule as https } from './node-lib/http-module';
export { netModule as net } from './node-lib/net-module';
export { eventsModule as events } from './node-lib/events-module';
export { streamModule as stream } from './node-lib/stream-module';
export { bufferModule as buffer } from './node-lib/buffer-module';
export * as url from './shims/url';
export { utilModule as util } from './node-lib/util-module';
export * as npm from './npm';
export { PackageManager, install } from './npm';
export { ServerBridge, getServerBridge, resetServerBridge } from './server-bridge';
export type { InitServiceWorkerOptions } from './server-bridge';
/** What a page's request is answered with, the shape the bridge answers. */
export type { ResponseData } from './node-lib/http-bridge';
export * as esbuild from './shims/esbuild';
export * as rollup from './shims/rollup';
export * as module from './shims/module';
export * as perf_hooks from './shims/perf_hooks';
export * as worker_threads from './shims/worker_threads';
import { VirtualFS } from './virtual-fs';
import { Runtime, RuntimeOptions } from './runtime';
import { PackageManager } from './npm';
import { ServerBridge } from './server-bridge';
import { type Socket as NetSocket } from './node-lib/net-module';
import { runPid, processByPid } from './process-tokens';
export { runPid, processByPid };
export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export interface RunOptions {
    cwd?: string;
    /** The environment the command runs in, as `child_process.exec` takes it. */
    env?: Record<string, string>;
    /** What the shell reads on stdin, so a builtin reads what was piped to it. */
    stdin?: string;
    /** Callback for streaming stdout chunks as they arrive (for long-running commands like vitest watch) */
    onStdout?: (data: string) => void;
    /** Callback for streaming stderr chunks as they arrive */
    onStderr?: (data: string) => void;
    /** AbortSignal to cancel long-running commands */
    signal?: AbortSignal;
    /**
     * A name for this run. The `node` command records the guest process it
     * creates under it for the run's lifetime, and the container answers
     * `pendingTimers`, `processPorts` and `stopProcess` about that name.
     */
    processToken?: string;
    /**
     * The host keeps this run open (a watch or an interactive shell); a run that
     * is not held ends when its loop has nothing left, as Node's does. A
     * `signal` alone is an abort handle, not a hold.
     */
    held?: boolean;
}
export interface ContainerOptions extends RuntimeOptions {
    /** The filesystem the container runs on; one is built in memory when absent. */
    vfs?: VirtualFS;
    baseUrl?: string;
    onServerReady?: (port: number, url: string) => void;
}
/**
 * Create a new WebContainer-like environment
 */
export declare function createContainer(options?: ContainerOptions): {
    vfs: VirtualFS;
    runtime: Runtime;
    npm: PackageManager;
    serverBridge: ServerBridge;
    execute: (code: string, filename?: string) => {
        exports: unknown;
    };
    runFile: (filename: string) => {
        exports: unknown;
    };
    run: (command: string, options?: RunOptions) => Promise<RunResult>;
    pendingTimers: (token: string) => number;
    processPorts: (token: string) => number[];
    stopProcess: (token: string) => boolean;
    /**
     * Input for one run's guest, by its process token; without a token, the most
     * recently started held run, which is the prompt a person is typing to.
     */
    sendInput: (data: string, token?: string) => void;
    /** The run whose guest code is executing, for a caller attributing a child. */
    currentProcessToken: () => string | null;
    /** The numbers a named run, or the current one, was started with. */
    runPid: (token?: string | null) => {
        pid: number;
        ppid: number;
    } | undefined;
    /** The numbers a live process carries, looked up by its own pid. */
    processByPid: (pid: number) => {
        pid: number;
        ppid: number;
    } | undefined;
    listenNet: (port: number, onConnection: (socket: NetSocket) => void) => () => void;
    createREPL: () => {
        eval: (code: string) => unknown;
    };
    on: (event: string, listener: (...args: unknown[]) => void) => void;
};
export default createContainer;
export { createNodeResolver } from './node-resolution';
export type { ResolutionFs, ExportsResolver, NodeResolverOptions, NodeResolver } from './node-resolution';
//# sourceMappingURL=index.d.ts.map