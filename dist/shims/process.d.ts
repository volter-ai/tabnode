/**
 * Node.js process shim
 * Provides minimal process object for browser environment
 * Process is an EventEmitter in Node.js
 */
import type { EventListener } from '../node-lib/events-module';
import { Readable } from '../node-lib/stream-module';
export interface ProcessEnv {
    [key: string]: string | undefined;
}
interface ProcessStream {
    isTTY: boolean;
    on: (event: string, listener: EventListener) => ProcessStream;
    once: (event: string, listener: EventListener) => ProcessStream;
    off: (event: string, listener: EventListener) => ProcessStream;
    emit: (event: string, ...args: unknown[]) => boolean;
    addListener: (event: string, listener: EventListener) => ProcessStream;
    removeListener: (event: string, listener: EventListener) => ProcessStream;
    removeAllListeners: (event?: string) => ProcessStream;
    setMaxListeners: (n: number) => ProcessStream;
    getMaxListeners: () => number;
    listenerCount: (event: string) => number;
    listeners: (event: string) => EventListener[];
    rawListeners: (event: string) => EventListener[];
    prependListener: (event: string, listener: EventListener) => ProcessStream;
    prependOnceListener: (event: string, listener: EventListener) => ProcessStream;
    eventNames: () => (string | symbol)[];
    pause?: () => ProcessStream;
    resume?: () => ProcessStream;
    pipe: (destination: unknown) => unknown;
    unpipe: () => ProcessStream;
    isPaused: () => boolean;
    unshift: () => void;
    setEncoding?: (encoding: string) => ProcessStream;
    columns: number;
    rows: number;
    clearLine: (direction: number | (() => void), callback?: () => void) => boolean;
    cursorTo: (x: number, y?: number | (() => void), callback?: () => void) => boolean;
    moveCursor: (dx: number, dy: number, callback?: () => void) => boolean;
    getWindowSize: () => [number, number];
    hasColors: () => boolean;
    getColorDepth: () => number;
}
interface ProcessWritableStream extends ProcessStream {
    write: (data: string | Buffer, encoding?: string, callback?: () => void) => boolean;
    end?: (data?: string, callback?: () => void) => void;
}
/**
 * `process.stdin` is a readable stream on Node -- a `net.Socket` when fd 0 is
 * a pipe, an `fs.ReadStream` when it is a file, a `tty.ReadStream` when it is
 * a terminal -- and the engine's was a plain object carrying `on` and `pipe`.
 * A program that treats it as one refused it: byline, which Prisma's own code
 * generator reads its JSON-RPC requests through, checks `instanceof
 * stream.Readable` and throws; so does anything that pipes it, iterates it,
 * asks it to `read()`, or waits on 'readable' or 'end'.
 *
 * A tab has no terminal, so the case this models is Node's pipe: the guest's
 * standard input is whatever the shell put on fd 0 -- the text left of a pipe,
 * or `container.run(..., { stdin })` -- and it is complete when the guest
 * starts, so the stream carries those bytes and then ends, exactly as
 * `node script.js < file` does. Where a runner can still feed the guest
 * (a held run the host writes to with `sendStdin`), it leaves the stream open
 * instead, which is Node's pipe whose writer has not closed. A terminal is
 * not invented: `isTTY` stays false unless a runner says otherwise, and there
 * is no `setRawMode` that does anything, because there is no raw mode to set.
 */
/**
 * The guest's fd 0: a `Readable` the engine pushes into.
 *
 * Built the first time a process is made, not when this module is evaluated:
 * `Readable` is Node's own class out of a vendored file, and `extends` reads
 * the superclass at class-definition time, which is before the loader that
 * builds it exists. See `node-lib/lazy.ts`.
 */
export interface ProcessStdin extends Readable {
    readonly fd: number;
    isTTY: boolean;
    setRawMode(mode: boolean): ProcessStdin;
    __substrateStdinWrite(data: string | Uint8Array): void;
    __substrateStdinEnd(): void;
}
type ProcessReadableStream = ProcessStdin;
export interface Process {
    env: ProcessEnv;
    cwd: () => string;
    chdir: (directory: string) => void;
    platform: string;
    version: string;
    versions: {
        node: string;
        v8: string;
        uv: string;
        webcontainer?: string;
        openssl?: string;
    };
    arch?: string;
    argv: string[];
    argv0: string;
    execPath: string;
    execArgv: string[];
    /** Node's `process.config`: how the binary was built. */
    config: {
        target_defaults: Record<string, unknown>;
        variables: Record<string, unknown>;
    };
    /** Node's `process.features`: what the binary was built with. */
    features: Record<string, boolean | string | undefined>;
    /**
     * Node's `process.moduleLoadList`: every builtin this process has loaded,
     * in the order it first loaded each, as `NativeModule <id>`. A program reads
     * it to tell whether a module is already in memory before it does something
     * that would pull it in; Node's own tests read it that way.
     */
    moduleLoadList: string[];
    /**
     * Node's uncaught-exception capture pair. A program that sets a callback
     * takes every uncaught exception instead of the `uncaughtException` event,
     * and `domain` asks whether one is set before it installs its own handling.
     */
    setUncaughtExceptionCaptureCallback: (callback: ((error: unknown) => void) | null) => void;
    hasUncaughtExceptionCaptureCallback: () => boolean;
    /** Node's `process.umask()`: the file-mode mask this process creates with. */
    umask: (mask?: number | string) => number;
    pid: number;
    ppid: number;
    exit: (code?: number) => never;
    /** What a script that returned without calling `exit` exits with. */
    exitCode?: number;
    /** Node's `process.kill`, raising a signal on the guest's own process. */
    kill: (pid: number, signal?: string | number) => boolean;
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
    /** Node's deprecated `process.binding`, which bundles still feature-detect through. */
    binding: (name: string) => unknown;
    /** Node's deprecated `process.assert`: assert.ok. */
    assert: (value: unknown, message?: string) => void;
    /** Node's `process.emitWarning`, which fs-extra calls on its way into every
     *  React Router build; a warning goes to stderr the way Node prints one. */
    emitWarning: (warning: string | Error, ...rest: unknown[]) => void;
    stdout: ProcessWritableStream;
    stderr: ProcessWritableStream;
    stdin: ProcessReadableStream;
    hrtime: {
        (time?: [number, number]): [number, number];
        bigint: () => bigint;
    };
    memoryUsage: () => {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
        arrayBuffers: number;
    };
    /** Node's `process.constrainedMemory`: a cgroup's limit, 0 when there is none. */
    constrainedMemory: () => number;
    /** Node's `process.availableMemory`: the memory still free, from the same place `os.freemem` reads. */
    availableMemory: () => number;
    uptime: () => number;
    cpuUsage: () => {
        user: number;
        system: number;
    };
    on: (event: string, listener: EventListener) => Process;
    once: (event: string, listener: EventListener) => Process;
    off: (event: string, listener: EventListener) => Process;
    emit: (event: string, ...args: unknown[]) => boolean;
    addListener: (event: string, listener: EventListener) => Process;
    removeListener: (event: string, listener: EventListener) => Process;
    removeAllListeners: (event?: string) => Process;
    listeners: (event: string) => EventListener[];
    listenerCount: (event: string) => number;
    prependListener: (event: string, listener: EventListener) => Process;
    prependOnceListener: (event: string, listener: EventListener) => Process;
    eventNames: () => (string | symbol)[];
    setMaxListeners: (n: number) => Process;
    getMaxListeners: () => number;
    send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
    connected?: boolean;
}
/**
 * The guest's children are processes it can see. `process.kill(pid, 0)`
 * answered ESRCH for every pid but the guest's own, so a program that keeps its
 * children's pids and asks whether they still run judged every live child dead.
 * src/shims/child_process.ts fills this table as it spawns.
 */
export declare const __substrateChildren: Map<number, {
    exitCode: number | null;
    signalCode: string | null;
    kill(signal?: string): boolean;
}>;
/** Record how a running program reports an exception nobody caught; answers a release. */
export declare function __onUncaughtException(process: object, report: (error: unknown) => void): () => void;
/**
 * Report an exception as the named process's own. False when no program owns
 * it — the engine imported as a library into a Node host, where the host's own
 * failure reporting is the right one and the caller rethrows.
 */
export declare function __reportUncaughtException(process: object | null | undefined, error: unknown): boolean;
export declare function __substrateUncaughtCapture(): ((error: unknown) => void) | null;
export declare function __substrateExitCode(code: unknown): number;
export declare function createProcess(options?: {
    cwd?: string;
    env?: ProcessEnv;
    /** This process's own number and its parent's, as Node gives every process. */
    pid?: number;
    ppid?: number;
    onExit?: (code: number) => void;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    /** What the runner put on the guest's fd 0, as a shell puts the left of a pipe there. */
    stdin?: string;
    /**
     * The runner can still write to the guest's fd 0 (a held run fed with
     * `sendStdin`), so standard input does not end when the guest starts. Node's
     * pipe whose writer has not closed: the stream stays open and empty.
     */
    stdinHeld?: boolean;
    /**
     * The run was given a TTY. A pipe (a spawned child, a cell that is not
     * held) is not one: Node does not inherit FORCE_COLOR onto a pipe, and
     * `util.inspect` of an Error would colorize a stack and then ask
     * `BuiltinModule.exists` of every `node:` frame.
     */
    tty?: boolean;
}): Process;
export {};
//# sourceMappingURL=process.d.ts.map