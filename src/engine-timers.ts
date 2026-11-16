/**
 * THE ENGINE'S OWN TIMERS are Node's (ADR-0018 item 2): `lib/timers.js` of the library's graph, over the realm's
 * Environment (node-lib/load.ts `REALM_ENVIRONMENT`), as Node's own C++ and JavaScript take theirs from the one timer
 * list of their process. A timer the engine sets for itself is no program's: it is in no process's count
 * (guest-timers.ts). Each is loaded on its first use, never while the bundle evaluates, so the loop its handles are is
 * the process's system's (system.ts `systemTimers`).
 */
import { nodeLibInternalRequire } from './node-lib/load';
import { onKernel } from './system';

/** Node's `Timeout` and `Immediate`, as the engine holds them. */
export interface EngineTimer { ref(): this; unref(): this; hasRef(): boolean; refresh?(): this }

interface NodeTimers {
  setTimeout(callback: (...args: any[]) => void, after?: number, ...args: unknown[]): EngineTimer;
  setInterval(callback: (...args: any[]) => void, repeat?: number, ...args: unknown[]): EngineTimer;
  setImmediate(callback: (...args: any[]) => void, ...args: unknown[]): EngineTimer;
  clearTimeout(timer: unknown): void;
  clearInterval(timer: unknown): void;
  clearImmediate(immediate: unknown): void;
}
const timers = (): NodeTimers => nodeLibInternalRequire('timers') as NodeTimers;

export function setTimeout(callback: (...args: any[]) => void, after?: number, ...args: unknown[]): EngineTimer {
  return timers().setTimeout(callback, after, ...args);
}
export function setInterval(callback: (...args: any[]) => void, repeat?: number, ...args: unknown[]): EngineTimer {
  return timers().setInterval(callback, repeat, ...args);
}
export function setImmediate(callback: (...args: any[]) => void, ...args: unknown[]): EngineTimer {
  return timers().setImmediate(callback, ...args);
}
export function clearTimeout(timer?: unknown): void { timers().clearTimeout(timer); }
export function clearInterval(timer?: unknown): void { timers().clearInterval(timer); }
export function clearImmediate(immediate?: unknown): void { timers().clearImmediate(immediate); }

/**
 * Completed asynchronous work, run from the loop as libuv runs a completed request's callback, never from the tick
 * or the promise queue, so a chain of them cannot run ahead of the process's other work: an fs request's answer. Until
 * the fs binding's requests are libuv's (`uv_fs_*`, ADR-0018 item 6), whose callbacks run in the poll phase, it is an
 * immediate of the loop's check phase. Answers its cancellation (the owning process's end cancels work not yet begun).
 */
export function queueCompletion(run: () => void): () => void {
  const immediate = setImmediate(run);
  return () => clearImmediate(immediate);
}

/**
 * Messages posted to an engine port the process listens to and not yet delivered (guest-message-ports.ts), in a realm
 * with no `node` program; a `node` program's port is its own uv_async_t (binding/messaging.ts, ADR-0018 item 9). On a
 * kernel the worker delivers them from its task queue, which runs only between the loop's callbacks, so each is work
 * due now, as a Node port's message is its handle's: while one is queued, a referenced immediate keeps the loop's poll
 * from blocking, and each check phase lets the worker deliver. Over no kernel the realm delivers them on its own.
 */
let messagesDue = 0;
let messageTurn: EngineTimer | undefined;
const deliverMessages = (): void => {
  messageTurn = messagesDue > 0 ? setImmediate(deliverMessages) : undefined;
};
export function portMessagesDue(change: number): void {
  if (change === 0) return;
  messagesDue += change;
  if (messagesDue > 0 && messageTurn === undefined && onKernel()) messageTurn = setImmediate(deliverMessages);
}
