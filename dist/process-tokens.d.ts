/**
 * A run the embedding host has named, and the registry the container answers
 * about it from.
 *
 * `container.run(command, { processToken })` names one run. The `node` command
 * records the guest process it creates under that name, for as long as the run
 * lasts, and forgets it when the run ends. Nothing here starts or ends a
 * program: it is the registry three doors read, and the name a server
 * registers itself under while its run is the one launching.
 *
 * The name reaches the `node` command through the shell's environment, under
 * the reserved variable below, because two runs can be in flight at once on
 * one shell and a module-level "the current run" would answer the later one
 * for both. The guest never sees the variable: the environment the `node`
 * command gives its process has it removed.
 */
/** Whatever the embedding runtime uses to name one guest process. */
export type ProcessToken = string;
/** The environment variable a run's name travels in, from `exec` to `node`. */
export declare const PROCESS_TOKEN_ENV = "__TABNODE_PROCESS_TOKEN";
/** What the engine can answer about one named run. */
export interface OwnedRun {
    /** The timers the run's guest still holds, as Node's loop counts them. */
    pendingTimers(): number;
    /** Clear those timers, as ending the process clears them. */
    stopTimers(): void;
    /**
     * Report an exception nobody caught as this run's own, the way Node's
     * process reports one: the run's `uncaughtException` listeners, else its
     * stderr and exit 1. False when the run no longer answers.
     */
    reportUncaught(error: unknown): boolean;
}
/** Run `fn` as this token's guest code, so the doors below name that run. */
export declare function enterRun<T>(token: ProcessToken, fn: () => T): T;
/**
 * Record a named run's guest for the run's lifetime. The answer releases it;
 * releasing twice is harmless, as a run ends once.
 */
export declare function __recordRun(token: ProcessToken, run: OwnedRun): () => void;
/** The run recorded under this name, while it lasts. */
export declare function __runFor(token: ProcessToken): OwnedRun | undefined;
/**
 * The run now launching a guest, for a handle or a server the guest opens
 * after its entry has returned, when no run is the current one any more.
 * `enterRun`'s async-local value covers the guest's own turn and everything
 * scheduled from inside it; a listen that lands after a native `await`
 * continuation is attributed here.
 */
export declare let __lastLaunchedToken: ProcessToken | null;
export declare function __setLastLaunchedToken(token: ProcessToken | null): void;
/** The run a guest is being launched under, where the host named one. */
export declare function __currentProcessToken(): ProcessToken | null;
/**
 * End a named run's timers. The servers it owns are released by `http`'s own
 * half, `__releaseOwnedServers`, which calls this for the timers.
 */
export declare function __stopOwnedProcess(token: ProcessToken): void;
/** The next process number this engine hands out. */
export declare function mintPid(): number;
/** Record the numbers a named run was started with, for the run to read back. */
export declare function setRunPid(token: ProcessToken, pid: number, ppid: number): void;
/** The numbers a named run was started with, where one was recorded. */
export declare function runPid(token: ProcessToken | null | undefined): {
    pid: number;
    ppid: number;
} | undefined;
/** A run that has ended is no longer a process; its number is nobody's. */
export declare function forgetRunPid(token: ProcessToken): void;
/** Whether a live run carries this number, which is what `kill(pid, 0)` asks. */
export declare function pidIsLive(pid: number): boolean;
/** The numbers a live process carries, looked up by its own pid. */
export declare function processByPid(pid: number): {
    pid: number;
    ppid: number;
} | undefined;
//# sourceMappingURL=process-tokens.d.ts.map