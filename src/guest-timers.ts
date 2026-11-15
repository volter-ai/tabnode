import { pendingGuestPorts, stopGuestPorts } from './guest-message-ports';
import { onNodeLibLoaded } from './node-lib/load';

/**
 * A PROCESS'S TIMERS are Node's own (ADR-0018 item 2): its `lib/timers.js`, the one its `require('timers')` answers and
 * its globals are, as Node's bootstrap makes `globalThis.setTimeout` that module's (lib/internal/bootstrap/node.js),
 * over the realm's timer lists and the loop's handles (node-lib/binding/timers.ts). Each Timeout and Immediate the
 * process makes through them is counted for it here, for the run's end the engine decides by its own count in a realm
 * with no `node` program; on libuv's loop the run's end is libuv's (ADR-0018 item 7). Node's own objects say whether
 * each is pending and referenced (`_destroyed`, `hasRef()`), so nothing of theirs is wrapped: only the three
 * schedulers, which record what they make.
 */
type NodeTimer = { _destroyed: boolean; hasRef(): boolean; _idleTimeout?: number; _repeat?: number | null; _onImmediate?: unknown };
type TimerFunction = (...args: any[]) => unknown;
const made = new WeakMap<object, Set<NodeTimer>>();
const processTimers = new WeakMap<object, Record<string, TimerFunction>>();

function heldBy(process: object): Set<NodeTimer> {
  let held = made.get(process);
  if (!held) { held = new Set(); made.set(process, held); }
  return held;
}

/** The pending ones; a timer that fired or was cleared is let go. */
function pending(process: object): NodeTimer[] {
  const held = made.get(process);
  if (!held) return [];
  const live: NodeTimer[] = [];
  for (const timer of held) {
    if (timer._destroyed) held.delete(timer);
    else live.push(timer);
  }
  return live;
}

/** Referenced timers and message ports: what Node's loop counts to decide a program is done. */
export function pendingGuestTimers(process: object): number {
  let count = 0;
  for (const timer of pending(process)) if (timer.hasRef()) count++;
  return count + pendingGuestPorts(process);
}

/** Each referenced timer and port the process still holds, named by its kind and delay ("a 1000 ms timeout"). */
export function pendingGuestTimerKinds(process: object): string[] {
  const kinds = pending(process).filter((timer) => timer.hasRef()).map((timer) => ('_onImmediate' in timer ? 'an immediate'
    : `a ${timer._idleTimeout ?? 0} ms ${timer._repeat ? 'interval' : 'timeout'}`));
  const ports = pendingGuestPorts(process);
  if (ports > 0) kinds.push(`${ports} message port${ports === 1 ? '' : 's'}`);
  return kinds;
}

/** Close this process's message ports and clear every timer it still holds, as ending a Node process does. */
export function stopGuestTimers(process: object): void {
  stopGuestPorts(process);
  const timers = processTimers.get(process);
  for (const timer of pending(process)) {
    if ('_onImmediate' in timer) timers?.clearImmediate?.(timer);
    else timers?.clearTimeout?.(timer);
  }
  made.get(process)?.clear();
}

/**
 * Each process's `timers` module, as its graph loads it (node-lib/load.ts `onNodeLibLoaded`): its three schedulers
 * record what they make for the process, keeping Node's own function's properties (`util.promisify.custom`).
 */
onNodeLibLoaded((name, exports, require) => {
  if (name !== 'timers') return;
  const process = require('process') as object;
  const timers = exports as Record<string, TimerFunction>;
  for (const key of ['setTimeout', 'setInterval', 'setImmediate']) {
    const schedule = timers[key]!;
    const counted = {
      [key](this: unknown, ...args: unknown[]): unknown {
        const timer = Reflect.apply(schedule, this, args) as NodeTimer;
        heldBy(process).add(timer);
        return timer;
      },
    }[key]!;
    for (const property of Reflect.ownKeys(schedule)) {
      if (property === 'name' || property === 'prototype') continue;
      Reflect.defineProperty(counted, property, Reflect.getOwnPropertyDescriptor(schedule, property)!);
    }
    timers[key] = counted;
  }
  processTimers.set(process, timers);
});
