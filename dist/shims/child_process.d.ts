/**
 * The engine's process model: what a run of a program IS here.
 *
 * `child_process` itself is Node's own file now, vendored in
 * `src/node-lib/child_process.js` and loaded over the binding in
 * `src/node-lib/binding/`. What is left here is everything that file does not
 * own and cannot know: the `node` command -- a guest program running as a run
 * of the engine, with its own process, its own timers, its own uncaught
 * exceptions and its own idea of when it is done -- the routing of a command
 * line to the host's process host or to the engine's shell, the streams and
 * the name a host gives one run, and the rule that decides a quiet program is
 * finished.
 *
 * `Process.spawn` in the binding reaches all of it through the one door
 * installed at the bottom of `initChildProcess`.
 */
import type { VirtualFS } from '../virtual-fs';
import { type ProcessToken } from '../process-tokens';
/** The stdin of a held run's guest, as the run's own. */
type RunStdin = {
    emit: (event: string, ...args: unknown[]) => void;
    push: (chunk: string | Uint8Array | null) => boolean;
};
/**
 * What a host gave one run: where its output goes, the handle that aborts it,
 * whether the host holds it open, and — while it lasts — its guest's stdin.
 *
 * This is per run and never a module global. A child a guest spawns is a
 * second run on the same engine, so a global here meant the later run took the
 * earlier one's stream, its signal and its stdin: a trivial child was read as
 * a watch (it arrived with an abort handle) and never ended, and its parent's
 * output went down the child's channel.
 */
export interface RunStreams {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    signal?: AbortSignal;
    /** The host keeps this run open; a run that is not held ends when its loop has nothing left. */
    held: boolean;
    /**
     * The run's fd 0 has a writer that has not closed it. A held run's prompt is
     * one; a spawned child whose `stdio[0]` is a pipe is the other, and its
     * writer is the parent, which may write long after the child has started.
     * Without it the child's standard input ended before the first write.
     */
    stdinOpen?: boolean;
    stdin?: RunStdin | null;
    /**
     * The run's fd 2 is a pipe the parent holds, not the host's own stdio and
     * not inherit. A run that ends uncaught or by `process.exit` with a
     * nonzero code on that pipe writes one line to the host realm's console.
     */
    stderrIsPipe?: boolean;
}
/** Register what the host gave this run, under the run's own name. */
export declare function registerRunStreams(token: ProcessToken, streams: RunStreams): void;
/** Forget a run that has ended. */
export declare function releaseRunStreams(token: ProcessToken): void;
/**
 * Send data to the stdin of one run's guest process.
 * Emits both 'data' and 'keypress' events (vitest uses readline keypress events).
 *
 * With a token, that run's stdin. Without one — the door a host that has no id
 * to give still has — the most recently started run the host holds, which is
 * the prompt a person is typing to; a run nobody holds has no prompt.
 */
export declare function sendStdin(data: string, token?: ProcessToken): void;
export declare function initChildProcess(vfs: VirtualFS): void;
/** What a host asks of `runCommand`, the engine's own door onto its shell. */
export interface ExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** What the shell reads on stdin, so a builtin reads what was piped to it. */
    stdin?: string;
    /**
     * A name for this run, which the `node` command records its guest process
     * under and the container answers `pendingTimers`, `processPorts` and
     * `stopProcess` about. It travels in the shell's environment so that two
     * runs in flight at once each reach their own command.
     */
    processToken?: string;
    /** The tree this command runs on, so two containers in one realm keep theirs. */
    vfs?: VirtualFS;
}
/** What `runCommand` answers with, in the shape a shell answers. */
export type ExecCallback = (error: (Error & {
    code?: number;
}) | null, stdout: string, stderr: string) => void;
/**
 * The host's door onto the engine's shell: one named run of a command line,
 * with the host's streams and its abort handle. This is `container.run`'s
 * half, not Node's `child_process.exec` -- Node's is its own file's, over the
 * binding, and it knows nothing of a run's name.
 */
export declare function runCommand(command: string, options: ExecOptions, callback?: ExecCallback): void;
declare const _default: {
    initChildProcess: typeof initChildProcess;
    registerRunStreams: typeof registerRunStreams;
    releaseRunStreams: typeof releaseRunStreams;
    runCommand: typeof runCommand;
    sendStdin: typeof sendStdin;
};
export default _default;
//# sourceMappingURL=child_process.d.ts.map