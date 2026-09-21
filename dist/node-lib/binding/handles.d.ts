/**
 * Run ownership, as libuv's loop counts handles.
 *
 * Node keeps a process alive while its loop holds an active handle: a
 * listening server, a connected socket, a pending timer. `unref()` takes a
 * handle out of that count and `ref()` puts it back. The engine counted a
 * run's timers, the host work it was waiting on, and the ports it was
 * listening on — three registries written one at a time, each for the program
 * that died without it — and a program whose only handle was a client socket
 * read as idle and was settled: VS Code's extension host, ended with exit 0
 * three times over.
 *
 * Here there is one count, and it is the handle's own, because the handle is
 * now the thing Node's own `net.js` creates and closes. A handle registers
 * with the run that made it when it is constructed, `ref`/`unref` toggle it,
 * and closing it gives it up.
 */
import { type ProcessToken } from '../../process-tokens';
/** What the count needs of a handle: a way to close it when its run ends. */
export interface OwnedHandle {
    close(callback?: () => void): void;
}
/** The run a handle opened in, where a host named one. */
export declare function currentOwner(): ProcessToken | null;
/** The run a handle belongs to, for a handle that must belong to another's. */
export declare function ownerOf(handle: OwnedHandle): ProcessToken | null;
/** A new handle is the current run's, ref'd and active, as libuv's start. */
export declare function registerHandle(handle: OwnedHandle): void;
/**
 * libuv's `uv__handle_stop`: the handle stays open and stops doing anything,
 * so it no longer holds its run's loop. A stream calls this when it reads
 * EOF, as libuv's does.
 */
export declare function stopHandle(handle: OwnedHandle): void;
/** libuv's `uv_ref`. */
export declare function refHandle(handle: OwnedHandle): void;
/** libuv's `uv_unref`: the handle stays open and stops holding the loop. */
export declare function unrefHandle(handle: OwnedHandle): void;
/** Whether the handle still holds its run's loop open. */
export declare function handleHasRef(handle: OwnedHandle): boolean;
/** A closed handle holds nothing. */
export declare function releaseHandle(handle: OwnedHandle): void;
/**
 * How many ref'd handles the named run holds, as Node's loop counts them.
 * The engine's `node` command asks it to decide whether a program that has
 * gone quiet is done.
 */
export declare function __ownedHandleCount(token: ProcessToken): number;
/**
 * Every port the named run is listening on.
 *
 * The engine's `node` command asks this to tell a run that has gone quiet but
 * holds a server from one that is finished, and the page bridge asks it to
 * name a guest's servers. It used to be a registry the engine's own `http`
 * kept; `http` is Node's own file now, and a server is a listening handle, so
 * the answer comes from the handles the run holds.
 */
export declare function __ownedServerPorts(token: ProcessToken): number[];
/**
 * A process that ends closes the servers it was listening on. This is the
 * same release as the handles below it -- a server IS a handle here -- kept
 * under its own name because the engine's own parts call it where a run ends.
 */
export declare function __releaseOwnedServers(token: ProcessToken, stopTimers?: boolean, stopProcess?: (token: ProcessToken) => void): void;
/**
 * A process that ends closes the handles it held, as Node closes its fds.
 * Called where the run's servers and timers are released.
 */
export declare function __releaseOwnedHandles(token: ProcessToken): void;
/**
 * Move a handle to another run, as a descriptor sent over IPC moves.
 *
 * Node's `subprocess.send(message, socket)` duplicates the parent's descriptor
 * into the child, and from then on the socket is an active handle of the
 * child's loop, not the parent's. The engine has no descriptor to duplicate —
 * parent and child are one realm and the loopback pairing is the connection —
 * so the move is this count's. A handle the program `unref`'d stays unref'd
 * through the move, as Node's does.
 */
export declare function __adoptHandle(handle: OwnedHandle | null | undefined, token: ProcessToken | null): void;
//# sourceMappingURL=handles.d.ts.map