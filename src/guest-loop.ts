/**
 * The worker realm's guest execution loop, in actual monotonic milliseconds.
 *
 * A pending promise/timer is not busy work. The loader and dispatch paths
 * bracket synchronous work; native-await resumptions bracket the rest of
 * their current microtask. Nested work counts once. This is execution-loop
 * accounting, not OS CPU or browser GC accounting: native host work outside
 * the engine's dispatch boundaries is not observable here.
 *
 * No observer, sampling timer or handle is created. Importing starts nothing.
 */
let clock: (() => number) | undefined;
let started = 0;
let active = 0;
let activeSince = 0;
let depth = 0;
let continuation = false;
const enqueue = globalThis.queueMicrotask.bind(globalThis);
const ticks: Array<() => void> = [];
let tickDrainScheduled = false;
let drainingTicks = false;
let callbackDepth = 0;

/**
 * Node drains its FIFO, including ticks queued by ticks, before returning to
 * promises. One browser microtask per tick let a promise continuation run
 * between a stream's destroy tick and its nested close tick.
 */
export function queueGuestNextTick(callback: () => void): void {
  ticks.push(callback);
  scheduleTickDrain();
}

function scheduleTickDrain(): void {
  if (tickDrainScheduled || drainingTicks || ticks.length === 0) return;
  tickDrainScheduled = true;
  // Native-await continuations have no engine callback scope. Their ticks
  // still get one drain, rather than one microtask for each queued tick.
  enqueue(() => {
    tickDrainScheduled = false;
    withGuestExecution(drainGuestNextTicks);
  });
}

export function drainGuestNextTicks(): void {
  if (drainingTicks) return;
  drainingTicks = true;
  let taken = 0;
  try {
    while (taken < ticks.length) ticks[taken++]();
  } finally {
    ticks.splice(0, taken);
    drainingTicks = false;
    scheduleTickDrain();
  }
}

/**
 * Node's outermost successful MakeCallback drains ticks before returning. Outermost means entered from the loop
 * with no guest code on the stack. A callback a binding makes while guest code is still running (a stream handed to
 * `net.Socket` that already has its end to report, inside `child_process.spawn`) is not outermost in Node: its
 * scope depth is above one there, and the ticks wait for the code that queued them to return. Counting only the
 * callbacks, this took such a call for the outermost and drained the queue in the middle of the caller: a spawn of
 * a program that does not exist queues its `error` for the next tick, and it was emitted before `spawn()` had
 * returned, so before any listener could be attached, and was uncaught (Node's own test-child-process-spawn-error,
 * -exec-error, -promisified and -spawn-windows-batch-file).
 *
 * Guest code is not always inside a bracket the engine made: a listener on one of the realm's own event targets (an
 * AbortSignal's timeout, a message port, a BroadcastChannel) is entered by the realm with the depth at zero. What
 * such code leaves behind that a bracket does not is its ticks: a tick already queued when the callback is entered
 * was queued by code that may still be on the stack, and one queued by code that has returned is drained by the
 * microtask its queueing scheduled. So a callback drains only a queue that was empty when it was entered: its own
 * ticks, and theirs. (The same spawn from an `abort` listener emitted its `error` before the listener was there.)
 */
export function withGuestCallback<T>(fn: () => T): T {
  const fromTheLoop = depth === 0 && !continuation && ticks.length === 0;
  return withGuestExecution(() => {
    callbackDepth++;
    try {
      const result = fn();
      if (fromTheLoop && callbackDepth === 1) drainGuestNextTicks();
      return result;
    } finally { callbackDepth--; }
  });
}

export function startGuestLoop(): void {
  if (clock) return;
  // Capture the host clock before a guest can replace its performance view.
  clock = globalThis.performance.now.bind(globalThis.performance);
  started = clock();
}

function begin(): void {
  startGuestLoop();
  if (depth === 0 && !continuation) activeSince = clock!();
  depth++;
}

function end(): void {
  depth--;
  if (depth === 0 && !continuation) active += clock!() - activeSince;
}

export function withGuestExecution<T>(fn: () => T): T {
  begin();
  try { return fn(); } finally { end(); }
}

/** A compiled native-await continuation runs until it yields to the loop. */
export function resumeGuestTurn(): void {
  if (continuation) return;
  startGuestLoop();
  if (depth === 0) activeSince = clock!();
  continuation = true;
  enqueue(() => {
    continuation = false;
    if (depth === 0) active += clock!() - activeSince;
  });
}

export interface EventLoopUtilization {
  idle: number;
  active: number;
  utilization: number;
}

/** Node's current/previous and explicit two-snapshot subtraction forms. */
export function eventLoopUtilization(first?: EventLoopUtilization, second?: EventLoopUtilization): EventLoopUtilization {
  let latest: { idle: number; active: number };
  if (second) latest = first!;
  else if (!clock) latest = { idle: 0, active: 0 };
  else {
    const now = clock();
    const busy = active + (depth > 0 || continuation ? now - activeSince : 0);
    latest = { idle: now - started - busy, active: busy };
  }
  const previous = second ?? first;
  const idle = latest.idle - (previous?.idle ?? 0);
  const busy = latest.active - (previous?.active ?? 0);
  const total = idle + busy;
  // Before a loop exists Node's cumulative answer is zero. Snapshot deltas
  // retain Node's division behavior, including NaN for identical snapshots.
  return { idle, active: busy, utilization: !previous && total === 0 ? 0 : busy / total };
}
