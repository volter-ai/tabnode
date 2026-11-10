/**
 * WHAT A PROCESS HAS FROM ITS SYSTEM (ADR-0017): its clocks, its timers, its randomness, its diagnostics and the
 * facts `os` reports, each through one door.
 *
 * A tree that is a client of a kernel (ADR-0006) offers the process's Linux calls for these under `TREE_SYSTEM`, and
 * the engine and every guest it runs take them only from there, as a native Node takes them from libuv over the same
 * calls: `clock_gettime` for `process.hrtime`, `performance.now` and `Date`; a timer list of the engine's own whose
 * nearest deadline the process's loop parks for in `epoll_pwait`; `getrandom`; `uname`, `sysinfo`,
 * `sched_getaffinity` and `/proc`. Nothing here reads the realm's global for them: a realm a kernel's host program
 * runs in has none to read (browser-substrate ADR-0227 §4, "A host program never reaches around the kernel").
 *
 * A container made over no kernel (the engine as a library in a page or a Node process, with its own in-memory tree)
 * has no Linux beneath it. Its system is the realm's own primitives, taken when this module loads, behind the same
 * interface, so the engine has one code path: its facts are the realm's (a page's clock, its `crypto`, its timers),
 * and what `os` reports where no kernel answers is said at `realmSystem`'s site.
 */

/** The key a tree offers its process's system under. */
export const TREE_SYSTEM = Symbol.for('tabnode.tree.system');

/** uname(2)'s answer. */
export interface SystemUname { sysname: string; nodename: string; release: string; version: string; machine: string }

/** sysinfo(2)'s answer, its sizes in bytes (`mem_unit` applied). */
export interface SystemInfo {
  uptime: number;
  /** The 1, 5 and 15 minute load averages, as numbers (`loads[i] / 65536`). */
  loads: [number, number, number];
  totalram: number; freeram: number; sharedram: number; bufferram: number; totalswap: number; freeswap: number;
  procs: number;
}

/**
 * A process's system calls, as a kernel's tree offers them. Each is the Linux call of its name, made by the calling
 * process; a failure throws an error carrying the call's `code`.
 */
export interface TreeSystem {
  /** clock_gettime(2) of CLOCK_REALTIME (0) or CLOCK_MONOTONIC (1), in nanoseconds. */
  clock(id: 0 | 1): bigint;
  /** getrandom(2): `into` filled whole from the kernel's random pool. */
  random(into: Uint8Array): void;
  uname(): SystemUname;
  sysinfo(): SystemInfo;
  /** sched_getaffinity(2) of the process: how many CPUs it may run on. */
  affinity(): number;
  /** A file of the kernel's (`/proc/...`), read whole; undefined where it cannot be read. */
  file(path: string): string | undefined;
  /**
   * The engine's timers' nearest deadline, in milliseconds of CLOCK_MONOTONIC (null: none). The process's loop parks
   * no later than it, and calls `due` once it has come, from a turn of its own (no caller on the stack).
   */
  wake(deadline: number | null, due: () => void): void;
  /** The process's trace, a line at a time; null where none is selected. */
  readonly trace: ((line: string) => void) | null;
}

/** The system a tree offers, where it offers one. */
function treeSystemOf(tree: unknown): TreeSystem | undefined {
  if (tree === null || (typeof tree !== 'object' && typeof tree !== 'function')) return undefined;
  const offered = (tree as Record<symbol, unknown>)[TREE_SYSTEM];
  return offered !== null && typeof offered === 'object' ? offered as TreeSystem : undefined;
}

// ---- the realm's own, for a container over no kernel ----

/**
 * The realm's primitives, taken when this module loads. A realm a kernel's host program runs in has had its host
 * names removed before the engine loaded, so each may be absent here; that realm's system is its tree's, and these are
 * never called there.
 */
type RealmTimer = (fn: () => void, ms?: number) => unknown;
const realm = globalThis as unknown as {
  performance?: { now?(): number; timeOrigin?: number; memory?: unknown };
  crypto?: { getRandomValues?(into: Uint8Array): Uint8Array };
  setTimeout?: RealmTimer; clearTimeout?: (id: unknown) => void;
};
const realmPerformance = realm.performance;
const realmNow = typeof realmPerformance?.now === 'function' ? realmPerformance.now.bind(realmPerformance) : undefined;
const realmOrigin = realmNow && typeof realmPerformance?.timeOrigin === 'number' ? realmPerformance.timeOrigin : Date.now();
const realmRandom = typeof realm.crypto?.getRandomValues === 'function' ? realm.crypto.getRandomValues.bind(realm.crypto) : undefined;
const realmSetTimeout = typeof realm.setTimeout === 'function' ? realm.setTimeout.bind(globalThis) as RealmTimer : undefined;
const realmClearTimeout = typeof realm.clearTimeout === 'function' ? realm.clearTimeout.bind(globalThis) : undefined;
const realmDateNow = Date.now;
const realmConsole = (globalThis as { console?: { error?(...args: unknown[]): void } }).console;
const realmSay = typeof realmConsole?.error === 'function' ? realmConsole.error.bind(realmConsole) : undefined;

/**
 * Which realm the engine was loaded into, read once here and nowhere else: a browser's worker or window, a Node process
 * (one whose `process` emits; the engine as a library there), or a bare realm (a kernel's host program's, whose host
 * names were removed before the engine loaded). On a kernel nothing depends on it: what the process has, its tree's
 * system says.
 */
const realmGlobal = globalThis as unknown as Record<string, unknown>;
const realmNode = realmGlobal.process as { on?: unknown; off?: unknown; versions?: { node?: unknown } } | undefined;
export const realmHost: 'worker' | 'window' | 'node' | 'bare' =
  typeof realmGlobal.WorkerGlobalScope !== 'undefined' ? 'worker'
    : typeof realmGlobal.document !== 'undefined' ? 'window'
      : realmNode !== null && typeof realmNode === 'object' && typeof realmNode.on === 'function' && typeof realmNode.versions?.node === 'string' ? 'node'
        : 'bare';
/** A Node host's own `process`, where the engine is a library in one; null elsewhere. */
export const realmProcess = realmHost === 'node' ? realmNode as unknown as {
  on(event: string, listener: (...args: never[]) => void): unknown; off(event: string, listener: (...args: never[]) => void): unknown;
  getBuiltinModule?(name: string): unknown; execPath?: string;
} : null;

let realmWake: unknown;

/**
 * The realm's system, for a container over no kernel. Its clocks are the realm's (`performance`'s shared clock, Date's
 * wall clock), its randomness the realm's `crypto`, its timers' wake the realm's `setTimeout`. No kernel answers `os`
 * here: `uname` and `sysinfo` are the fixed figures the engine has always given a page (a Linux x64 of 4 GiB, 2 CPUs),
 * which describe no machine.
 */
const realmSystem: TreeSystem = {
  clock: (id) => id === 1
    ? BigInt(Math.round((realmOrigin + (realmNow ? realmNow() : realmDateNow() - realmOrigin)) * 1e6))
    : BigInt(realmDateNow()) * 1_000_000n,
  random(into) {
    if (!realmRandom) throw Object.assign(new Error('ENOSYS: this realm has no source of randomness'), { code: 'ENOSYS' });
    for (let at = 0; at < into.length; at += 65536) realmRandom(into.subarray(at, Math.min(into.length, at + 65536)));
  },
  uname: () => ({ sysname: 'Linux', nodename: 'localhost', release: '5.10.0', version: '#1 SMP', machine: 'x86_64' }),
  sysinfo: () => ({ uptime: Math.floor((realmNow ? realmNow() : 0) / 1000), loads: [0.5, 0.5, 0.5],
    totalram: 4 * 1024 ** 3, freeram: 2 * 1024 ** 3, sharedram: 0, bufferram: 0, totalswap: 0, freeswap: 0, procs: 1 }),
  affinity: () => 2,
  file: () => undefined,
  wake(deadline, due) {
    if (realmWake !== undefined) realmClearTimeout?.(realmWake);
    realmWake = undefined;
    if (deadline === null || !realmSetTimeout) return;
    realmWake = realmSetTimeout(() => { realmWake = undefined; due(); }, Math.max(0, deadline - monotonicMs()));
  },
  // The engine's diagnostics over no kernel are the realm's console's, as they always were there.
  trace: realmSay ? (line: string) => realmSay(line) : null,
};

// ---- the process's system ----

let current: TreeSystem = realmSystem;

/**
 * The system the engine's processes take their facts from: a kernel's tree's from the first container made over one
 * (a host program's realm runs one process, its kernel's), the realm's until then and wherever there is none.
 */
export function useTreeSystem(tree: unknown): void {
  const offered = treeSystemOf(tree);
  if (!offered || offered === current) return;
  current = offered;
  // The engine's clock counts from here on the kernel's clock; nothing measured before it is the guests'.
  startedMs = monotonicMs();
  originMs = realtimeMs();
  installRealmDate();
  // A timer set before the kernel's system was taken (a module's load) is the kernel loop's from now.
  scheduleWake();
}

/** The process's system. */
export function system(): TreeSystem { return current; }

/** Whether the engine's facts come from a kernel. */
export function onKernel(): boolean { return current !== realmSystem; }

/** CLOCK_MONOTONIC, in milliseconds (a fraction keeps the nanoseconds). */
export function monotonicMs(): number { return Number(current.clock(1)) / 1e6; }
/** CLOCK_MONOTONIC, in nanoseconds: `process.hrtime`'s clock. */
export function monotonicNs(): bigint { return current.clock(1); }
/** CLOCK_REALTIME, in milliseconds since the epoch: `Date.now`'s. */
export function realtimeMs(): number { return Number(current.clock(0) / 1_000_000n); }

/** The bytes of `into` from the system's random pool. */
export function randomFill<T extends ArrayBufferView>(into: T): T {
  current.random(new Uint8Array(into.buffer, into.byteOffset, into.byteLength));
  return into;
}

/** RFC 4122 version 4, from the system's random pool: Node's `crypto.randomUUID`. */
export function randomUUID(): string {
  const bytes = randomFill(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A diagnostic of the engine's own (not a program's output): on the process's trace, where one is selected, and
 * nowhere else. A program's output is its own fd 1 and 2; nothing the engine says goes through a console.
 */
export function engineTrace(...parts: unknown[]): void {
  const trace = current.trace;
  if (!trace) return;
  trace(parts.map((part) => typeof part === 'string' ? part : part instanceof Error ? String(part.stack ?? part) : safeText(part)).join(' '));
}

/** The engine's own diagnostics where its code says `console`: each a line on the trace (`engineTrace`). */
export const engineConsole = { log: engineTrace, info: engineTrace, warn: engineTrace, error: engineTrace, debug: engineTrace, trace: engineTrace };

function safeText(value: unknown): string {
  try { return typeof value === 'object' ? JSON.stringify(value) : String(value); } catch { return String(value); }
}

/**
 * The engine's clock as `performance` shapes it: milliseconds since the engine's start on CLOCK_MONOTONIC, and the
 * wall clock at that start. Every process of a kernel reads the one machine clock (no worker counts from its own
 * origin).
 */
let startedMs = monotonicMs();
let originMs = realtimeMs();
export const performance = {
  now: (): number => monotonicMs() - startedMs,
  get timeOrigin(): number { return originMs; },
};

// ---- the engine's timers ----

/**
 * THE ENGINE'S OWN TIMER LIST. Each timer's deadline is a reading of the system's monotonic clock; the process's loop
 * is told the nearest one (`wake`) and calls back when it has come, and the due timers then run, one task each, in
 * deadline order (libuv's timer phase), the immediates queued before them after (its check phase). No realm timer is
 * taken: on a kernel the loop parks for the deadline in `epoll_pwait`; over no kernel the realm's `setTimeout` is
 * the wake.
 *
 * Handles are numbers, as a browser's are; Node's `Timeout` is built over one where a guest asks
 * (`node-lib/timers.ts`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Callback = (...args: any[]) => void;
interface Timer { id: number; due: number; fn: Callback; args: unknown[]; every: number | null }
const timers = new Map<number, Timer>();
const immediates = new Map<number, { fn: Callback; args: unknown[] }>();
let nextId = 1;
/** A task of the worker's own between two timers, so the microtasks one leaves run before the next (made at first use:
 *  importing the engine opens nothing, host-globals.ts). */
let turn: MessageChannel | undefined;
let turnPosted = false;

/**
 * What carries a program's context into its timers' callbacks (async_hooks.ts: AsyncLocalStorage's store, the entry
 * account): set by it once, applied to each callback as it is scheduled.
 */
type Carrier = (callback: Callback, kind: 'setTimeout' | 'setInterval' | 'setImmediate') => Callback;
let carrier: Carrier | undefined;
export function carryTimerCallbacks(carry: Carrier): void { carrier = carry; }
const carry = (fn: unknown, kind: 'setTimeout' | 'setInterval' | 'setImmediate'): Callback =>
  typeof fn !== 'function' ? () => {} : carrier ? carrier(fn as Callback, kind) : fn as Callback;

function scheduleWake(): void {
  let nearest: number | null = null;
  if (immediates.size > 0) nearest = 0;
  else for (const timer of timers.values()) if (nearest === null || timer.due < nearest) nearest = timer.due;
  current.wake(nearest, runDue);
}

function later(ms: unknown): number {
  const delay = Number(ms);
  // Node's: a delay that is not a number in [1, 2^31 - 1] is 1 ms.
  return monotonicMs() + (delay >= 1 && delay <= 2147483647 ? delay : 1);
}

/** Run the earliest due timer, else the immediates queued until now; another turn follows while more are due. */
function runDue(): void {
  const now = monotonicMs();
  let next: Timer | undefined;
  for (const timer of timers.values()) if (timer.due <= now && (!next || timer.due < next.due)) next = timer;
  if (next) {
    if (next.every === null) timers.delete(next.id);
    else next.due = Math.max(now, next.due) + next.every;
    postTurn();
    call(next.fn, next.args);
    return;
  }
  const queued = [...immediates];
  immediates.clear();
  for (let at = 0; at < queued.length; at++) {
    const [, { fn, args }] = queued[at]!;
    // An immediate's throw is the process's uncaught exception; the ones after it still run, on the next turn.
    if (!call(fn, args)) { for (const rest of queued.slice(at + 1)) immediates.set(rest[0], rest[1]); break; }
  }
  scheduleWake();
}

function postTurn(): void {
  if (turnPosted) return;
  turnPosted = true;
  if (!turn) {
    turn = new MessageChannel();
    turn.port1.onmessage = () => { turnPosted = false; runDue(); };
    // A Node host's port would hold its loop open by itself; what holds it is a pending timer's wake.
    (turn.port1 as unknown as { unref?(): void }).unref?.();
  }
  turn.port2.postMessage(null);
}

/** A callback's throw is reported as the realm reports an uncaught error: out of its own microtask. */
function call(fn: Callback, args: unknown[]): boolean {
  try { fn(...args); return true; }
  catch (error) { queueMicrotask(() => { throw error; }); return false; }
  finally { scheduleWake(); }
}

export function setTimeout(fn: Callback, ms?: number, ...args: unknown[]): number {
  const id = nextId++;
  timers.set(id, { id, due: later(ms), fn: carry(fn, 'setTimeout'), args, every: null });
  scheduleWake();
  return id;
}

export function setInterval(fn: Callback, ms?: number, ...args: unknown[]): number {
  const id = nextId++;
  const every = Number(ms) >= 1 && Number(ms) <= 2147483647 ? Number(ms) : 1;
  timers.set(id, { id, due: monotonicMs() + every, fn: carry(fn, 'setInterval'), args, every });
  scheduleWake();
  return id;
}

export function setImmediate(fn: Callback, ...args: unknown[]): number {
  const id = nextId++;
  immediates.set(id, { fn: carry(fn, 'setImmediate'), args });
  scheduleWake();
  return id;
}

/** One clear for every kind, as Node's and a browser's clears accept each other's ids. */
function clear(id: unknown): void {
  const key = typeof id === 'number' ? id : Number(id);
  if (!timers.delete(key) && !immediates.delete(key)) return;
  scheduleWake();
}
export const clearTimeout: (id?: unknown) => void = clear;
export const clearInterval: (id?: unknown) => void = clear;
export const clearImmediate: (id?: unknown) => void = clear;

/** The engine's timers as one record, for a caller that takes them by name. */
export const engineTimers = { setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate };

// ---- Date on a kernel ----

/**
 * `Date` reads CLOCK_REALTIME. On a kernel the realm's `Date` is replaced, once, by one whose `now()` and argument-less
 * construction read the system's wall clock; its prototype, its statics and `instanceof` are the intrinsic's. Over no
 * kernel the realm's own `Date` already reads the realm's wall clock, which is that system's.
 */
let dateInstalled = false;
function installRealmDate(): void {
  if (dateInstalled) return;
  dateInstalled = true;
  const Intrinsic = Date;
  const now = (): number => realtimeMs();
  const SystemDate: DateConstructor = new Proxy(Intrinsic, {
    construct: (target, args, newTarget): object => Reflect.construct(target, args.length === 0 ? [now()] : args,
      newTarget === SystemDate ? target : newTarget),
    apply: () => new Intrinsic(now()).toString(),
    get: (target, key, receiver) => key === 'now' ? now : Reflect.get(target, key, receiver === SystemDate ? target : receiver),
  });
  Object.defineProperty(globalThis, 'Date', { value: SystemDate, writable: true, configurable: true, enumerable: false });
}
