import { __reportUncaughtException } from './shims/process';
import { nodeTimeout, timerHandleOf } from './node-lib/timers';

/**
 * The timers a guest process has pending: what Node's loop counts to decide
 * a program is done. A timer the guest sets through its globals or module is
 * held here until it fires, is cleared, or is unref'd, and the `node`
 * command's end-of-program rule asks how many remain.
 */
const __substratePendingTimers = new WeakMap<object, Set<unknown>>();
export function pendingGuestTimers(process: object): number {
  return __substratePendingTimers.get(process)?.size ?? 0;
}
/**
 * Clear every timer a guest still holds, as ending a Node process clears the
 * ones its loop was waiting on. The ids were made by the host's own
 * `setTimeout`/`setInterval` through the guest's global view, so the host's
 * own clears end them; a `Timeout` is cleared by either in Node, and either
 * refusing an id of the other kind is not an error here.
 */
export function stopGuestTimers(process: object): void {
  const held = __substratePendingTimers.get(process);
  if (!held) return;
  const host = globalThis as unknown as Record<string, unknown>;
  const clearOnce = host.clearTimeout as ((id: unknown) => void) | undefined;
  const clearRepeating = host.clearInterval as ((id: unknown) => void) | undefined;
  for (const id of [...held]) {
    try { clearOnce?.call(host, id); } catch {}
    try { clearRepeating?.call(host, id); } catch {}
  }
  held.clear();
}
export function guestTimerFunctions(process: object, host: Record<string, unknown>) {
  let pending = __substratePendingTimers.get(process);
  if (!pending) { pending = new Set(); __substratePendingTimers.set(process, pending); }
  const held = pending;
  const hostSetTimeout = host.setTimeout as (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => unknown;
  const hostSetInterval = host.setInterval as (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => unknown;
  const hostClearTimeout = host.clearTimeout as (id: unknown) => void;
  const hostClearInterval = host.clearInterval as (id: unknown) => void;
  // Node's timers answer a `Timeout`: an object with `ref`, `unref`,
  // `hasRef` and `refresh`, which vitest and many packages call. A browser's
  // answer a number. The engine used to correct this by replacing the realm's
  // `setTimeout`, which in a Node host replaced the host's own; the
  // correction belongs to the guest that reads Node's shape, so it is made
  // here, on the guest's timer, and a host that already answers a `Timeout`
  // keeps its own. The shape itself is `src/node-lib/timers.ts`: Node's own
  // files take their timers from `require('timers')` rather than from the
  // realm, and a timer made through one is cleared through the other.
  const handleOf = timerHandleOf;
  // An exception a timer callback throws is that program's uncaught
  // exception: Node gives it to the process's `uncaughtException` listeners,
  // else prints the stack to that process's stderr and exits it 1, and every
  // other process is untouched. The engine's timers are the realm's own, so
  // an uncaught throw left the guest's frames and reached the realm's global
  // `error` event — in the tab the worker's, which the substrate's container
  // reads as a dead host and disposes, killing openvscode-server's extension
  // host and every other program in the tab along with the one that threw.
  // A callback with no owning program (the engine imported as a library) is
  // rethrown, so the host reports it as it always did.
  const inProcess = (fn: (...a: unknown[]) => void) => (...args: unknown[]): void => {
    try { fn(...args); }
    catch (error) { if (!__reportUncaughtException(process, error)) throw error; }
  };
  const track = (id: unknown): unknown => {
    held.add(id);
    if (id && typeof id === "object" && typeof (id as { unref?: unknown }).unref === "function") {
      const handle = id as { unref: () => unknown; ref: () => unknown };
      const unref = handle.unref.bind(handle);
      const ref = handle.ref.bind(handle);
      handle.unref = () => { held.delete(id); return unref(); };
      handle.ref = () => { held.add(id); return ref(); };
    }
    return id;
  };
  return {
    setTimeout(fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) {
      let id: unknown;
      const call = inProcess(fn);
      id = nodeTimeout(hostSetTimeout.call(host, (...args: unknown[]) => { held.delete(id); call(...args); }, ms, ...rest));
      return track(id);
    },
    setInterval(fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) {
      return track(nodeTimeout(hostSetInterval.call(host, inProcess(fn), ms, ...rest)));
    },
    clearTimeout(id: unknown) { held.delete(id); return hostClearTimeout.call(host, handleOf(id)); },
    clearInterval(id: unknown) { held.delete(id); return hostClearInterval.call(host, handleOf(id)); },
  };
}
