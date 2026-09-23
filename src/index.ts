/**
 * tabnode's public surface.
 *
 * The engine is a library the substrate embeds: a filesystem, a runtime, a
 * container over the two, the npm client that fills the tree, the bridge a
 * page's requests reach a guest's server through, and the resolver. What a
 * guest requires is not here -- a guest reaches its builtins through the
 * runtime's own module table, which is `runtime.ts`.
 */

// Importing this module changes nothing in the realm it is loaded into and
// opens no handle in it; a `Runtime` installs what a guest needs, and this
// hands the host's own globals back. See `host-globals.ts`.
export { restoreHostGlobals, guestRealmInstalled } from './host-globals';
export { VirtualFS } from './virtual-fs';
export type { FSNode, MountedTree, Stats, FSWatcher, WatchListener, WatchEventType } from './virtual-fs';
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
export { installHttpClientTransport } from './http-client-transport';
export type { HttpClientExchange, HttpClientExchangeRequest, HttpClientExchangeResponse, HttpClientTransportFactory } from './http-client-transport';
import { __releaseOwnedServers, __ownedServerPorts } from './node-lib/net-module';
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
// The bundlers' own wasm builds, as doors: a host that builds outside a run
// (the substrate's rolldown pass) reaches them here rather than through a
// guest's `require`.
export * as esbuild from './shims/esbuild';
export * as rollup from './shims/rollup';
export * as module from './shims/module';
export * as perf_hooks from './shims/perf_hooks';
export * as worker_threads from './shims/worker_threads';

import { VirtualFS } from './virtual-fs';
import { Runtime, RuntimeOptions } from './runtime';
import { PackageManager } from './npm';
import { ServerBridge, getServerBridge } from './server-bridge';
import { runCommand, registerRunStreams, releaseRunStreams, sendStdin } from './shims/child_process';
import { Server as NetServer, __releaseOwnedHandles, type Socket as NetSocket } from './node-lib/net-module';
import { __adoptHandle, ownerOf, type OwnedHandle } from './node-lib/binding/handles';
import { listenerOnPort } from './node-lib/binding/tcp_wrap';
import { nativeStreamOwnerPid } from './native-stream-owner';

import { __currentProcessToken, __runFor, __signalOwnedProcess, __takeTermination, __stopOwnedProcess, runPid, processByPid } from './process-tokens';
export { runPid, processByPid };
export { createProcessRegistryScope, installProcessRegistry, ownerProcessRegistryScope, ownerProcessTable } from './process-tokens';
export { installNodeProcessHost, nodeProcessHostInstalled } from './node-process-host';
export type { NodeProcessLaunch, NodeProcessHost } from './node-process-host';
export type { ProcessIdentity, ProcessRegistry, ProcessRegistryScope, InitialProcessRegistration } from './process-registry';
export { NativeStreamScope } from './native-stream-owner';
export { installNativeStreamTransport, nativeStreamDescriptor } from './native-stream-binding';
export type { NativeStreamDescriptor, NativeStreamLimits, NativeStreamEvent, NativeStreamOperation, NativeStreamReply, NativeStreamTransport } from './native-stream-owner';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The signal whose default action ended the run's guest, as Node reports a process a signal ended. */
  signal?: string;
}

export interface RunOptions {
  cwd?: string;
  /** The environment the command runs in, as `child_process.exec` takes it. */
  env?: Record<string, string>;
  /** What the shell reads on stdin, so a builtin reads what was piped to it. */
  stdin?: string;
  stdinStream?: AsyncIterable<Uint8Array>;
  terminal?: { columns: number; rows: number; onResize?: (listener: (columns: number, rows: number) => void) => () => void };
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

/** Names for runs the caller did not name; a run's state is kept under its name. */
let __nextRunName = 1;

export interface ContainerOptions extends RuntimeOptions {
  /** The filesystem the container runs on; one is built in memory when absent. */
  vfs?: VirtualFS;
  baseUrl?: string;
  onServerReady?: (port: number, url: string) => void;
}

/**
 * Create a new WebContainer-like environment
 */
export function createContainer(options?: ContainerOptions): {
  vfs: VirtualFS;
  runtime: Runtime;
  npm: PackageManager;
  serverBridge: ServerBridge;
  execute: (code: string, filename?: string) => { exports: unknown };
  runFile: (filename: string) => { exports: unknown };
  run: (command: string, options?: RunOptions) => Promise<RunResult>;
  pendingTimers: (token: string) => number;
  processPorts: (token: string) => number[];
  /** The pid of the process listening on a port of this engine, where a guest process is: `/proc`'s socket owner. */
  portPid: (port: number) => number | undefined;
  /** Deliver a signal to the named run as another process's `kill(pid)` does; false when the run is gone. */
  signalProcess: (token: string, signal: string) => boolean;
  stopProcess: (token: string) => boolean;
  /**
   * Input for one run's guest, by its process token; without a token, the most
   * recently started held run, which is the prompt a person is typing to.
   */
  sendInput: (data: string, token?: string) => void;
  /** The run whose guest code is executing, for a caller attributing a child. */
  currentProcessToken: () => string | null;
  /** The numbers a named run, or the current one, was started with. */
  runPid: (token?: string | null) => { pid: number; ppid: number } | undefined;
  /** The numbers a live process carries, looked up by its own pid. */
  processByPid: (pid: number) => { pid: number; ppid: number } | undefined;
  listenNet: (port: number, onConnection: (socket: NetSocket) => void) => () => void;
  createREPL: () => { eval: (code: string) => unknown };
  on: (event: string, listener: (...args: unknown[]) => void) => void;
} {
  // A container takes the filesystem it is given. Building its own in memory
  // with no way to hand it another left the worker that owns the origin's store
  // unable to give it one that keeps the index in memory and the bytes in the
  // pack.
  const vfs = (options && options.vfs) || new VirtualFS();
  const runtime = new Runtime(vfs, options);
  const npmManager = new PackageManager(vfs);
  // A container owns its servers. One process-wide bridge meant two runtimes in
  // one page shared a port space: the second dev server to claim 5173 took the
  // first one's requests, and a consumer that asked for two isolated runtimes
  // got one. Each container holds its own bridge, and the page decides which of
  // them a preview or a service worker is wired to.
  const serverBridge = new ServerBridge({
    baseUrl: options?.baseUrl,
    onServerReady: options?.onServerReady,
  });

  return {
    vfs,
    runtime,
    npm: npmManager,
    serverBridge,
    execute: (code: string, filename?: string) => runtime.execute(code, filename),
    runFile: (filename: string) => runtime.runFile(filename),
    run: (command: string, runOptions?: RunOptions): Promise<RunResult> => {
      // If signal is already aborted, resolve immediately
      if (runOptions?.signal?.aborted) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 130 });
      }

      // Every run has a name, because what the host gave this run — its
      // streams, its signal, whether it is held — is kept under that name and
      // not in a module global a child's run would overwrite.
      const processToken = typeof runOptions?.processToken === 'string' && runOptions.processToken.length > 0
        ? runOptions.processToken
        : `run-${__nextRunName++}`;
      registerRunStreams(processToken, {
        onStdout: runOptions?.onStdout,
        onStderr: runOptions?.onStderr,
        signal: runOptions?.signal,
        held: runOptions?.held === true,
        stdinStream: runOptions?.stdinStream,
        stdinOpen: runOptions?.stdinStream !== undefined,
        terminal: runOptions?.terminal,
      });

      return new Promise((resolve) => {
        // `container.run("cat", { stdin })` used to reach the engine's shell
        // without its stdin: the run dropped it before exec, and exec dropped
        // it before the shell. Both forward it, so a builtin reads what was
        // piped, as it does in a Node shell.
        runCommand(command, { cwd: runOptions?.cwd, env: runOptions?.env, stdin: typeof runOptions?.stdin === 'string' ? runOptions.stdin : undefined, processToken, vfs }, (error, stdout, stderr) => {
          releaseRunStreams(processToken);
          const terminatedBy = __takeTermination(processToken);
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: runOptions?.signal?.aborted ? 143 : error ? (error.code ?? 1) : 0,
            ...(terminatedBy ? { signal: terminatedBy } : {}),
          });
        });
      });
    },
    // What a host that named a run can ask about it, and the one thing it can
    // do to it. A run nobody named, and a name nothing runs under, answer as
    // an absent process does: no timers, no ports, and a stop that does
    // nothing.
    /** The timers the named run's guest still holds, as Node's loop counts them. */
    pendingTimers: (token: string): number => __runFor(token)?.pendingTimers() ?? 0,
    /** The ports the servers the named run opened are listening on. */
    processPorts: (token: string): number[] => __ownedServerPorts(token),
    portPid: (port: number): number | undefined => {
      const listener = listenerOnPort(port);
      if (!listener) return undefined;
      // a guest's own listener, or one this engine holds for another worker's process
      return runPid(ownerOf(listener as unknown as OwnedHandle))?.pid ?? nativeStreamOwnerPid(listener);
    },
    /**
     * Deliver a signal to the named run as another process's `kill(pid)` does:
     * the guest's listeners for it run, else its default action ends the run.
     */
    signalProcess: (token: string, signal: string): boolean => __signalOwnedProcess(token, signal),
    /** End the named run: its timers stop and its servers are released. */
    stopProcess: (token: string): boolean => {
      const known = __runFor(token) !== undefined || __ownedServerPorts(token).length > 0;
      // The servers first, and their timers here rather than on a tick of
      // their own: a caller that asks is told what it may then read back.
      __releaseOwnedServers(token, false);
      __releaseOwnedHandles(token);
      __stopOwnedProcess(token);
      return known;
    },
    /**
     * Input for one run's guest, by its process token; without a token, the most
     * recently started held run, which is the prompt a person is typing to.
     */
    sendInput: (data: string, token?: string) => sendStdin(data, token),
    currentProcessToken: () => __currentProcessToken(),
    runPid: (token) => runPid(token === undefined ? __currentProcessToken() : token),
    processByPid,
    // A door for a program of the page to listen on a loopback port with a
    // socket handler of its own, so a guest's `net.connect` reaches it: the
    // registry a connect consults is the `net` shim's, and a server of the
    // shim's own class is what registers in it. The call answers a disposer.
    // The listener is the page's, not a guest's: a handle opened outside any
    // run is otherwise charged to the run launched last, which then read the
    // page's port as its own server and ended when the page stopped listening.
    // Sockets it accepts take its owner, so they hold no guest open either.
    listenNet: (port: number, onConnection: (socket: NetSocket) => void) => {
      const server = new NetServer(onConnection);
      server.listen(port);
      __adoptHandle((server as unknown as { _handle?: OwnedHandle | null })._handle, null);
      return () => { server.close(); };
    },
    createREPL: () => runtime.createREPL(),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      serverBridge.on(event, listener);
    },
  };
}

export default createContainer;

export { installFetchTransport, requestHasStaticBody } from './fetch-transport';
export type { FetchActivity, FetchTransport, FetchTransportContext } from './fetch-transport';

// Node's module resolution as a function over any filesystem, for a host
// that resolves the way the engine does (the substrate's stand-ins do).
export { createNodeResolver } from './node-resolution';
export type { ResolutionFs, ExportsResolver, NodeResolverOptions, NodeResolver } from './node-resolution';
