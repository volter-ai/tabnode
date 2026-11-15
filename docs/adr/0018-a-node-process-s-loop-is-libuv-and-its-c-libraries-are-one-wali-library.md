# ADR-0018: A Node process's loop is libuv, and Node's C libraries are one WALI library in its memory

Status: Proposed. Step 1 built and run, step 2's waits built and run (2026-11-15); the rest is design.

Date: 2026-11-14. Served: browser-substrate ADR-0234 §7 ("A Node process's loop is libuv itself"), ADR-0236 hole 12
("A host program parked in Linux receives none of the engine's work") and ADR-0236 step 5 ("Tabnode's loop becomes
libuv's"; done when `node` in the tab runs Next.js's standalone server and Prisma's CLI), card VO-3806. Supersedes,
when built: ADR-0017's loop (`system.ts`, "the engine's own loop"), the substrate's `linux-event-loop.ts`, and
ADR-0016 §1's "why not the WALI library now", whose condition (a loader) the substrate now meets.

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
`InternalCallbackScope` closes: the stack suspends, the worker runs its microtasks and then its event loop's other
work, and the suspension resumes from the worker's next task (the machine realm's `task`, browser-substrate
`host/task.mjs`). The resume is a task, not a microtask, because a resume queued as a microtask would run before the
microtasks the drained ones queue. Its kind is the host's: in a tab a port's message, one task; on the Node host an
immediate, because Node serves a port up to 1,000 messages in one callback, so a message the realm posts itself runs
before the loop's other work. A callback that blocks (a synchronous fs call) blocks the worker on its word, as today.

### 5. Asynchronous work completes into the loop's poll: libuv's threadpool, and the machine's devices

Node's asynchronous work reaches its loop through one door, a descriptor its poll sees. `uv_queue_work` runs on
libuv's threads, which are the process's pthreads and so the machine's tasks, and its completion is `uv_async_send`
(Node's `ThreadPoolWork::ScheduleWork`, `src/threadpoolwork-inl.h:37`). The engine's own completed work arrives the
same way: V8 posts it to the isolate's platform, and Node's `PerIsolatePlatformData::PostTaskImpl` wakes the loop with
`uv_async_send(flush_tasks_)` (`src/node_platform.cc:343-363`), whose tasks run after `uv_run` returns
(`platform->DrainTasks`, `src/api/embed_helpers.cc:46`). So fs requests, `getaddrinfo` and the work Node does in its
own C are libuv's threadpool here.

The browser's own engine services are another case (browser-substrate ADR-0236, hole 12): `SubtleCrypto`,
`WebAssembly.compile` and `instantiate` (and the streaming forms), a `Blob`'s reads, and `CompressionStream` and
`DecompressionStream`. The browser settles each on the thread that asked, and a Node process's thread is blocked in
Linux while its loop parks, so the answer waits for the park to end. Each is native work the program should keep, so
each is a **device of the machine**, run by the machine's own worker, which never blocks (browser-substrate
`host/machine.mjs`, "It never blocks and runs no kernel code"), reached through a driver in the kernel, as Linux
reaches a crypto accelerator through a descriptor (AF_ALG, `/dev/crypto`):
- a request is a descriptor the program waits on in its loop's epoll, as any descriptor;
- the device runs the browser's call on its own worker, completes bytes into the buffer the request queued, and sends
  an object (a `CryptoKey`, a `WebAssembly.Module`, both serializable between a page's workers) to the program's
  worker by message;
- the descriptor turns readable, so the park ends through Linux and the request's callback runs in the poll phase,
  as a threadpool completion's does.

`WebAssembly.compile` stays asynchronous, on the machine's worker, where the browser compiles it as it would for any
page. What the device answers, Node does with OpenSSL, zlib or its C++ in the process (Node's `node:crypto`,
`lib/internal/crypto/*`; its `CompressionStream` is zlib, `lib/internal/webstreams/compression.js:34-37`; its Blob
reads are `reader.pull`, `lib/internal/blob.js:440`); here the browser's native implementation does it, faster than
any of those compiled to WebAssembly.

A synchronous form waits on the device too: the call blocks in Linux on the device's descriptor, as a blocking `read`
waits on any device, while the machine's worker answers it. So the browser answers synchronous calls as well:
`createHash` and `createHmac` with their incremental `update`, `hash`, `pbkdf2Sync`, `hkdfSync`, `sign` and `verify`
without a callback, `generateKeyPairSync`, `createCipheriv`'s `update` and `final`. A call too small to be worth the
device's round trip (a digest of a few hundred bytes) is answered in the process, by OpenSSL, where a reading shows
the round trip costs more than the work; the bound is measured, not assumed.

OpenSSL stays in `libnode.so` for what Node's crypto needs and WebCrypto does not have. Read in Tabnode's
`src/shims/crypto.ts` (2026-11-15), which today answers `node:crypto` in JavaScript (`sha.js`, `@noble/hashes`) and
uses the realm's `SubtleCrypto` for `webcrypto.subtle`, the asynchronous `sign` and `verify`, and `generateKeyPair`:
- the calls below the measured bound above;
- algorithms WebCrypto does not define: MD5, SHA-224, SHA-512/256, SHA-3, SHAKE, BLAKE2, RIPEMD-160, scrypt, argon2,
  ChaCha20-Poly1305 and the AES modes beside CBC, CTR and GCM, DSA, Diffie-Hellman groups, `ECDH` on any curve,
  RSA's raw `privateEncrypt` and `publicDecrypt`, primes (`checkPrime`, `generatePrime`), `X509Certificate`;
- TLS, OpenSSL through memory BIOs (ADR-0016).

*Open: the device is not designed.* It is the machine's (browser-substrate `host/machine.mjs`, and a driver in its
kernel), not this engine's: its descriptor's kind, its request layout, how an object's message is matched to its
request, and how an `Atomics.waitAsync` on memory outside the process's memory (a wait the realm makes on memory no
Linux call reaches) is answered are unread. Until it exists, each of those services answers only when the park ends
for another reason, which is hole 12's defect.

### 6. Children are `uv_spawn`

A child process is `uv_spawn`, a clone with an entry, and an addon's spawn is musl's `posix_spawn`, as
browser-substrate ADR-0236 step 5 records. `SYS_posix_spawn_v1` goes.

### 7. On the machine, the realm's own `globalThis` is the process's global

ADR-0015 resolves every free name of a process's code on its global by rewriting each one onto
`__substrateGuestScope`, a Proxy (`src/guest-scope.ts:138`), or by running the file under `with`, because the engine
runs many processes in one realm. On the machine it does not: each Node process has a worker and a realm of its own,
and `node` is its own WALI program (§2). So there the realm's `globalThis` is the process's global, Node's bootstrap
installs Node's globals on it (`lib/internal/bootstrap/node.js`), and a file compiles as Node compiles it, with no
rewrite, no Proxy and no `with`. What stays is browser-substrate ADR-0236's hole 13: a page's engine carries no
context across `await`, so `AsyncLocalStorage`'s rewrite of async functions remains, made once per file when the image
is built.

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
- **Not read:** whether every library of §1 builds as Node configures it under the WALI SDK (ADR-0016 built OpenSSL
  with wasi-sdk, not the WALI SDK).
- **Read 2026-11-15, on the Node host (Node v26.12.0), Rallly's image (browser-substrate `rallly:3e63239`) booted on
  a clone of its disk:** `node` and `libnode.so` built by `scripts/build-libnode.sh` from Node v24.21.0's tarball with
  the substrate's prepared native SDK, placed in Rallly's app container (`/opt/programs/bin/node-libuv`,
  `/opt/programs/lib/libnode.so`) and run there beside the image's own `/usr/bin/node`, today's host program, in one
  machine. The loader loads `libnode.so` on the program's worker; a kernel wait of the program (libuv's `epoll_wait`)
  blocks that worker as any program's does; `node -e "setTimeout(() => console.log('ok'), 50)"` prints `ok` and ends 0.
  Each reading is a `docker exec` of `sh -c` timed from the host (an exec of `true` takes 77 to 98 ms), five times:
  - `node -e "console.log('ok')"`: libuv 215 to 291 ms (median 261), today 267 to 387 ms (median 272);
  - the 50 ms timer program: libuv 272 to 346 ms (median 334), today 265 to 326 ms (median 287); over three boots,
    seven each, medians 323 and 300 ms. **Slower than today's** by more than the print's difference, its cause not
    read;
  - one 50 ms timer's lateness, read by the program: libuv 0.61 to 3.30 ms (median 1.30), today 1.39 to 2.40 ms
    (median 1.92);
  - a chain of 1,000 `setImmediate`s, per turn: libuv 27.5 to 56.8 µs (median 32.7), today 7.4 to 14.8 µs (median
    8.8). The turn is libuv's iteration (its `epoll_wait` with no timeout, a call into the machine's kernel) and the
    drain, an immediate of the Node host's worker. In a bare Node worker an immediate's turn is 17 to 43 µs and a port
    message's 8.5 to 11 µs; today's turn is a port message inside Node's batch of 1,000, which serves nothing else
    meanwhile. **This reading is slower than today's**: a callback's turn costs about four times as much on the Node
    host. The tab's drain (a port message, one task) is not read on a Node worker's equivalent there.
  - `crypto.subtle.deriveBits` (PBKDF2, 4,096 iterations) awaited beside a 1 s interval, once in each of three boots:
    libuv 52 and 52 ms; today 4,254, 4,718 and 4,941 ms. With the drain resumed by a port's message instead it was not
    settled in 15 s (Node's batch). 52 ms is the next callback libuv makes, the engine's own 50 ms run check (read in
    `src/shims/child_process.ts:1356, 1430`; its count of the run's handles, which goes with steps 3 to 6); with no
    callback the answer waits for the park to end, which is §5's device.
- **Read 2026-11-14, browser-substrate `packages/wali/linux/host`:** one realm module (`task.mjs`) runs both kinds of
  image: `runImage` instantiates a WALI program, or runs a host program (`runHost`) where the image's facts name one,
  and only in an exec worker of the `"node"` kind (`task.mjs:435-446`); the machine starts that kind for an exec whose
  image is a host program (`machine.mjs:151, 235`). So `node` as a WALI program takes one fact more on its image:
  that its imports name the engine, so its exec gets a `"node"` worker and the engine registered for it (as host
  programs are, `hostPrograms`) answers those imports. Its kernel waits on that worker were read 2026-11-15 (below).
- **Open: the engine's identity.** A host program is registered under a digest of the Node baseline's host-executable
  key (browser-substrate `imageHostPrograms`), which moves with each baseline release; a C program names its import
  module at compile time. The engine is named `host:tabnode` until an identity that also pins the interface between
  `libnode`'s C and the engine's JavaScript (both from one Tabnode commit) is decided.
- **Order of building, each a step that runs before the next is written.** Today's engine is asynchronous end to end:
  `createContainer().runNode()` answers a promise of the run's end, its waits timer and descriptor registrations made
  from JavaScript through the process's raw calls (browser-substrate `linux-node-run.ts`). Under
  libuv, `bootstrap` starts Node's library and returns, and the process lives while libuv holds a referenced handle,
  so the engine's waits become libuv's handles first:
  1. `node` as a WALI program on the Node worker: its `main`, the loop's own handles (`env.c`), the engine's
     imports, a drain after each of Node's callback scopes (the bootstrap's, StartExecution's, and each process
     event's, ProcessEmit's). *Built 2026-11-14 (native/node); run 2026-11-15* (above): the image's facts name the
     engine its imports name, and its task's worker answers them from the module registered under that name
     (browser-substrate `host/image.mjs` `engine`, `host/task.mjs` `engineImports`); it runs in the worker its exec
     lands in, which needs no worker of the `"node"` kind, since a Node host's two kinds are one and a tab's differ
     only by their script's name for its memory measurement.
  2. The engine's waits as libuv's: its timers on `env.c`'s timer, through the `timers` binding Node's
     `lib/internal/timers.js` drives; `linux-event-loop.ts` and `system.ts`'s loop go. *Read 2026-11-14:* the binding
     is `immediateInfo` and `timeoutInfo` (arrays the JavaScript keeps in C's memory, both now in `env.c`),
     `scheduleTimer`, `toggleTimerRef`, `toggleImmediateRef`, `getLibuvNow` and `setupTimers`. Node's `lib/timers.js`
     and `lib/internal/timers.js` take, beside what the engine vendors or binds already, `internal/linkedlist`,
     `internal/priority_queue` and `internal/async_context_frame`, vendored with them, and `task_queue`'s
     `enqueueMicrotask`. **`AsyncLocalStorage` is Node's own, over the engine's frame.** Node 24's timers carry its store
     through `internal/async_context_frame`, whose active form reads and writes one value, the current frame (a map of
     each storage to its store), through `internalBinding('async_context_frame')`'s
     `getContinuationPreservedEmbedderData` and `setContinuationPreservedEmbedderData`, which V8 keeps across `await`.
     A page's engine exposes no such data, but the engine already keeps that one value the same way: its frame, "every
     storage's store, as one frame", restored where each async function it compiles resumes (`src/shims/async_hooks.ts`,
     `__substrateResume`, `__substrateRestore`). So the binding is the engine's frame register; `--async-context-frame`
     is on, as Node 24's default; Node's `internal/async_context_frame`, its `AsyncLocalStorage` (the async-context-frame
     form) and its timers run unmodified over it; the engine's own `AsyncLocalStorage` and `carryTimerCallbacks` go.
     *Built and run 2026-11-15, its waits:* every wait of the engine is a handle of libuv's loop (browser-substrate
     `packages/node/src/linux-uv-waits.ts`): the engine's nearest deadline is `env.c`'s timer through the binding's
     `scheduleTimer` and `toggleTimerRef`, a deadline that has come (a completion or an immediate it holds) the
     immediate check and idle handles through `immediateInfo` and `toggleImmediateRef`, and a descriptor a `uv_poll_t`
     (`native/node/poll.c`) until each binding owns its handle (steps 3 to 6). `linux-event-loop.ts`, its park and its
     4 ms bound went. *Not built:* Node's `lib/timers.js` and `lib/internal/timers.js` over the binding, in place of
     `system.ts`'s list, which still answers the deadline; so `system.ts`'s loop has not gone. The run's end is still the
     engine's own count, which ends the process by `exit_group`; `beforeExit` and `exit` from `main` are Node's once the
     handles are libuv's.
  3. Node's bootstrap on the realm's own global (§7), and the standard streams: `tty_wrap`, `pipe_wrap` and the
     stream base over `uv_tty_t`, `uv_pipe_t` and `uv_write`, so `process.stdout` is Node's.
  4. `tcp_wrap` and `stream_wrap` over `uv_tcp_t`; `udp_wrap` over `uv_udp_t`.
  5. `process_wrap` and `spawn_sync` over `uv_spawn`, with libuv at a267f5688b.
  6. `fs` over `uv_fs_*` and its threadpool.
  7. OpenSSL and the rest of §1 into `libnode.so`; addons through `dlopen`; the process's raw calls and
     `linux-calls.ts` go.

## Consequences

- The engine's account of its own handles (the run's end "by Tabnode's own count of its handles") is libuv's:
  `uv_run` returns when no active, referenced handle or request remains.
- A failure in the loop is libuv's or the kernel's, read in their sources, never re-encoded in a binding.
