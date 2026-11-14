# ADR-0018: A Node process's loop is libuv, and Node's C libraries are one WALI library in its memory

Status: Proposed (design; nothing built).

Date: 2026-11-14. Served: browser-substrate ADR-0234 §7 ("A Node process's loop is libuv itself") and ADR-0236 step 5
("Tabnode's loop becomes libuv's"; done when `node` in the tab runs Next.js's standalone server and Prisma's CLI), card
VO-3806. Supersedes, when built: ADR-0017's loop (`system.ts`, "the engine's own loop"), the substrate's
`linux-event-loop.ts`, and ADR-0016 §1's "why not the WALI library now", whose condition (a loader) the substrate now
meets.

## Context

### What Node is (as browser-substrate ADR-0234 §7 reads Node v24.21.0)

Node is its JavaScript library over its C++ bindings (`src/*_wrap.cc`) over libuv (`deps/uv`). One loop, `uv_run`,
owns every handle, request and completion. After each callback libuv makes into JavaScript, Node drains the microtask
queue itself (`InternalCallbackScope::Close`, `src/api/callback.cc:157`). Asynchronous work that is not a descriptor's
readiness (fs requests, crypto's `pbkdf2` and `scrypt`, zlib, `getaddrinfo`) runs on libuv's threadpool, and its
completion reaches the loop through `uv_async_send`, a write the loop's poll sees.

### What the engine does today (tabnode 167e5d7, browser-substrate c979486e69d)

- **Two re-readings of libuv.** `system.ts` keeps timers, completions and immediates in libuv's phase order
  (ADR-0017). browser-substrate's `linux-event-loop.ts` parks the task in `epoll_pwait` until the engine's nearest
  deadline, and while a promise the engine handed out is unsettled it parks at most `ENGINE_QUANTUM_MS` (4 ms), so a
  browser task can settle it between parks: a poll.
- **Bindings that re-encode libuv's rules.** About 6,000 lines of `src/node-lib/binding/` face the loop (`handles`,
  `tcp_wrap`, `pipe_wrap`, `tty_wrap`, `udp_wrap`, `stream_wrap`, `kernel_stream`, `process_wrap`, `spawn_sync`,
  `fs`, `fds`, `child_stdio`): ordering, half-close, end of stream, ref and unref, close callbacks.
- **C libraries in a module of their own.** `node-deps.wasm` (ADR-0016) is a wasip1 reactor with its own memory,
  holding OpenSSL and ncrypto, because a WALI library needed a loader the substrate did not have.
- **No native addon loads.** browser-substrate's `linux-tree-native.ts` refuses every `.node`: "a WALI Node-API side
  module has no loader on this machine".

### What the substrate now holds

- A loader (`packages/wali/linux/host/dynamic-loader.mjs`, browser-substrate ADR-0236 step 4) that loads a WALI
  program's shared libraries into its process memory against `libc.so`, as musl's ld.so finds them.
- libuv 1.52.1, Node v24.21.0's `deps/uv` pin, compiles with the WALI toolchain: all 35 of its Linux sources
  (ADR-0234 §7, read 2026-11-13).
- A Node process is the one task with a worker of its own (browser-substrate ADR-0227): its engine is JavaScript, and
  JSPI does not suspend across JavaScript frames, so its calls block in `Atomics.wait` on its worker's word.

## Decision

### 1. Node's C libraries are one WALI shared library in the Node process's memory

`libnode.so` holds what Node links from `deps/`: libuv first, then OpenSSL and ncrypto, llhttp, Ada, zlib, brotli,
zstd and nghttp2, each with Node's configuration and each difference named as ADR-0016 names OpenSSL's. It is built by
the WALI SDK from Node's own source tarball (pinned by digest) and linked against `libc.so`. The Node process's worker
loads it into the process's memory through the same loader a program's libraries use, so a `.node` addon `dlopen`s
into the same image: one libc, one `malloc` (browser-substrate ADR-0231 §3). `node-deps.wasm`, its own memory and its
WASI imports go.

### 2. `node` is a WALI program, and its `main` runs `uv_run`

A library runs only in a process whose libc musl's startup has made (its TLS, `environ`, its thread pointer), and the
loader instantiates libraries into a program (its table, its stack pointer, its entry). So `/usr/bin/node` is a WALI
program, not a host program, and its `main` has the shape of Node's own (`src/node_main.cc`, `node::Start`): it starts
libuv's default loop, calls the engine's bootstrap (an import into the realm's JavaScript, which runs Node's library
and returns), then calls `uv_run(UV_RUN_DEFAULT)` itself, and exits with the run's status. libuv parks in
`epoll_wait` in the kernel, as any program's call does. The realm still runs on the Node process's own worker, and a
kernel wait there blocks on the worker's word (browser-substrate ADR-0227, "A Node process is the one task with a
worker of its own"). browser-substrate's `linux-calls.ts`, `linux-event-loop.ts` and the host program marker for
`node`, and `system.ts`'s loop, go. Node's own `lib/timers.js` runs over a `timers` binding on a `uv_timer_t`, in the
shape of Node's own binding (`src/timers.cc`, read when that step is written).

*Why `main` calls `uv_run`, and not the realm:* a JSPI suspension may have no JavaScript frame between the task's
`promising` entry and the `Suspending` import (browser-substrate ADR-0227). With `main` calling `uv_run`, the stack
from `_start` to §4's `drain` is WebAssembly alone; a realm that called `uv_run` would stand between them.

### 3. A binding is glue over libuv, as Node's `src/*_wrap.cc` is

Each handle object owns its `uv_handle_t` (`uv_tcp_t`, `uv_pipe_t`, `uv_tty_t`, `uv_udp_t`, `uv_process_t`,
`uv_signal_t`, `uv_fs_event_t`) in the process's memory; each request its `uv_req_t`. libuv's callbacks are imports
that call the handle's JavaScript, as `MakeCallback` does. What a binding decides is what Node's C++ decides; what libuv
decides (ordering, half-close, end of stream, ref and unref, close) is libuv's, and the TypeScript that re-encoded it
goes.

### 4. Microtasks drain after each callback

libuv calls C: each handle's callbacks are `libnode`'s glue, as Node's `src/*_wrap.cc` callbacks are (`OnRead`,
`OnConnection`, `AfterWrite`). The glue calls the handle's JavaScript (an import, as `MakeCallback` calls into V8),
and when it returns calls `drain`, a `Suspending` import, before it returns to libuv, as Node's
`InternalCallbackScope` closes: the stack suspends, the worker runs its microtasks and then one task, and the
suspension resumes from that task. The resume is a task, not a microtask, because a resume queued as a microtask
would run before the microtasks the drained ones queue. A callback that blocks (a synchronous fs call) blocks the
worker on its word, as today.

### 5. Asynchronous work is libuv's threadpool

`uv_queue_work` runs on libuv's threads, which are the process's pthreads and so the machine's tasks; a completion
reaches the loop through `uv_async_send`. With OpenSSL in `libnode.so`, crypto's asynchronous calls are Node's own
threadpool work, not WebCrypto's promises. So no browser promise is pending on the loop, and the poll bound goes.

### 6. Children are `uv_spawn`

A child process is `uv_spawn`, a clone with an entry, and an addon's spawn is musl's `posix_spawn`, as
browser-substrate ADR-0236 step 5 records. `SYS_posix_spawn_v1` goes.

## Where the evidence stops

- **Read:** libuv compiles with the WALI toolchain (ADR-0234 §7); a task boundary costs 11.3 µs on the page's main
  thread in Chrome; JSPI's suspension and resume about 1 µs (browser-substrate ADR-0227).
- **Read 2026-11-14, libuv 1.52.1 (Node v24.21.0's `deps/uv`, tarball SHA-256 622424ef…2777 as Node's
  `SHASUMS256.txt` gives it) with browser-substrate's prepared native SDK (input lock ad66685e…f1540):** its 35 Linux
  sources compile (`-fPIC -pthread -matomics -mbulk-memory -O2`, CMake's Linux defines, the SDK's Linux headers) and
  link `-shared` into a 168,353-byte module exporting 469 `uv_*` functions. It imports no kernel call: its 216
  function imports are libc's interface, and the SDK's `libc.so` exports every one of them (of its 1,672).
- **The libuv a Node process takes is not Node's pin.** 1.52.1 spawns by `fork()` then exec on Linux
  (`src/unix/process.c:841`; its `posix_spawn` path is Apple's), and a Node process has no fork: its realm cannot be
  copied. libuv uses `posix_spawn` on Linux from 40d45efebf ("unix: use posix_spawn instead of fork", in v1.53.0),
  after a probe; at a267f5688b (2026-10-16, after v1.53.0, in no release yet) the probe is `clone(fn, stack, CLONE_VM |
  CLONE_VFORK)` with no termination signal, where v1.53.0's is `vfork()`, which on this machine takes the
  continuation. So `libnode.so` takes libuv at a267f5688b or the first release with it, as browser-substrate
  ADR-0236 step 5 says, a difference from Node v24.21.0's `deps/uv` named here; musl's `posix_spawn` is then a clone
  with an entry, and the probe needs `CLONE_VM` to share the memory.
- **Not read:** the loader run on a Node process's worker, which holds no
  loader today; a task boundary's cost on a Node process's worker; whether every library of §1 builds as Node
  configures it under the WALI SDK (ADR-0016 built OpenSSL with wasi-sdk, not the WALI SDK).
- **Read 2026-11-14, browser-substrate `packages/wali/linux/host`:** one realm module (`task.mjs`) runs both kinds of
  image: `runImage` instantiates a WALI program, or runs a host program (`runHost`) where the image's facts name one,
  and only in an exec worker of the `"node"` kind (`task.mjs:435-446`); the machine starts that kind for an exec whose
  image is a host program (`machine.mjs:151, 235`). So `node` as a WALI program takes one fact more on its image:
  that its imports name the engine, so its exec gets a `"node"` worker and the engine registered for it (as host
  programs are, `hostPrograms`) answers those imports. *Not read:* a WALI program's kernel waits on that worker,
  which for a host program block on the worker's word (browser-substrate ADR-0227).
- **Open: the engine's identity.** A host program is registered under a digest of the Node baseline's host-executable
  key (browser-substrate `imageHostPrograms`), which moves with each baseline release; a C program names its import
  module at compile time. The engine is named `host:tabnode` until an identity that also pins the interface between
  `libnode`'s C and the engine's JavaScript (both from one Tabnode commit) is decided.
- **Order of building, each a step that runs before the next is written.** Today's engine is asynchronous end to end:
  `createContainer().runNode()` answers a promise of the run's end, its waits `LinuxEventLoop`'s timer and descriptor
  registrations made from JavaScript through the process's raw calls (browser-substrate `linux-node-run.ts`). Under
  libuv, `bootstrap` starts Node's library and returns, and the process lives while libuv holds a referenced handle,
  so the engine's waits become libuv's handles first:
  1. `node` as a WALI program on the Node worker: its `main`, the loop's own handles (`env.c`), the six engine
     imports. *Built 2026-11-14 (native/node), linked; not run.*
  2. The engine's waits as libuv's: its timers on `env.c`'s timer, through the `timers` binding Node's
     `lib/internal/timers.js` drives; `linux-event-loop.ts` and `system.ts`'s loop go.
  3. Standard streams: `tty_wrap`, `pipe_wrap` and the stream base over `uv_tty_t`, `uv_pipe_t` and `uv_write`, so
     `process.stdout` is Node's.
  4. `tcp_wrap` and `stream_wrap` over `uv_tcp_t`; `udp_wrap` over `uv_udp_t`.
  5. `process_wrap` and `spawn_sync` over `uv_spawn`, with libuv at a267f5688b.
  6. `fs` over `uv_fs_*` and its threadpool.
  7. OpenSSL and the rest of §1 into `libnode.so`; addons through `dlopen`; the process's raw calls and
     `linux-calls.ts` go.

## Consequences

- The engine's account of its own handles (the run's end "by Tabnode's own count of its handles") is libuv's:
  `uv_run` returns when no active, referenced handle or request remains.
- A failure in the loop is libuv's or the kernel's, read in their sources, never re-encoded in a binding.
