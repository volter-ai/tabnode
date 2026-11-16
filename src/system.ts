/**
 * WHAT A PROCESS HAS FROM ITS SYSTEM (ADR-0017): its clocks, its timers, its randomness, its diagnostics and the
 * facts `os` reports, each through one door.
 *
 * A tree that is a client of a kernel (ADR-0006) offers the process's Linux calls for these under `TREE_SYSTEM`, and
 * the engine and every guest it runs take them only from there, as a native Node takes them from libuv over the same
 * calls: `clock_gettime` for `process.hrtime`, `performance.now` and `Date`; the loop's side of Node's `timers`
 * binding, libuv's timer and check handles, under Node's own `lib/timers.js` (ADR-0018 item 2); `getrandom`; `uname`,
 * `sysinfo`, `sched_getaffinity` and `/proc`. Nothing here reads the realm's global for them: a realm a kernel's host program
 * runs in has none to read (browser-substrate ADR-0227 §4, "A host program never reaches around the kernel").
 *
 * A container made over no kernel (the engine as a library in a page or a Node process, with its own in-memory tree)
 * has no Linux beneath it. Its system is the realm's own primitives, taken when this module loads, behind the same
 * interface, so the engine has one code path: its facts are the realm's (a page's clock, its `crypto`, its tasks),
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
 * THE LOOP'S SIDE OF NODE'S `timers` BINDING (Node v24.21.0 src/timers.cc over its Environment, src/env.cc): one timer
 * for every JavaScript timer and a check handle for immediates, which Node's own `lib/internal/timers.js` drives through
 * `internalBinding('timers')` (node-lib/binding/timers.ts). On a kernel they are libuv's, in `node`'s C (Tabnode
 * native/node env.c): the two arrays are that C's memory and each call is one of its exports. Over no kernel they are the
 * realm's (`realmTimers`).
 */
export interface SystemTimers {
  /** Node's `ImmediateInfo` (kCount, kRefCount, kHasOutstanding), read by the check handle where the JavaScript writes. */
  readonly immediateInfo: Uint32Array;
  /** Node's `timeoutInfo`: [0] is the count of referenced timers. */
  readonly timeoutInfo: Int32Array;
  /** The loop's now, in whole milliseconds since its start (Environment::GetNowUint64). */
  getLibuvNow(): number;
  /** Starts the timer handle to expire in `durationMs` (Environment::ScheduleTimer). */
  scheduleTimer(durationMs: number): void;
  /** Whether the timer handle holds the loop (Environment::ToggleTimerRef). */
  toggleTimerRef(ref: boolean): void;
  /** Whether a referenced immediate keeps the loop's poll from blocking (Environment::ToggleImmediateRef). */
  toggleImmediateRef(ref: boolean): void;
  /**
   * What the handles call (Node's `setupTimers`): `processTimers` from the timer handle's callback with the loop's now,
   * answering the next expiry (Environment::RunTimers), and `processImmediate` from the check handle's while an
   * immediate is queued and again while one is outstanding (Environment::CheckImmediate).
   */
  setupTimers(processImmediate: () => void, processTimers: (now: number) => number): void;
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
  /** The loop's timer and check handles, under Node's timers. */
  readonly timers: SystemTimers;
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

/**
 * THE REALM'S LOOP, for a container over no kernel: libuv's timer and check handles over the realm's own tasks, in the
 * order libuv runs them. The timer handle is one realm `setTimeout`; when it expires, the timers run (RunTimers), then
 * the check phase, as libuv's iteration goes on from its timers to its check. The check phase is one task of the realm's
 * (a `MessageChannel`'s message, which no clamp delays): posted when a referenced immediate is queued, as libuv's idle
 * handle keeps its poll from blocking, and again while one is outstanding or a referenced one remains, as each
 * iteration of libuv's loop runs its check; an unreferenced immediate alone waits for the next iteration, here the next
 * expiry. Between two tasks the realm runs the microtasks, as `node`'s drain does after each callback. Where the realm
 * is a Node host's, a handle that does not hold the loop does not hold that host either (`unref`).
 */
function realmTimers(): SystemTimers {
  const immediateInfo = new Uint32Array(3);
  const timeoutInfo = new Int32Array(1);
  const clock = (): number => (realmNow ? realmNow() : realmDateNow());
  const base = clock();
  const now = (): number => Math.floor(clock() - base);
  let processImmediate: (() => void) | undefined;
  let processTimers: ((now: number) => number) | undefined;
  let timer: unknown;
  let timerRef = false;
  let immediateRef = false;
  let check: MessageChannel | undefined;
  let checkPosted = false;
  const refTimer = (): void => {
    const handle = timer as { ref?(): void; unref?(): void } | undefined;
    if (handle && typeof handle === 'object') { if (timerRef) handle.ref?.(); else handle.unref?.(); }
  };
  const refCheck = (): void => {
    const port = check?.port1 as unknown as { ref?(): void; unref?(): void } | undefined;
    if (immediateRef) port?.ref?.(); else port?.unref?.();
  };
  const postCheck = (): void => {
    if (checkPosted) return;
    checkPosted = true;
    if (!check) {
      check = new MessageChannel();
      check.port1.onmessage = runCheck;
      refCheck();
    }
    check.port2.postMessage(null);
  };
  // CheckImmediate (env.cc:1613-1636), one call a task: the next is posted while one is outstanding.
  function runCheck(): void {
    checkPosted = false;
    if (immediateInfo[0] === 0) return;
    processImmediate!();
    if (immediateInfo[2]) { postCheck(); return; }
    if (immediateInfo[1] === 0) loop.toggleImmediateRef(false);
    else postCheck();
  }
  // RunTimers (env.cc:1552-1611): the due timers, then the next expiry's handle, then this iteration's check phase.
  const runTimers = (): void => {
    timer = undefined;
    const expiry = processTimers!(now());
    if (expiry !== 0) {
      const duration = Math.abs(expiry) - now();
      loop.scheduleTimer(duration > 0 ? duration : 1);
      loop.toggleTimerRef(expiry > 0);
    } else loop.toggleTimerRef(false);
    if (immediateInfo[0] > 0) postCheck();
  };
  const loop: SystemTimers = {
    immediateInfo,
    timeoutInfo,
    getLibuvNow: now,
    scheduleTimer(durationMs) {
      if (timer !== undefined) realmClearTimeout?.(timer);
      timer = realmSetTimeout?.(runTimers, durationMs);
      refTimer();
    },
    toggleTimerRef(ref) { timerRef = ref; refTimer(); },
    toggleImmediateRef(ref) {
      immediateRef = ref;
      if (ref) postCheck();
      refCheck();
    },
    setupTimers(immediate, timers) { processImmediate = immediate; processTimers = timers; },
  };
  return loop;
}

/**
 * The realm's system, for a container over no kernel. Its clocks are the realm's (`performance`'s shared clock, Date's
 * wall clock), its randomness the realm's `crypto`, its loop's handles the realm's tasks (`realmTimers`). No kernel answers `os`
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
  get timers() { return realmLoop ??= realmTimers(); },
  // The engine's diagnostics over no kernel are the realm's console's, as they always were there.
  trace: realmSay ? (line: string) => realmSay(line) : null,
};

// ---- the process's system ----

let realmLoop: SystemTimers | undefined;
let current: TreeSystem = realmSystem;
/** The system whose loop Node's timers were set up over (systemTimers), once they are. */
let timersOf: TreeSystem | undefined;

/**
 * The system the engine's processes take their facts from: a kernel's tree's from the first container made over one
 * (a host program's realm runs one process, its kernel's), the realm's until then and wherever there is none.
 */
export function useTreeSystem(tree: unknown): void {
  const offered = treeSystemOf(tree);
  if (!offered || offered === current) return;
  // Node's timers take their binding's arrays once, as Node's Environment holds them from before its library loads: a
  // loop's handles are not moved under timers already made.
  if (timersOf !== undefined) throw new Error('tabnode: Node\'s timers were set up over another system\'s loop before this one was offered');
  current = offered;
  // The engine's clock counts from here on the kernel's clock; nothing measured before it is the guests'.
  startedMs = monotonicMs();
  originMs = realtimeMs();
  installRealmDate();
}

/** The process's system. */
export function system(): TreeSystem { return current; }

/** The loop's handles Node's `timers` binding is made over (node-lib/binding/timers.ts): the system's, from then on. */
export function systemTimers(): SystemTimers {
  timersOf = current;
  return current.timers;
}

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
