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
 * A host may watch the loop's edges (`observeGuestLoop`): busy when guest work
 * starts from idle, idle when the last of it ends, as an OS shows a process
 * running or asleep in its poll.
 */
let clock: (() => number) | undefined;
let started = 0;
let active = 0;
let activeSince = 0;
let depth = 0;
let continuation = false;
const enqueue = globalThis.queueMicrotask.bind(globalThis);
const edges = new Set<(busy: boolean) => void>();

/** The host's view of this realm's loop: called with true when guest work starts from idle, false when it ends. */
export function observeGuestLoop(listener: (busy: boolean) => void): () => void {
  edges.add(listener);
  return () => { edges.delete(listener); };
}

function edge(busy: boolean): void {
  for (const listener of edges) listener(busy);
}

export function startGuestLoop(): void {
  if (clock) return;
  // Capture the host clock before a guest can replace its performance view.
  clock = globalThis.performance.now.bind(globalThis.performance);
  started = clock();
}

function begin(): void {
  startGuestLoop();
  const idle = depth === 0 && !continuation;
  if (idle) activeSince = clock!();
  depth++;
  if (idle) edge(true);
}

function end(): void {
  depth--;
  if (depth === 0 && !continuation) {
    active += clock!() - activeSince;
    edge(false);
  }
}

export function withGuestExecution<T>(fn: () => T): T {
  begin();
  try { return fn(); } finally { end(); }
}

/** A compiled native-await continuation runs until it yields to the loop. */
export function resumeGuestTurn(): void {
  if (continuation) return;
  startGuestLoop();
  const idle = depth === 0;
  if (idle) activeSince = clock!();
  continuation = true;
  if (idle) edge(true);
  enqueue(() => {
    continuation = false;
    if (depth === 0) {
      active += clock!() - activeSince;
      edge(false);
    }
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
