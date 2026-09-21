/**
 * A child process run to completion before the call returns, as
 * `child_process.spawnSync` and `execSync` do in Node.
 *
 * Which program died: Node's own `test/wasi` suite drives every one of its
 * fixtures through `spawnSyncAndAssert`, and generators shell out the same way
 * (`ni`, `pagefind`). What Node does: it runs the child to its end and answers
 * its status, its output and its pid. What the engine did: it answered ENOSYS,
 * because a realm has no primitive that blocks while its own loop runs the
 * child.
 *
 * What it does now: the child runs on a thread of its own, in an engine of its
 * own, and the caller blocks on shared memory until that thread reports the
 * child's end — the shape `esbuild.transformSync` already has here. The thread
 * has no filesystem of its own: every call its engine makes on the tree
 * crosses back to the caller through the same shared window and the caller,
 * still inside the synchronous call, answers it from the filesystem the parent
 * is running on. So the child reads what the parent wrote a statement ago and
 * writes what the parent reads a statement later, as two processes over one
 * filesystem do.
 *
 * What it does not cover, each answered rather than guessed at: a realm that
 * cannot block (a page's main thread, where `Atomics.wait` is refused) and a
 * realm without shared memory answer ENOSYS with the reason on the result's
 * `error`, as Node answers a child it could not start. A program the engine's
 * shell has no command for is ENOENT, as it is on a machine that does not
 * carry that binary. A child is never killed by a signal here, so `signal` is
 * always null and `options.timeout` and `options.killSignal` are not honoured;
 * a child that watches the tree sees no change, because the parent turns no
 * loop while it waits.
 */
import type { VirtualFS } from '../virtual-fs';
export declare function setSyncChildVfs(vfs: VirtualFS): void;
/** What a synchronous child answers when it has ended. */
export interface SyncChildResult {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}
/** What a caller asks for. */
export interface SyncChildRequest {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    input?: string;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
}
/** Whether this realm may block on shared memory at all; the reason when it may not. */
export declare function syncChildRefusal(): string | null;
/**
 * Starts the thread without waiting on it. Called when the shim is
 * initialized in a realm whose worker cannot start inside a synchronous call,
 * and by a call that finds none.
 */
export declare function warmSyncChild(): void;
/**
 * Runs one child to its end and answers what it did. Throws only when this
 * realm cannot run a synchronous child at all; the caller turns that into the
 * result Node gives for a child it could not start.
 */
export declare function runSyncChild(request: SyncChildRequest): SyncChildResult;
//# sourceMappingURL=sync-child.d.ts.map