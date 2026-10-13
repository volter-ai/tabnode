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
import { __currentProcessToken, __runFor, __tokenForProcess, enterRun, type ProcessToken } from '../../process-tokens';
import { withGuestCallback, queueBindingTask } from '../../guest-loop';
import { handleOwnerSymbol } from './owner-symbol';
import type { Process } from '../../shims/process';

/** What the count needs of a handle: a way to close it when its run ends. */
export interface OwnedHandle {
  close(callback?: () => void): void;
}

const owners = new Map<ProcessToken, Set<OwnedHandle>>();
// Unref affects liveness, not ownership: exit must close unreferenced handles too.
const allOwned = new Map<ProcessToken, Set<OwnedHandle>>();
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

type ResourceOwner = ProcessToken | symbol | null;
let resourceScope: object | undefined;
const scopeIds = new WeakMap<object, symbol>();
function scopeId(process: object): symbol {
  let id = scopeIds.get(process);
  if (!id) { id = Symbol('node resource scope'); scopeIds.set(process, id); }
  return id;
}
/** A standalone Runtime has no run token; its binding scope still owns its resources. */
export function withNodeResourceScope<T>(process: object, call: () => T): T {
  const previous = resourceScope;
  resourceScope = process;
  try { return call(); } finally { resourceScope = previous; }
}
/** Deferred native fs work/returned directory methods retain their actual binding scope. */
export function captureNodeResourceScope(): <T>(call: () => T) => T {
  const process = resourceScope;
  return <T>(call: () => T): T => process ? withNodeResourceScope(process, call) : call();
}
function resourceOwnerKey(object: object): ResourceOwner {
  // Observations are made synchronously in a scoped constructor/dispatch.
  // That explicit process owns them even when another run is ambient.
  if (resourceScope) return __tokenForProcess(resourceScope as Process) ?? scopeId(resourceScope);
  return ownerOfInstance(object) ?? currentOwner();
}
type ResourceRow = { owner: ResourceOwner; ref: WeakRef<object> };
const handleRows = new Map<ResourceOwner, Set<ResourceRow>>();
const requestRows = new Map<ResourceOwner, Set<ResourceRow>>();
const handleRowByObject = new WeakMap<object, ResourceRow>();
const requestRowByObject = new WeakMap<object, ResourceRow>();
const handleReferenced = new WeakMap<object, (handle: object) => boolean>();
const closingReferences = new WeakMap<object, boolean>();
function removeRow(rows: Map<ResourceOwner, Set<ResourceRow>>, row: ResourceRow): void {
  const held = rows.get(row.owner);
  held?.delete(row);
  if (held?.size === 0) rows.delete(row.owner);
}
const collectedResources = new FinalizationRegistry<{ rows: Map<ResourceOwner, Set<ResourceRow>>; row: ResourceRow }>(
  ({ rows, row }) => removeRow(rows, row));
function observeResource(rows: Map<ResourceOwner, Set<ResourceRow>>, byObject: WeakMap<object, ResourceRow>,
  object: object, owner: ResourceOwner): void {
  const previous = byObject.get(object);
  if (previous) { removeRow(rows, previous); collectedResources.unregister(object); }
  const row = { owner, ref: new WeakRef(object) };
  let held = rows.get(owner);
  if (!held) { held = new Set(); rows.set(owner, held); }
  held.add(row);
  byObject.set(object, row);
  collectedResources.register(object, { rows, row }, object);
}
function forgetResource(rows: Map<ResourceOwner, Set<ResourceRow>>, byObject: WeakMap<object, ResourceRow>, object: object): void {
  const row = byObject.get(object);
  if (row) removeRow(rows, row);
  byObject.delete(object);
  collectedResources.unregister(object);
}

/** Only real HandleWraps enter this list; timers/fetch/fs work keep their existing liveness accounting. */
export function observeNodeHandle(handle: object, referenced: (handle: object) => boolean = nodeHandleReferenced): void {
  handleReferenced.set(handle, referenced);
  observeResource(handleRows, handleRowByObject, handle, resourceOwnerKey(handle));
}
function nodeHandleReferenced(handle: object): boolean { return closingReferences.get(handle) ?? refHeld.has(handle as OwnedHandle); }
/** HandleWrap's initialized/ref state includes closing, until native completion. */
export function nodeHandleHasRef(handle: object): boolean {
  return handleRowByObject.has(handle) && (handleReferenced.get(handle)?.(handle) ?? false);
}
export function nodeHandleIsInitialized(handle: object): boolean { return handleRowByObject.has(handle); }
export function nodeHandleIsClosing(handle: object): boolean { return closingReferences.has(handle); }
export function forgetNodeHandle(handle: object): void {
  forgetResource(handleRows, handleRowByObject, handle);
  handleReferenced.delete(handle);
  closingReferences.delete(handle);
}
/** Observe the actual dispatched request; its operation already owns its lifetime. */
export function observeNodeRequest(request: object, operationHandle?: object): void {
  // An IPC facade can retain the sender's JS prototype/scope. The adopted
  // native handle, rather than that facade, owns its dispatched operation.
  const target = operationHandle && handleRowByObject.get(operationHandle);
  observeResource(requestRows, requestRowByObject, request, target ? target.owner : resourceScope ? resourceOwnerKey(request)
    : requestRowByObject.get(request)?.owner ?? resourceOwnerKey(request));
}
export function forgetNodeRequest(request: object): void { forgetResource(requestRows, requestRowByObject, request); }

/** Node AsyncWrap::GetOwner follows only object-valued owner links, suppressing getter failures. */
function resourceOwner(resource: object): object {
  for (;;) {
    let owner: unknown;
    try { owner = (resource as Record<symbol, unknown>)[handleOwnerSymbol]; } catch { return resource; }
    if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) return resource;
    resource = owner;
  }
}
function resourceSnapshot(rows: Map<ResourceOwner, Set<ResourceRow>>, owner: ResourceOwner, handles: boolean): object[] {
  const result: object[] = [];
  for (const row of rows.get(owner) ?? []) {
    const object = row.ref.deref();
    if (!object) { removeRow(rows, row); continue; }
    if (!handles || handleReferenced.get(object)?.(object)) result.push(resourceOwner(object));
  }
  return result;
}
/** Node tests reference status, not uv_is_active: an idle referenced socket is still returned. */
function processSnapshot(rows: Map<ResourceOwner, Set<ResourceRow>>, process: object, token: ProcessToken | null, handles: boolean): object[] {
  // Include resources made before the runtime acquired its registered token.
  const own = resourceSnapshot(rows, scopeId(process), handles);
  return token === null ? own : [...own, ...resourceSnapshot(rows, token, handles)];
}
export function nodeActiveHandles(process: object, token: ProcessToken | null): object[] { return processSnapshot(handleRows, process, token, true); }
export function nodeActiveRequests(process: object, token: ProcessToken | null): object[] { return processSnapshot(requestRows, process, token, false); }

/** The run a binding call is made in: its scope's process (a scoped binding runs inside its owner's run). */
export function currentOwner(): ProcessToken | null {
  return __currentProcessToken();
}

/** The process each binding instance belongs to: its NodeLibScope's, recorded when the instance was made. */
const instanceOwners = new WeakMap<object, ProcessToken | null>();
export function setInstanceOwner(instance: object, owner: ProcessToken | null): void { instanceOwners.set(instance, owner); }
export function ownerOfInstance(instance: object): ProcessToken | null {
  return instanceOwners.get(instance) ?? heldBy.get(instance as OwnedHandle) ?? null;
}

/**
 * `fn` inside `owner`'s run (enterRun), unless that run is current already. A guest callback's throw is its owner's
 * uncaught exception, as Node's MakeCallback reports one to the process the wrap belongs to.
 */
export function ownedRun<T>(owner: ProcessToken | null, fn: () => T, callback = false, kind = 'callback', source?: unknown): T | undefined {
  const call = (): T | undefined => {
    if (!callback) return fn();
    // Drain ticks before leaving the owning run, as MakeCallback does.
    try { return withGuestCallback(fn, kind, source); }
    catch (error) { if (owner !== null && __runFor(owner)?.reportUncaught(error)) return undefined; throw error; }
  };
  return owner === null || __currentProcessToken() === owner ? call() : enterRun(owner, call);
}

/** A wrap's callback (`onread`, `oncomplete`, `onconnection`, `onexit`, …) run as MakeCallback runs it: in its owner's run. */
export function invokeOwned(target: object, name: string, ...args: unknown[]): unknown {
  try { return invokeOwnedCallback(target, name, ...args); }
  finally { if (name === 'oncomplete') forgetNodeRequest(target); }
}
function invokeOwnedCallback(target: object, name: string, ...args: unknown[]): unknown {
  const fn = (target as Record<string, unknown>)[name];
  if (typeof fn !== 'function') return undefined;
  // `wrap`: a binding wrap's callback (`onread`'s onStreamRead, a write's oncomplete), named by the function the wrap holds.
  return ownedRun(ownerOfInstance(target), () => (fn as (...values: unknown[]) => unknown).apply(target, args), true, 'wrap', fn);
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
export function registerHandle(handle: OwnedHandle, nodeWrap = false): void {
  heldBy.set(handle, currentOwner());
  const token = heldBy.get(handle);
  if (token != null) {
    let owned = allOwned.get(token);
    if (!owned) { owned = new Set(); allOwned.set(token, owned); }
    owned.add(handle);
  }
  refHeld.add(handle);
  activeHandles.add(handle);
  hold(handle);
  if (nodeWrap) observeNodeHandle(handle);
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
  if (closingReferences.has(handle)) closingReferences.set(handle, true);
  refHeld.add(handle);
  hold(handle);
}

/** libuv's `uv_unref`: the handle stays open and stops holding the loop. */
export function unrefHandle(handle: OwnedHandle): void {
  if (closingReferences.has(handle)) closingReferences.set(handle, false);
  refHeld.delete(handle);
  drop(handle);
}

/** Whether the handle still holds its run's loop open. */
export function handleHasRef(handle: OwnedHandle): boolean {
  return refHeld.has(handle);
}

/** A closed handle holds nothing. */
export function releaseHandle(handle: OwnedHandle, closePending = false, closeTurns: 1 | 2 = 2): void {
  if (closePending && handleRowByObject.has(handle)) {
    const pending = closingReferences.has(handle);
    if (!pending) {
      closingReferences.set(handle, handleReferenced.get(handle)?.(handle) ?? false);
      handleReferenced.set(handle, nodeHandleReferenced);
    }
    // Follow this binding’s existing close callback boundary. Preserve the
    // referenced wrapper until that turn, without changing liveness.
    if (!pending) queueBindingTask(() => {
      if (closeTurns === 1) forgetNodeHandle(handle);
      else queueBindingTask(() => forgetNodeHandle(handle));
    });
  } else forgetNodeHandle(handle);
  drop(handle);
  const token = heldBy.get(handle);
  if (token != null) {
    const owned = allOwned.get(token);
    owned?.delete(handle);
    if (owned?.size === 0) allOwned.delete(token);
  }
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

/** Each ref'd handle the named run holds, by its wrap's name (TCP, Pipe, Process, …), for the line that says what held it. */
export function __ownedHandleKinds(token: ProcessToken): string[] {
  const held = owners.get(token);
  return held ? [...held].map((handle) => (handle as object).constructor?.name || 'handle') : [];
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
  const process = __runFor(token)?.process;
  const scope = process && scopeIds.get(process);
  if (scope) { handleRows.delete(scope); requestRows.delete(scope); }
  handleRows.delete(token);
  requestRows.delete(token);
  const held = allOwned.get(token);
  if (!held) return;
  allOwned.delete(token);
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
export function __adoptHandle(handle: OwnedHandle | null | undefined, token: ProcessToken | null, resourceSource?: object): void {
  if (!handle) return;
  drop(handle);
  const previous = heldBy.get(handle);
  if (previous != null) {
    const owned = allOwned.get(previous);
    owned?.delete(handle);
    if (owned?.size === 0) allOwned.delete(previous);
  }
  heldBy.set(handle, token);
  if (handleRowByObject.has(handle)) {
    // A standalone server has no run token. Its accepted/transferred wrapper
    // still belongs to that server's private binding scope, not a null bucket.
    const sourceRow = resourceSource && handleRowByObject.get(resourceSource);
    const next = sourceRow ? sourceRow.owner : token;
    observeResource(handleRows, handleRowByObject, handle, next);
  }
  if (token !== null) {
    let owned = allOwned.get(token);
    if (!owned) { owned = new Set(); allOwned.set(token, owned); }
    owned.add(handle);
  }
  hold(handle);
}
