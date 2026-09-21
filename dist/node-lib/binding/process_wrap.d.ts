/**
 * `internalBinding('process_wrap')`: one run of the engine, seen as libuv sees
 * a child process.
 *
 * libuv's `uv_spawn` starts a program with its descriptors already wired and
 * answers through `onexit` when it ends; `uv_process_kill` ends it. That is
 * the whole of what `internal/child_process.js` asks of a process, and it is
 * the whole of this file. Nothing here knows about `ChildProcess`, `stdio`
 * streams, `exec`'s buffering, `fork`'s IPC protocol or what a signal means:
 * those are Node's own and are vendored.
 *
 * What the engine already did for a spawned command stays and becomes this
 * file's implementation, through the one door the engine's process model
 * installs below: the routing of a command to the engine's `node`, to a
 * program the page registered, to a WALI pack, or to the shell. A `pipe`
 * stdio entry is paired with an end of its own here, so the child's writes to
 * fd 1 are reads on the parent's handle and the parent's writes to the stdin
 * handle are the child's fd 0 -- which is what a `uv_stdio_container_t` with
 * `UV_CREATE_PIPE` is.
 */
import { LibuvStreamWrap } from './stream_wrap';
import { Pipe } from './pipe_wrap';
import { type OwnedHandle } from './handles';
import type { ProcessToken } from '../../process-tokens';
/** One entry of Node's `options.stdio`, as `getValidStdio` builds it. */
export interface StdioEntry {
    type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap';
    handle?: LibuvStreamWrap;
    fd?: number;
    ipc?: boolean;
    readable?: boolean;
    writable?: boolean;
}
/** What `ChildProcess.prototype.spawn` hands `Process.spawn`. */
export interface ProcessSpawnOptions {
    file: string;
    args?: string[];
    cwd?: string;
    envPairs?: string[];
    stdio: StdioEntry[];
    detached?: boolean;
    windowsHide?: boolean;
    uid?: number;
    gid?: number;
}
/** The channel a forked child is started with, at the descriptor it is told. */
export interface RunChannel {
    /** The number the child's `NODE_CHANNEL_FD` names. */
    fd: number;
    /** The child's end of the channel, which its own `Pipe.open(fd)` finds. */
    pipe: Pipe;
    /** `json` or `advanced`, as `NODE_CHANNEL_SERIALIZATION_MODE` says. */
    serialization: string;
}
/** What the binding asks the engine's process model to run. */
export interface RunRequest {
    /** The program, as the caller named it: a path, a name, or the shell. */
    file: string;
    /** argv, the file first, as Node builds it. */
    args: string[];
    cwd?: string;
    env: Record<string, string>;
    detached: boolean;
    /** Where the child's fd 1 goes; null where nothing reads it. */
    stdout: ((text: string) => void) | null;
    /** Where the child's fd 2 goes; null where nothing reads it. */
    stderr: ((text: string) => void) | null;
    /**
     * True when fd 2 is a pipe the parent holds. A run that ends uncaught or
     * with a nonzero `process.exit` on that pipe writes one receipt to the
     * host realm's console, because the parent may never read the pipe — the
     * tab's extension host dies this way, its stderr going into `@vscode/spdlog`
     * which does not load. Inherit and the host's own stdio are false.
     */
    stderrIsPipe: boolean;
    /** True when the child's fd 0 is a pipe whose writer has not closed. */
    stdinIsPipe: boolean;
    /** The IPC channel the child is started with, where it has one. */
    channel?: RunChannel;
    /** Called once, when the run has ended. */
    exit(code: number, signal: string | null): void;
}
/** One run in flight, as the engine's process model hands it back. */
export interface StartedRun {
    /** The run's own name, so a handle it holds is counted as its own. */
    token: ProcessToken | null;
    /** The run's process number, which is what its own `process.pid` reports. */
    pid?: number;
    /** libuv's `uv_process_kill`: 0, or `UV_ESRCH` for a run already over. */
    kill(signal: string): number;
    /** Bytes the parent wrote to the child's fd 0. */
    writeStdin(bytes: Uint8Array): void;
    /** The parent closed the child's fd 0. */
    endStdin(): void;
}
/**
 * The engine's process model, installed by `initChildProcess`. Until it is
 * there is no engine to run anything, and a spawn answers `ENOENT`, which is
 * what a machine carrying no such program answers.
 */
export interface ProcessRunner {
    /** Whether the engine has a program under this name at all. */
    resolves(request: RunRequest): boolean;
    start(request: RunRequest): StartedRun;
}
/** The engine's process model takes this door once, when the VFS is known. */
export declare function setProcessRunner(next: ProcessRunner): void;
/**
 * libuv's `uv_process_t`.
 *
 * The handle registers with the run that made it, as every handle here does,
 * so a parent waiting on a child is not idle: Node's loop holds a process
 * handle exactly that way, and `unref()` is how a program gives it up.
 */
export declare class Process implements OwnedHandle {
    /** Set by `internal/child_process.js`; the only way an end is reported. */
    onexit: ((exitCode: number, signalCode: string | null) => void) | null;
    /**
     * A process that never started has no pid, and `ChildProcess` copies this
     * one straight onto itself: a child whose `spawn` answered `ENOENT` reports
     * `pid === undefined`, as Node's does, rather than a number naming nothing.
     */
    pid: number | undefined;
    private run;
    private ended;
    private closed;
    /** The stdio entries this run was started with, and their far ends. */
    private stdio;
    private readonly asyncId;
    constructor();
    getAsyncId(): number;
    ref(): void;
    unref(): void;
    hasRef(): boolean;
    /**
     * libuv's `uv_spawn`. Answers 0 for a run that started and a `UV_*` code for
     * one that could not, which is what `ChildProcess.prototype.spawn` turns
     * into an `error` event or a throw.
     */
    spawn(options: ProcessSpawnOptions): number;
    /**
     * libuv's `uv_process_kill`: the run ends, or it was over already. Signal 0
     * is the question "is it still there?", which kills nothing and answers 0
     * for a run in flight and `ESRCH` for one that has ended.
     */
    kill(signal: number | string): number;
    close(callback?: () => void): void;
    /**
     * The other half of a `pipe` entry: the end the child holds. It belongs to
     * no run -- the parent holds the handle Node gave it and the child holds the
     * one it opens; this is the wire between them.
     */
    private pairFarEnd;
    /** The far end of fd `index`, whoever holds it now. */
    private farEndAt;
    private closeFarEnds;
    /** The child wrote to fd `index`; the parent's handle reads it. */
    private toPipe;
    /** Bytes the parent writes reach the child's fd 0; the parent's EOF ends it. */
    private readStdinFrom;
    /**
     * The run has ended. The child's ends of the pairings close, so the parent's
     * streams read EOF as they do when a real child's descriptors go, and
     * `onexit` fires once, after them: Node's `flushStdio` runs on the tick
     * after `onexit` and must find the bytes already delivered.
     */
    private reportExit;
}
declare const _default: {
    Process: typeof Process;
};
export default _default;
//# sourceMappingURL=process_wrap.d.ts.map