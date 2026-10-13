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
 * AN INSTRUMENT (S2 R27): the outermost brackets' time by what entered them, a kind (a timer, a stream's read or
 * write completion, a promise continuation, a module's body...) and the guest function's own name where the entry
 * names one. The realm's guest time was one number (guestBracketMs: 554 ms of Cal's seed client, about 1 ms a query
 * against its PostgreSQL), and nothing said whose callbacks it was. Off until a reading asks (enableGuestEntryAccount,
 * called where the load clock starts): a bracket then looks up one map entry when it ends; otherwise nothing is
 * counted and no name is read. Realm-scoped, as the brackets are. At most ENTRY_KEYS distinct entries; the rest are
 * counted under their kind, so the map holds at most ENTRY_KEYS and one key per kind. Kinds: timer, wrap (a binding
 * wrap's or native stream's callback, by the function it holds), then/setTimeout/setInterval/setImmediate/
 * queueMicrotask, await, emit (by event), ticks, async-resource, message, fs (a file system request's or watcher's
 * callback), process, module, entry, callback (an engine callback with no door named), other.
 */
const ENTRY_KEYS = 256;
let entryAccount: Map<string, { count: number; ms: number }> | undefined;
let outerKind = 'other';
let outerSource: unknown;
/** Turned on where a reading's first load clock starts, which may be inside an open bracket (a module's body): that
 *  bracket began with the account off, so it is counted once, at its end, as `other`. */
export function enableGuestEntryAccount(): void { entryAccount ??= new Map(); }
/** The account, the longest first, at most `limit` entries: [kind or kind:name, count, ms]. */
export function guestEntryAccount(limit = 16): Array<[string, number, number]> | undefined {
  if (!entryAccount) return undefined;
  return [...entryAccount].sort((a, b) => b[1].ms - a[1].ms).slice(0, limit).map(([key, held]) => [key, held.count, held.ms]);
}
/** The account by kind alone: { kind: [count, ms] }. */
export function guestEntryKinds(): Record<string, [number, number]> | undefined {
  if (!entryAccount) return undefined;
  const kinds: Record<string, [number, number]> = {};
  for (const [key, held] of entryAccount) {
    const kind = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
    const entry = kinds[kind] ??= [0, 0];
    entry[0] += held.count; entry[1] += held.ms;
  }
  return kinds;
}
/** A source's name, read safely: a function's own `name` (a getter or a Proxy may run guest code or throw, and a
 *  throw here would replace the callback's own), only where it is a string; an event's name; 64 characters at most. */
function sourceName(source: unknown): string | undefined {
  if (typeof source === 'string') return source.slice(0, 64) || undefined;
  if (typeof source !== 'function') return undefined;
  try { const name: unknown = (source as { name?: unknown }).name; return typeof name === 'string' && name ? name.slice(0, 64) : undefined; }
  catch { return undefined; }
}
function countEntry(kind: string, source: unknown, ms: number): void {
  const account = entryAccount!;
  // a function by its own name; an event by its name (an emit's first argument, where it is a string)
  const name = sourceName(source);
  let key = name ? `${kind}:${name}` : kind;
  if (!account.has(key) && account.size >= ENTRY_KEYS) key = kind;
  const held = account.get(key);
  if (held) { held.count += 1; held.ms += ms; } else account.set(key, { count: 1, ms });
}

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
    withGuestExecution(drainGuestNextTicks, 'ticks');
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
export function withGuestCallback<T>(fn: () => T, kind = 'callback', source?: unknown): T {
  const fromTheLoop = depth === 0 && !continuation && ticks.length === 0;
  return withGuestExecution(() => {
    callbackDepth++;
    try {
      const result = fn();
      if (fromTheLoop && callbackDepth === 1) drainGuestNextTicks();
      return result;
    } finally { callbackDepth--; }
  }, kind, source ?? fn);
}

/**
 * The engine's own deferred work on a binding's behalf: a connect answered through its request, bytes that arrived
 * handed to `onread`, a write's completion. libuv does each from the loop, with no program code on the stack, and
 * the callback it makes is outermost. The realm's `queueMicrotask` brackets every callback it is given as guest
 * execution (async_hooks.ts), which is right for a program's own callback and wrong for these: inside that bracket
 * the callback a binding then makes took the engine's bracket for program code still running, and left the ticks it
 * queued undrained until some later microtask. An HTTP request dumped by its response (`res.end()` with the body
 * still arriving) resumes on such a tick; the socket's end, delivered by the same kind of task, came first, and a
 * `data` listener the program added on `resume` was never called (Node's test-http-dump-req-when-res-ends).
 *
 * A task queued here is run by the realm's wrapper with no bracket of its own; the callback it makes brackets itself.
 */
const bindingTasks = new WeakSet<object>();
export function queueBindingTask(task: () => void): void {
  bindingTasks.add(task);
  globalThis.queueMicrotask(task);
}
export function isBindingTask(task: unknown): boolean {
  return typeof task === 'function' && bindingTasks.has(task);
}

export function startGuestLoop(): void {
  if (clock) return;
  // Capture the host clock before a guest can replace its performance view.
  clock = globalThis.performance.now.bind(globalThis.performance);
  started = clock();
}

function begin(kind: string, source: unknown): void {
  startGuestLoop();
  if (depth === 0 && !continuation) { activeSince = clock!(); if (entryAccount) { outerKind = kind; outerSource = source; } }
  depth++;
}

function end(): void {
  depth--;
  if (depth === 0 && !continuation) {
    const took = clock!() - activeSince;
    active += took;
    if (entryAccount) { countEntry(outerKind, outerSource, took); outerSource = undefined; }
  }
}

/** `kind`, `source`: what entered the bracket, for the entry account (S2 R27); read only while it is on. */
export function withGuestExecution<T>(fn: () => T, kind = 'other', source?: unknown): T {
  begin(kind, source ?? fn);
  try { return fn(); } finally { end(); }
}

/** A compiled native-await continuation runs until it yields to the loop. */
export function resumeGuestTurn(): void {
  if (continuation) return;
  startGuestLoop();
  // A continuation begun from the loop is an `await`'s; one begun inside a bracket (a compiled async function's
  // catch or finally restoring its frame before its first await, under a timer or a stream's read) extends that
  // bracket, whose end then counts nothing: its time is the bracket's entry's, counted here when the turn ends.
  const fromTheLoop = depth === 0;
  if (fromTheLoop) activeSince = clock!();
  continuation = true;
  enqueue(() => {
    continuation = false;
    if (depth === 0) {
      const took = clock!() - activeSince;
      active += took;
      if (entryAccount) { if (fromTheLoop) countEntry('await', undefined, took); else countEntry(outerKind, outerSource, took); outerSource = undefined; }
    }
  });
}

export interface EventLoopUtilization {
  idle: number;
  active: number;
  utilization: number;
}

/** Internal reading of the existing realm dispatch account. The caller supplies
 * its host monotonic timestamp; this neither starts the loop nor reads a clock.
 * Time outside our brackets may be host execution, not just an idle loop. */
export function guestExecutionActiveMs(now: number): number {
  return active + (clock && (depth > 0 || continuation) ? now - activeSince : 0);
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
