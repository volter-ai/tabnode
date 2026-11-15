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
`WebAssembly.compile` and `instantiate` (and the streaming forms), and `CompressionStream` and
`DecompressionStream`. (A `Blob`'s reads are not among them once Node's own `lib/internal/blob.js` runs: its bytes are
the process's, and `reader.pull`, `lib/internal/blob.js:440`, reads them there.) The browser settles each on the thread that asked, and a Node process's thread is blocked in
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
`lib/internal/crypto/*`; its `CompressionStream` is zlib, `lib/internal/webstreams/compression.js:34-37`); here the
browser's native implementation does it, faster than any of those compiled to WebAssembly, except a call too small to
be worth the round trip (browser-substrate ADR-0236 hole 12: 16.5 µs empty, 36.8 µs for a 256-byte SHA-256, read in
Chrome).

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

*The device* is browser-substrate ADR-0236 hole 12's `/dev/engine`: its driver is the kernel's
(`packages/wali/linux/arch/wasm/kernel/engine.c`: one session an open, a write one request, a read one answer, a ring
of 256 tags shared with the device), and the device is the machine's own thread (`host/machine.mjs` `engineAttach`,
`engineCall`, `engineEncode`), which runs SubtleCrypto's calls (`encrypt`, `decrypt`, `sign`, `verify`, `digest`,
`generateKey`, `deriveKey`, `deriveBits`, `importKey`, `exportKey`, `wrapKey`, `unwrapKey`) and keeps each key it
answers as a handle of the session, as a hardware key store does. A request and an answer hold at most 1 MiB
(`WASM_ENGINE_BYTES`); a call larger is refused by name and never split (hole 12's open item). The process's session is
the `node` program's descriptor (`native/node/engine_device.c`): a synchronous call blocks in Linux on it (a poll, then
the read), and while an asynchronous call's answer is due it is a `uv_poll_t` of the loop whose readiness is the
engine's `engine_ready` import followed by a drain, so its callback runs in the poll phase. The wire is the device's,
as its other client writes it (browser-substrate `packages/node/src/linux-web-crypto.ts`), in Tabnode's
`src/node-lib/binding/engine_device.ts`.

*The routing is the binding's, per call.* Node's `lib/internal/crypto/*` is unchanged; each class of
`internalBinding('crypto')` (a Hash, an Hmac, a Sign, a job) chooses where its call is answered, so there is one
binding and no second crypto module:

| Call | Answered by |
|---|---|
| A digest or an HMAC over SHA-1, SHA-256, SHA-384 or SHA-512 of more than 4 KiB (`createHash`, `createHmac`, `hash`, `subtle.digest`, `subtle.sign` with HMAC) | the device (`digest`; `importKey` then `sign` or `verify`) |
| The same of 4 KiB or less, and every other digest and HMAC (MD5, SHA-224, SHA-512/256, SHA-3, SHAKE and an XOF length, cSHAKE, BLAKE2, RIPEMD-160) | OpenSSL |
| PBKDF2 and HKDF, every one (`pbkdf2`, `pbkdf2Sync`, `hkdf`, `hkdfSync`, `subtle.deriveBits`) | the device (`deriveBits`) |
| A signature and its verification by RSASSA-PKCS1-v1_5, RSA-PSS, ECDSA on P-256, P-384, P-521, and Ed25519 (`sign`, `verify`, `createSign`, `createVerify`, `subtle.sign`) | the device (`sign`, `verify`) |
| A key pair or secret WebCrypto generates (RSA, EC on its curves, Ed25519, X25519, AES, HMAC) | the device (`generateKey`) |
| A key's import or export in a form WebCrypto holds (raw, SPKI, PKCS#8, JWK) of those keys | the device (`importKey`, `exportKey`) |
| AES-CBC, AES-CTR, AES-GCM, AES-KW, RSA-OAEP (`createCipheriv`'s `update` and `final`, `subtle.encrypt`) | the device (`encrypt`, `decrypt`, `wrapKey`, `unwrapKey`) |
| ECDH and X25519 agreement on curves WebCrypto has | the device (`deriveBits`) |
| scrypt, argon2, ChaCha20-Poly1305, the AES modes beside CBC, CTR, GCM and KW, DSA, Diffie-Hellman groups, ECDH on any other curve, RSA's raw `privateEncrypt` and `publicDecrypt`, primes, `X509Certificate`, PEM and PKCS#1/SEC1 parsing, KeyObject's details | OpenSSL |
| TLS | OpenSSL (ADR-0016) |
| Randomness (`randomBytes`, `randomFill`, `randomUUID`) | OpenSSL's, the kernel's `getrandom` |

The bound is the measured one of hole 12 (the device 39.1 µs at 4 KiB against SHA-256 compiled to WebAssembly
35.9 µs; at 64 KiB 117 µs against 769 µs); a Hash and an Hmac learn their input's length only at `digest`, so one over
a WebCrypto digest keeps its input until then. A key is held where it is answered: its KeyObjectData in OpenSSL, its
CryptoKey in the device's session, or both, each side taking its copy from the other's export the first time a call it
answers needs one (`src/node-lib/binding/crypto_keys.ts`).

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
- **Not read:** whether every library of §1 builds as Node configures it under the WALI SDK. OpenSSL's and ncrypto's
  build is written (`scripts/build-libnode.sh`, ADR-0016 §1) and not run: it takes browser-substrate's side-module
  toolchain for its C++ runtime, and none was prepared on the machine it was written on.
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
- **Order of building: the items are built in this order and run together at the end run.** Today's engine is asynchronous end to end:
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
     form) and its timers run unmodified over it (`src/shims/async_hooks.ts`: the frame is
     `internalBinding('async_context_frame')`; taking Node's `AsyncLocalStorage` reads its `enabled`, as
     `lib/async_hooks.js:297-301` does, which makes the frame active). Node's `AsyncResource` takes the frame when it
     is made and runs in it, in Node's shape (`lib/async_hooks.js:180-292`). The engine's own storage and its timers'
     carrier are not.
     *Built and run 2026-11-15, its waits:* every wait of the engine is a handle of libuv's loop (browser-substrate
     `packages/node/src/linux-uv-waits.ts`), a descriptor a `uv_poll_t` (`native/node/poll.c`) until each binding owns
     its handle (steps 3 to 6). `linux-event-loop.ts`, its park and its 4 ms bound went.
     **Node's timers over the binding.** Node v24.21.0's `lib/timers.js`, `lib/timers/promises.js`,
     `lib/internal/timers.js`, `internal/linkedlist`, `internal/priority_queue`, `internal/async_context_frame` and
     `internal/async_local_storage/async_context_frame` and `run_scope` are vendored unchanged (`src/node-lib/`).
     `internalBinding('timers')` (`src/node-lib/binding/timers.ts`) is `src/timers.cc` over the system's handles
     (`system.ts` `SystemTimers`), and holds what is Node's C++ above them: RunTimers calls `processTimers` again
     after a throw (`src/env.cc:1552-1611`) and CheckImmediate makes each `processImmediate` a callback
     (`src/env.cc:1613-1636`), each throw reported as the process's uncaught exception, to the run whose context frame
     is current, which Node's timers leave the throwing callback's; each call is a callback scope whose ticks run when
     it returns. `env.c` calls each once and its loops are libuv's. The bootstrap of `internal/timers` calls
     `setupTimers` with `getTimerCallbacks(runNextTicks)`'s two, as `lib/internal/bootstrap/node.js` does. There is one
     Environment a realm, as there is one loop: `internal/timers` and `internal/async_context_frame` are the realm's
     one file in every process's graph (`src/node-lib/load.ts` `REALM_ENVIRONMENT`), and each process's `timers` and
     `timers/promises` are its own files over them, its global timers that module's functions, as Node's bootstrap
     makes them. What a process's `timers` makes is counted for that process (`src/guest-timers.ts`, from Node's own
     `_destroyed` and `hasRef()`) for the run's end the engine still decides. The engine's own timers are the library
     graph's `timers` (`src/engine-timers.ts`). The binding's arrays are taken once, as an Environment holds them from
     before its library loads: `net` and `child_process` load on first use, never while the bundle evaluates, and a
     kernel's system offered after Node's timers were set up over the realm's loop is refused (`useTreeSystem`). Over
     no kernel the handles are the realm's: a `setTimeout` the timer, a `MessageChannel`'s task the check
     (`system.ts` `realmTimers`). Where this differs from Node:
     - `runNextTicks` between two timers or two immediates is the tick queue alone: a page's engine cannot run its
       microtask queue from inside a call, so the microtasks a callback queues run at `node`'s drain after the rest
       of its phase, where Node runs them before the next callback.
     - In a realm with no `node` program, an fs request's completion (`engine-timers.ts` `queueCompletion`) is an
       immediate of the check phase, where libuv runs it in the poll phase (item 6 is `uv_fs_*`); a message due to a
       port the process listens to holds a referenced immediate (`portMessagesDue`), so libuv's poll does not block
       while the worker has it to deliver, where a Node port is its own `uv_async_t`.
     - `internal/timers`'s own `process` (its `TimeoutOverflowWarning`) is the realm library's process, not the
       process whose timer it warns of.
     The run's end is still the engine's own count; it decides it when the loop would wait, never on a timer:
     `env.c`'s unreferenced prepare handle, Node's `idle_prepare_handle_` (`src/env.cc:1142-1155`, `1303-1307`),
     tells the engine (`loop_idle`) before each poll that would block. `beforeExit` and `exit` from `main` are Node's
     once the run's end is libuv's.
  3. Node's bootstrap on the realm's own global (§7), and the standard streams: `tty_wrap`, `pipe_wrap` and the
     stream base over `uv_tty_t`, `uv_pipe_t` and `uv_write`, so `process.stdout` is Node's. The glue is
     `native/node`'s, one C file per file of Node's (`handle_wrap.c`, `stream_wrap.c`, `pipe_wrap.c`, `tty_wrap.c`),
     built into the `node` program. **There is one HandleWrap** (`handle_wrap.c`, `src/node-lib/binding/handle_wrap.ts`),
     Node's `src/handle_wrap.cc` split where V8 stands, and every handle of items 3 to 6 is one: a handle is a block of
     the process's memory that begins with its `uv_handle_t`, so its address is its wrap's and every callback into the
     engine names the handle by it, as Node's `handle->data` names its wrap. The binding's object owns its HandleWrap
     and keeps what Node's object keeps: its state (initialized, closing, closed), its close callback and its requests
     in flight; `close`, `ref`, `unref` and `hasRef` are libuv's calls once the state allows them. The block is the
     binding's until the handle is initialized (MarkAsInitialized), freed with its object where it never is (Node's
     OnGCCollect of an uninitialized wrap), and libuv's from then; OnClose makes the close callback where Close was
     given one, closes that callback's scope only then (a drain), and frees the block, as Node's OnClose drops its
     wrap. A stream's or a socket's request (`wrap.h` `tabnode_req_t`) is libuv's request, the number its JavaScript
     gave it and the bytes it owns until its callback. A read, a write (tried at once, the rest `uv_write2`, an IPC
     pipe's handle with it), a shutdown, a listen, an accept and a connect are libuv's, and each callback is an import
     that calls the object's JavaScript, then drains. A JavaScript buffer is not in the process's memory, so a write's
     bytes are copied there (`memory.c`, the one allocator of the bytes and records the engine hands the C), and a
     read's out of libuv's buffer into an ArrayBuffer, as Node's managed buffer is released into one. The run's count
     asks libuv of each initialized handle (active and referenced, closing, or with a request in flight) until the
     run's end is libuv's. `uv_guess_handle` answers every descriptor's type. The program's start is Node's
     PlatformInit for fds 0 to 2 (`stdio.c`: `/dev/null` for one not open, each one's flags and a terminal's termios
     recorded) and its exit Node's ResetStdio (libuv's terminal mode reset, O_NONBLOCK and termios put back), run by
     `exit(3)`, which is also `process.reallyExit`. `process.stdout`, `process.stderr` and `process.stdin` are made as
     Node's `lib/internal/bootstrap/switches/is_main_thread.js` makes them, on first read, and the console writes to
     them; that file is the bootstrap's, so until §7 its stream part is carried in the engine (`src/node-lib/stdio.ts`),
     line for line.
  4. `tcp_wrap` and `stream_wrap` over `uv_tcp_t`; `udp_wrap` over `uv_udp_t`, in the same shape (`tcp_wrap.c`,
     `udp_wrap.c`): an address goes to libuv as Node's binding takes it, its text and its port, parsed by
     `uv_ip4_addr` or `uv_ip6_addr`, and a name comes back as AddressToJS makes it. A realm with no libuv (a tab's
     engine with no machine) has no IPv4, IPv6 or AF_UNIX, and its pipes and terminals are the engine's pairing.
  5. `process_wrap` and `spawn_sync` over `uv_spawn`, with libuv at a267f5688b: libuv's own source at
     a267f5688be25e8d4628e296245a041adc2ca072, GitHub's archive of it pinned by SHA-256 02d51895…a0af
     (`scripts/build-libnode.sh`), where Node v24.21.0 pins 1.52.1 in `deps/uv`; every `native/node` source is compiled
     against it. Its version says 1.53.1-dev, its 35 Linux sources and CMake's Linux defines are 1.52.1's, and its
     difference is the spawn (`src/unix/process.c`: `posix_spawn` after the clone probe, fork only where `posix_spawn`
     cannot carry the options: a uid or gid). A `Process`'s handle is a HandleWrap over native/node's `uv_process_t`
     (`process_wrap.c`), made uninitialized and marked initialized by `spawn` whatever `uv_spawn` answers, as Node's
     ProcessWrap is; a `pipe`, `overlapped` or `wrap` stdio entry names its handle's `uv_stream_t` (StreamForWrap), a
     Pipe, a TCP or a TTY of items 3 and 4; libuv's exit callback is `onexit`'s, with the signal's name as Node's
     `signo_string` gives it (`signo.c`). spawn_sync is Node's SyncProcessRunner in C over a loop of its own
     (`spawn_sync.c`). Node's `child_process` asks no door of the host: a child is the kernel's.
  6. `fs` over `uv_fs_*` and its threadpool. `internalBinding('fs')`, `fs_dir` and `fs_event_wrap` are Node's
     `src/node_file.cc`, `node_dir.cc`, `fs_event_wrap.cc` and `node_stat_watcher.cc`, split where V8 stands: the
     libuv half is `native/node` (`fs.c`, `fs_cp.c`, `fs_event.c`), the V8 half the engine's (`node_file.ts`,
     `node_dir.ts`, `fs_event_wrap.ts`, FSReqBase in `fs_req.ts`). A request owns its `uv_fs_t` in the process's memory,
     its arguments written in the room after it, and is named by its address; a synchronous call is `uv_fs_*` with no
     callback, as `SyncCall`; an asynchronous one runs on libuv's threadpool (the process's pthreads) and completes
     into the loop, where its callback calls the engine (`fs_done`), which runs the request's After and its
     `MakeCallback` or settles its promise, then drains. What Node's C++ decides in C (`MKDirpSync`, `MKDirpAsync`,
     `ReadFileUtf8`, `WriteFileUtf8`) is decided in C the same way; `RmSync` and the `cpSync` calls are C++ over
     `std::filesystem`, and libnode has no C++ library, so their `std::filesystem` calls are written over the POSIX
     calls libc++ makes for them. `fs.watch` is an FSEvent, a HandleWrap over a `uv_fs_event_t` (inotify in the
     process's kernel), made uninitialized and initialized by `start`; `fs.watchFile` a StatWatcher, a HandleWrap over
     a `uv_fs_poll_t`, initialized when it is made. A realm the host gives no `node` program keeps the engine's own
     tree's binding (`fs.ts`), which no longer reaches a kernel's descriptors.
  7. OpenSSL and the rest of §1 into `libnode.so`; addons through `dlopen`; the process's raw calls and
     `linux-calls.ts` go. **Crypto is Node's own, landed as one piece:** Node's `lib/internal/crypto/*`, `keys.js`'s
     `KeyObject` and `x509.js`'s `X509Certificate` among them, over the `crypto` binding, whose glue is `libnode`'s C
     as Node's `src/crypto/crypto_*.cc` is, over ncrypto and OpenSSL, each call answered by the device or by OpenSSL
     as §5 says. It replaces the engine's own `crypto` (`src/shims/crypto*.ts`: `sha.js`, `@noble`, RSA in BigInt)
     whole; until it lands, `crypto` is the engine's and what it refuses stays refused (browser-substrate VO-3806,
     manager's ruling 2026-11-15).
     - **OpenSSL and ncrypto are `libnode.so`'s** (ADR-0016 §1: Node's configuration and each difference, the legacy
       provider built in, every library linked whole), and the OpenSSL half of Node's `src/crypto/crypto_*.cc` and
       `node_constants.cc` is the `node` program's glue, one C++ file per file of Node's (`native/node/crypto_util.cc`,
       `crypto_context.cc`, `crypto_cipher.cc`, `crypto_tls.cc`, `crypto_x509.cc`, `node_constants.cc`), as items 3 to 6
       put each binding's libuv half in the program: a library of the image imports nothing outside `env`, `GOT` and
       `wali` (browser-substrate `dynamic-loader.mjs`), so what calls the engine is the program's. The V8 half is the
       engine's TypeScript over `src/node-lib/binding/openssl.ts` (ADR-0016 §3). The glue, ncrypto and every other C++
       here take the WALI SDK's one C++ runtime, libc++ and libc++abi from browser-substrate's side-module toolchain
       (its ADR-0231 §1); each module links what it uses of it, as a side module does.
     - **The process's OpenSSL** is started once, at the bindings' first use, as Node's start and InitCryptoOnce start
       it (ADR-0016 §2); its randomness, clock, configuration file and modules are the kernel's calls. Its constants
       (`DefineCryptoConstants`) and `process.versions.openssl` (GetOpenSSLVersion) are read from the program. A realm
       the host gives no `node` program has no OpenSSL, as a Node built without it.
     - **Addons through `dlopen`.** `process.dlopen` is Node's DLOpen (`src/node_binding.cc`): the program's `dlopen`
       of the file, musl's, so the loader places the addon in the process's image, its `env` imports bound by name to
       the program's and the libraries' definitions (libuv's `uv_*` and OpenSSL's among them, which an addon reaches
       in Node's executable), and its Node-API (`napi_*`, emnapi's `napi` and `emnapi` modules, browser-substrate
       ADR-0231 §2) the engine's emnapi, as Node's executable defines Node-API over V8. That needs of the host what
       the note below says; until it does, `process.dlopen` is ADR-0011's over `TREE_NATIVE`.
     - **What Node's crypto then takes** (the rest of the item): Node's `lib/crypto.js` and `lib/internal/crypto/*`
       vendored unchanged, over `internalBinding('crypto')` whose methods are the OpenSSL half of Node's
       `crypto_hash.cc`, `crypto_hmac.cc`, `crypto_random.cc`, `crypto_keys.cc`, `crypto_sig.cc`, `crypto_x509.cc`,
       `crypto_cipher.cc`, `crypto_keygen.cc`, `crypto_dh.cc`, `crypto_ec.cc`, `crypto_pbkdf2.cc`, `crypto_scrypt.cc`,
       `crypto_hkdf.cc` and `crypto_util.cc` in the same files of `native/node`, their V8 halves the engine's; each
       asynchronous job (CryptoJob) `uv_queue_work` on libuv's threadpool, its completion an engine import followed
       by a drain, as items 3 to 6's callbacks; `src/shims/crypto*.ts` and their `sha.js`, `@noble` and BigInt RSA go
       with it, in one change.

**For the host** (browser-substrate `linux-node-engine.ts`, `linux-uv-waits.ts`, `linux-system.ts`, the process's
tree, `linux-virtual-filesystem.ts`, and the recipe `programs/node/24.21.0`), items 1 to 7 together:
- *The one hookup.* In its `bootstrap` import, before Node's library runs, the host calls Tabnode's
  `attachLibnode({ exports, read, write })` once: the program's exports, `read(at, length)`, a copy of the process's
  memory, and `write(at, bytes)`, bytes into it (a browser's APIs refuse a view of shared memory). A second call with
  another program throws.
- *The engine's imports* (`host:tabnode`, native/node `engine.h`). The host answers its own: `bootstrap(argc, argv)`
  (starts the run; 0 or a status to exit with), `drain()` (a `Suspending` import: the worker runs its microtasks and
  its other work and the stack resumes from its next task), `process_timers(now)` (`processTimers(now)`: the next
  expiry, positive where a referenced timer holds the loop, negative where none does, 0 for none),
  `process_immediate()` (`processImmediate()`), `poll_ready(fd, status, events)` (a `uv_poll_t` of `poll.c` is
  ready), `loop_idle()` (the loop is about to block: the engine decides its run's end there), `before_exit()`,
  `emit_exit()` and `exit_code()`. It puts Tabnode's `libnodeImports` beside them, one table answering every binding
  callback, each followed in C by `drain` where it made a callback: `handle_closed(handle) -> i32` (HandleWrap::OnClose;
  nonzero where it made the close callback; the C frees the handle after), `stream_read(stream, nread, base)` (`base`
  libuv's buffer, freed when the import returns), `stream_written(id, status)`, `stream_shut(id, status)`,
  `stream_connection(server, status)`, `stream_connected(id, status, readable, writable)`, `udp_received(handle, nread,
  base, name, flags)` (`name` a `tabnode_address_t`, 0 with an error), `udp_sent(id, status)`, `process_exit(handle,
  f64 exit status, signal name's address, its length)`, `fs_done(request)`, `fs_event(handle, filename, events,
  status)` and `stat_watcher_change(handle, status)`; and OpenSSL's callbacks, made inside an export call of the
  engine's and followed by no drain: `tls_handshake(tls, done)`, `tls_keylog(tls, line, length)`,
  `tls_new_session(tls, id, id_length, der, der_length)`, `tls_cert(tls, servername, length, ocsp) -> i32` and
  `tls_alpn(tls, protocols, length) -> i32`. A handle is its address, a stream's or a socket's request its number, an
  fs request its address, a TLS connection its TnSsl's address.
- *The exports the host calls.* `tabnode_exit(status)`, Node's `process.reallyExit`: the run's end exits through it, so
  ResetStdio runs. The tree's system offers `timers`, a `SystemTimers` over `env.c`'s exports: `immediateInfo` a
  `Uint32Array` of 3 at `tabnode_immediate_info()` and `timeoutInfo` an `Int32Array` of 1 at
  `tabnode_timeout_info()` (views of the process's memory, which is shared and so keeps them across its growth),
  `getLibuvNow()` `tabnode_timers_now()`, `scheduleTimer(ms)` `tabnode_schedule_timer(BigInt(ms))`,
  `toggleTimerRef(ref)` and `toggleImmediateRef(ref)` `tabnode_toggle_timer_ref` and `tabnode_toggle_immediate_ref`
  of 1 or 0, and `setupTimers(processImmediate, processTimers)` keeps the two; it has no `wake`, and keeps no
  deadline. Its waits are the descriptors' that are no binding's handle (the engine device's descriptor, DNS,
  signals), each `tabnode_poll_start(fd, events)` and `tabnode_poll_stop(fd)`. Its container is made before any of
  Node's timers load.
- *What the run no longer reads.* A run whose realm has the program reads none of `stdinReader`, `stdioKind`,
  `terminal` or `onStdoutBytes`: its standard streams are libuv's. The engine's own lines (an uncaught exception's
  report) still go to `onStderrBytes`, on a descriptor libuv may have made non-blocking, which answers EAGAIN where
  its pipe is full. `process_wrap` and `spawn_sync` ask no door of the host for a child. The process's tree stops
  serving `fs`: its `watch` (`linux-file-watches.ts`), `holdsLinks`, and of `TREE_DESCRIPTORS` `write`, `fstat`,
  `ftruncate`, `fsync`, `fchmod`, `chown`, `fchown`, `futimes`, `dup`, `advisoryLocks` and `absent` go. It keeps
  what the engine's loader and the bindings not over libuv read: its path calls (`readFileSync`, `statSync` and the
  rest the module loader and `process` use), `chdir` and the cwd, `TREE_SOCKETS` (a listener's port, for the
  machine's forwarding), `TREE_NATIVE`, `TREE_SYSTEM`, and of `TREE_DESCRIPTORS` `open`, `read`, `close`, `reserve`
  and `release` (an executable's header, the engine's descriptor numbers), until item 7.
- *What the kernel and the substrate provide.* The kernel's `clone` with an entry, musl's `clone(fn, stack, flags,
  arg)`, for `CLONE_VM | CLONE_VFORK` with no termination signal (libuv's probe, whose child writes the parent's
  memory) and with `SIGCHLD` (musl's `posix_spawn`): the child runs `fn(arg)` on the given stack in the caller's
  memory, on a worker of its own running only the program's WebAssembly, with its own descriptor table, signal
  handlers and pid, while the caller waits for its exec or its end; `waitpid(pid, …, __WCLONE)` reaps a child with no
  termination signal. Where the probe fails libuv forks, and a Node process has no fork, so every spawn fails.
  SIGCHLD reaches libuv's handler (its loop's child watcher, `uv__wait_children`'s `waitpid`): no part of the host
  blocks it or reads it from a signalfd. `dlsym(RTLD_DEFAULT, "posix_spawn_file_actions_addchdir_np")` answers from
  `libc.so`, or a spawn with a `cwd` forks. inotify in the process's kernel answers `fs.watch`.
  OpenSSL's seeding is `getrandom` (else `/dev/urandom`) and its clock `clock_gettime`; it reads `OPENSSL_CONF`'s
  file or `/etc/ssl/openssl.cnf` where the image has one (a missing file is no error, as in Node), and a provider
  module from `/usr/lib/ossl-modules` only where the configuration or `crypto.setFips` asks for one.
- *The build* (`scripts/build-libnode.sh`): `<native SDK> <side-module toolchain> <libuv a267f5688b archive>
  <node-v24.21.0.tar.gz> <out>`. The side-module toolchain is browser-substrate's (its ADR-0231: `include/c++/v1`,
  `lib/libc++.a`, `lib/libc++abi.a`), so the recipe depends on it beside the native SDK, and Node's release archive
  is an input (OpenSSL, ncrypto, `node_root_certs.h`, `node_constants.cc`). `libnode.so` exports the whole of
  libuv, OpenSSL and ncrypto.
- *Addons through `dlopen`* (item 7): the program's `dlopen` of a `.node` reaches the loader, which refuses a
  library's import outside `env`, `GOT` and `wali` and binds `env` by name in the program and the libraries. An addon
  the side-module toolchain builds imports emnapi's `napi` and `emnapi` modules and Node-API's `env` functions, which
  are the engine's (emnapi's JavaScript, one module per load, `createNapiModule`). So the host provides: the loader
  answers those imports, at that `dlopen`, from the engine (which registers, for the process's worker, what a load
  of a path imports); the loader hands the engine the addon's instance once its constructors have run, so emnapi's
  `init` calls `napi_register_wasm_v1` over it; and `attachLibnode` gives the engine the process's
  `WebAssembly.Memory` and function table, which emnapi's views and dynamic calls read in place. `TREE_NATIVE` and
  `linux-tree-native.ts` then go.

## Consequences

- The engine's account of its own handles (the run's end "by Tabnode's own count of its handles") is libuv's:
  `uv_run` returns when no active, referenced handle or request remains.
- A failure in the loop is libuv's or the kernel's, read in their sources, never re-encoded in a binding.
