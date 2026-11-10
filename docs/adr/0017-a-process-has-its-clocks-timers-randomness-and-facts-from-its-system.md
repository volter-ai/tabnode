# ADR-0017: A process has its clocks, timers, randomness, output and system facts from its system

Status: Accepted.

Date: 2026-11-10. Served: card VO-3806's first class row, "a host program never reaches around the kernel"
(browser-substrate ADR-0227 §4, which the owner's design adopted from the reach-around study).

## Context

On a kernel the engine runs as a Linux process (browser-substrate ADR-0227 §2, "Node is a host program"), in a worker
realm it shares with nothing else. Until now the engine and every guest it runs took the host's primitives from that
realm's global, whatever host it was:

- **time**: `process.hrtime`, `performance.now`, `os.uptime`, the guest loop's clock, `child_process`'s and WASI's
  clocks and node-deps' OpenSSL clock were the worker's own `performance.now()`, counted from that worker's start, so
  two processes of one machine read two clocks;
- **timers**: a guest's timers were the realm's `setTimeout` (`guestTimerFunctions(process, host)`), wrapped by the
  substrate's loop (`linux-event-loop.ts adoptTimers`) so a park in `epoll_pwait` knew the deadline;
- **randomness**: `crypto.getRandomValues` for `randomBytes`, `randomUUID`, WASI's `random_get` and OpenSSL's seed;
- **output**: the engine's own diagnostics and a process with no fds of a run's went to the realm's `console`, which in
  a browser worker reaches devtools only;
- **os**: `uname`, the CPUs, memory and load were invented (`Linux 5.10.0`, two CPUs, 4 GiB, 2 GiB free, 0.5);
- **the host**: `child_process`, `sync-child`, `amaro` and `command-line` asked `typeof WorkerGlobalScope`,
  `typeof addEventListener` and `typeof process` which host they were in.

ADR-0015 §1 made the realm's value of a Node global name the guest's wherever the engine had none of its own, which is
how the realm's timers, `crypto` and `performance` reached a guest. The substrate now removes the host's names from a
host program's realm before the engine loads (browser-substrate ADR-0227 §4, the strip), so none of these is there to
take, on either host.

## Decision

### 1. One door: the tree's system

A tree that is a client of a kernel (ADR-0006) offers its process's calls for these under `TREE_SYSTEM`
(`src/system.ts`, `Symbol.for('tabnode.tree.system')`), as it offers its descriptors and sockets:

| What | Its call |
|---|---|
| `clock(0 \| 1)` | `clock_gettime(CLOCK_REALTIME \| CLOCK_MONOTONIC)`, nanoseconds |
| `random(bytes)` | `getrandom` |
| `uname()`, `sysinfo()`, `affinity()` | `uname`, `sysinfo`, `sched_getaffinity` |
| `file(path)` | a file of `/proc`, read through the process's own `open` and `read` |
| `wake(deadline, due)` | the process's loop parks in `epoll_pwait` no later than `deadline` and calls `due` when it has come |
| `trace` | the process's trace (null where none is selected) |

`createContainer` takes the system of the tree it is given (`useTreeSystem`). Every module of the engine takes these
from `system.ts`, never from the realm.

### 2. What each fact is

- **time**: `process.hrtime` is `CLOCK_MONOTONIC` (Node's `uv_hrtime`); `performance.now()` is milliseconds of it since
  the engine began, `performance.timeOrigin` the wall clock then; `process.uptime()` counts on it. On a kernel the
  realm's `Date` is replaced, once, by one whose `now()` and argument-less construction read `CLOCK_REALTIME`; its
  prototype, statics and `instanceof` are the intrinsic's. WASI's and node-deps' clocks are the same two.
- **timers**: the engine keeps its own timer list (`system.ts`), each deadline a monotonic reading. It tells the loop
  the nearest (`wake`) and runs the due ones when called back, one worker task each, in deadline order, then the
  immediates queued before them (libuv's timer and check phases). A guest's global timers, the `timers` module and the
  engine's own internal timers are all this list's; `async_hooks` carries a program's context into its callbacks
  (`carryTimerCallbacks`). No realm timer is taken.
- **randomness**: `getrandom` for `randomBytes`, `randomFill`, `randomUUID`, `getRandomValues`, WASI's `random_get` and
  OpenSSL's entropy. A guest's `globalThis.crypto` is the engine's `webcrypto`, whose randomness is this one.
- **output**: a program's output is its own fds 1 and 2 (its run's streams); its `console` is its own, with no echo to
  a realm console on a kernel, and its timers, counters and groups are its own. The engine's own diagnostics (a
  failed esbuild load, a watcher's throw, `util.debuglog`) are `engineTrace`, a line on the process's trace, never a
  console. The engine's readings (`trace-output.ts`) are said on the same trace, asked for exactly when one is
  selected.
- **os**: as libuv reads them on Linux: `os.type/release/version/machine/hostname` from `uname`; `os.cpus()` from
  `/proc/stat` and `/proc/cpuinfo`; `os.totalmem()` and `os.freemem()` from `/proc/meminfo`'s `MemTotal` and
  `MemAvailable` (`sysinfo` where it cannot be read); `os.loadavg()` from `sysinfo`; `os.uptime()` from `/proc/uptime`;
  `os.availableParallelism()` and `navigator.hardwareConcurrency` from `sched_getaffinity`; `process.memoryUsage().rss`
  from `/proc/self/status`.
- **the host**: nothing is sniffed per call. Which realm the engine was loaded into is read once, in `system.ts`
  (`realmHost`: a browser's worker or window, a Node process whose `process` emits, or a bare realm), and is consulted
  only where the engine runs over no kernel.

### 3. Over no kernel, the same interface

Where the engine runs over no kernel (its in-memory tree, as a library in a page, a page's worker or a Node process:
`createContainer()` with no kernel's tree), its system is the realm's own primitives, taken when `system.ts` loads,
behind the same interface: `performance`'s clock and `Date`'s, the realm's `crypto.getRandomValues`, its `setTimeout`
as the timers' wake, its `console` as the trace. `os` there answers the fixed figures the engine always gave (a Linux
x64 of 4 GiB and 2 CPUs), which describe no machine; that is said at `realmSystem`'s site. These modes have no Linux
under them and keep working as they did.

### 4. What ADR-0015 §1 now says

A guest's timers, `performance`, `crypto`, `atob` and `btoa` are the engine's own (§2 above; the buffer module's for
`atob` and `btoa`). The names a guest's global still takes from the realm are the web platform's interfaces the
substrate's strip keeps for the engine (browser-substrate ADR-0227 §4, "What the strip keeps"): `URL`,
`URLSearchParams`, `AbortController`, `EventTarget`, `Event`, `DOMException`, `Blob`, `File`, the web streams,
`structuredClone`, `CompressionStream`, `SubtleCrypto`. Each is replaced by Node's own file as a binding can answer it.

## Consequences

- Every process of a kernel reads one clock; a worker's start is no process's origin.
- A guest's timers are woken by the kernel: a park in `epoll_pwait` is the only wait, and no browser timer runs.
- `os` reports the machine the kernel runs on.
- On a kernel, an engine diagnostic is lost when no trace is selected, as a native program's is.
- On a kernel, a rejection nothing handles ends the process through its host (browser-substrate task.mjs, "a host
  program that fails"): the realm's `unhandledrejection` is the machine layer's, so a process's own
  `unhandledRejection` listener is not called there.
- *Where evidence stops*: tried through the substrate's door (its PR); the realm's own figures over no kernel are not
  re-measured.
