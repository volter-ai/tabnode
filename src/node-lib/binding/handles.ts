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
import { __currentProcessToken, __lastLaunchedToken, type ProcessToken } from '../../process-tokens';

/** What the count needs of a handle: a way to close it when its run ends. */
export interface OwnedHandle {
  close(callback?: () => void): void;
}

const owners = new Map<ProcessToken, Set<OwnedHandle>>();
const heldBy = new WeakMap<OwnedHandle, ProcessToken | null>();
const refHeld = new WeakSet<OwnedHandle>();
/**
 * The handles that are DOING something, which is libuv's other half of the
 * rule: a loop is held by a handle that is both active and referenced.
 * `uv_read_start` starts a stream and `uv_read_stop` stops it, and libuv stops
 * a stream itself the moment it reads EOF (`uv__stream_eof` calls
 * `uv_read_stop`) -- so a socket whose peer has gone does not hold a program
 * open, however much unread data is still sitting in its buffer. Measured
 * against the host's node: a client socket with three unread bytes and
 * `_handle.reading` still true let the process exit at once.
 */
const activeHandles = new WeakSet<OwnedHandle>();

/** The run a handle opened in, where a host named one. */
export function currentOwner(): ProcessToken | null {
  return __currentProcessToken() ?? __lastLaunchedToken;
}

function hold(handle: OwnedHandle): void {
  const token = heldBy.get(handle);
  if (token === null || token === undefined) return;
  if (!refHeld.has(handle) || !activeHandles.has(handle)) return;
  let held = owners.get(token);
  if (!held) { held = new Set(); owners.set(token, held); }
  held.add(handle);
}

function drop(handle: OwnedHandle): void {
  const token = heldBy.get(handle);
  if (token === null || token === undefined) return;
  const held = owners.get(token);
  if (!held) return;
  held.delete(handle);
  if (held.size === 0) owners.delete(token);
}

/** The run a handle belongs to, for a handle that must belong to another's. */
export function ownerOf(handle: OwnedHandle): ProcessToken | null {
  return heldBy.get(handle) ?? null;
}

/** A new handle is the current run's, ref'd and active, as libuv's start. */
export function registerHandle(handle: OwnedHandle): void {
  heldBy.set(handle, currentOwner());
  refHeld.add(handle);
  activeHandles.add(handle);
  hold(handle);
}

/**
 * libuv's `uv__handle_stop`: the handle stays open and stops doing anything,
 * so it no longer holds its run's loop. A stream calls this when it reads
 * EOF, as libuv's does.
 */
export function stopHandle(handle: OwnedHandle): void {
  activeHandles.delete(handle);
  drop(handle);
}

/** libuv's `uv_ref`. */
export function refHandle(handle: OwnedHandle): void {
  refHeld.add(handle);
  hold(handle);
}

/** libuv's `uv_unref`: the handle stays open and stops holding the loop. */
export function unrefHandle(handle: OwnedHandle): void {
  refHeld.delete(handle);
  drop(handle);
}

/** Whether the handle still holds its run's loop open. */
export function handleHasRef(handle: OwnedHandle): boolean {
  return refHeld.has(handle);
}

/** A closed handle holds nothing. */
export function releaseHandle(handle: OwnedHandle): void {
  drop(handle);
  heldBy.delete(handle);
  refHeld.delete(handle);
  activeHandles.delete(handle);
}

/**
 * How many ref'd handles the named run holds, as Node's loop counts them.
 * The engine's `node` command asks it to decide whether a program that has
 * gone quiet is done.
 */
export function __ownedHandleCount(token: ProcessToken): number {
  return owners.get(token)?.size ?? 0;
}

/**
 * Every port the named run is listening on.
 *
 * The engine's `node` command asks this to tell a run that has gone quiet but
 * holds a server from one that is finished, and the page bridge asks it to
 * name a guest's servers. It used to be a registry the engine's own `http`
 * kept; `http` is Node's own file now, and a server is a listening handle, so
 * the answer comes from the handles the run holds.
 */
export function __ownedServerPorts(token: ProcessToken): number[] {
  const held = owners.get(token);
  if (!held) return [];
  const ports: number[] = [];
  for (const handle of held) {
    const listening = handle as unknown as { listening?: boolean; local?: { port?: number } };
    if (listening.listening === true && typeof listening.local?.port === 'number') ports.push(listening.local.port);
  }
  return ports;
}

/**
 * A process that ends closes the servers it was listening on. This is the
 * same release as the handles below it -- a server IS a handle here -- kept
 * under its own name because the engine's own parts call it where a run ends.
 */
export function __releaseOwnedServers(token: ProcessToken, stopTimers = true, stopProcess?: (token: ProcessToken) => void): void {
  const held = owners.get(token);
  if (held) {
    for (const handle of [...held]) {
      const listening = handle as unknown as { listening?: boolean };
      if (listening.listening !== true) continue;
      try { handle.close(); } catch { /* already closed is already released */ }
    }
  }
  // A run's own timers stop once its exit is recorded, not from inside the
  // timer that called exit: the engine's runner waits on a tick of its own.
  if (stopTimers && stopProcess) setTimeout(() => stopProcess(token), 0);
}

/**
 * A process that ends closes the handles it held, as Node closes its fds.
 * Called where the run's servers and timers are released.
 */
export function __releaseOwnedHandles(token: ProcessToken): void {
  const held = owners.get(token);
  if (!held) return;
  owners.delete(token);
  for (const handle of [...held]) {
    try { handle.close(); } catch { /* a handle already closed is already released */ }
  }
}

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
export function __adoptHandle(handle: OwnedHandle | null | undefined, token: ProcessToken | null): void {
  if (!handle) return;
  drop(handle);
  heldBy.set(handle, token);
  hold(handle);
}
