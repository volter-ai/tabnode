# ADR-0011: A native addon is a WALI module of Node-API, loaded over the realm's kernel process

Status: Accepted

Date: 2026-11-06. Served: browser-substrate ADR-0218 §1, layer 4: "a native addon is its WebAssembly variant pack".
The first consumer is Conduit's terminal in a tab, which needs node-pty's own C, built for WALI and loaded by Tabnode.

## Context

### What Node does (read in Node v24.21.0's `src/node_binding.cc`, `src/node_api.cc`, `lib/internal/modules/cjs/loader.js`, `doc/api/n-api.md`, and `node_api.h` as installed)

- **`require` of a `.node` is `process.dlopen(module, filename)`.** The loader's `.node` extension is
  `process.dlopen(module, path.toNamespacedPath(filename))` (`loader.js:2085-2088`), read off the process at the call,
  so a program's wrapper of `process.dlopen` is what loads; the module is in `require`'s cache before it loads, so a
  second `require` of the file is the first one's module. `DLOpen` (`node_binding.cc:445-522`) takes the target's
  `exports` (`ToObject` of `module.exports`, 472-475), opens the file with the dynamic linker, and fails
  `ERR_DLOPEN_FAILED` with the linker's own message (`dlerror()`, for example `<path>: invalid ELF header`); it then looks
  for a Node-API initializer (`GetNapiInitializerCallback`, 516-522): found, it calls it with a new environment and that
  target's `exports`; absent, and with no legacy registration, it fails `ERR_DLOPEN_FAILED` "Module did not
  self-register: '<path>'." Every `process.dlopen` of a file already open initializes its own target again, with a
  new environment, over the one library.
- **The initializer's environment** (`node_api.cc:757-805`): one `napi_env` per initialization, named by the target's
  `module.filename` as a file URL. An initializer that returns a value other than the `exports` it was given sets the
  target's `module.exports` to it. A module asking a Node-API version above the line's (10 on v24) fails before its
  initializer runs, `<file URL> requires Node-API version <n>, but this version of Node.js only supports version 10
  add-ons.` (`node_api.cc:26-53`). Each environment's teardown is a cleanup hook of the process's environment
  (`node_api.cc:64`), which runs the addon's own cleanup hooks (`napi_add_env_cleanup_hook`) when the process ends.
- **Node-API has a WebAssembly ABI in Node's own header.** Under `__wasm__`, every `napi_*` function is an import of
  the module `napi` (`NAPI_EXTERN` is `__attribute__((__import_module__("napi")))` in `js_native_api.h` and
  `node_api.h`), and the initializer is the export `napi_register_wasm_v1` (`NAPI_MODULE_INITIALIZER_BASE
  napi_register_wasm_v`), beside `node_api_module_get_api_version_v1`, the module's Node-API version. The lines are
  the same in the installed header (Node v26.12.0) and in v24.21.0's. `napi_env`, `napi_value`, `napi_ref`,
  `napi_handle_scope`, `napi_deferred` and the rest are opaque pointers: 32-bit values in wasm32.
- **Threads.** Node-API's rule (`n-api.md`, "Asynchronous thread-safe function calls"): a function taking a `napi_env`,
  `napi_value` or `napi_ref` may be called only from the addon's main thread; another thread reaches JavaScript only
  through a thread-safe function (`napi_create_threadsafe_function`, whose `napi_call_threadsafe_function`,
  `napi_acquire_threadsafe_function` and `napi_release_threadsafe_function` "may be called from any thread"). Async
  work (`napi_create_async_work`, `napi_queue_async_work`) runs its `execute` on libuv's threadpool and its `complete`
  on the main thread. `napi_get_uv_event_loop` hands out the loop, with the warning that libuv's own ABI is not
  Node-API's.
- **node-pty's use** (read in microsoft/node-pty `src/unix/pty.cc`): node-addon-api over Node-API; `forkpty(3)` then,
  in the child, `chdir`, the credentials and `execvp`; a `std::thread` per child that `waitpid`s and reports the exit
  through a `Napi::ThreadSafeFunction` `BlockingCall`. It calls no `uv_*` function.

### What the engine does

A `.node` is refused: `require` throws `ERR_DLOPEN_FAILED` "a tab runs no native code" (`src/runtime.ts`, the
`.node` extension handler and `createRequire`'s `.node` branch), unless the run's binding map (browser-substrate
ADR-0094, `Module.__substrateSetAddons`) or a host's stand-in answers the path with a JavaScript export, and
`process.dlopen` is that same `require`.

### What the substrate holds (browser-substrate at 7cd0f130e3d)

- **The kernel's memory is the kernel's alone.** `kernel.wasm` is wasm32 C whose one memory is the kernel memory; it
  cannot reach a process's memory, which a copy module bridges, importing both memories (ADR-0227 §2). An instance of
  the kernel with no image, as a Node realm's is, has no user memory: its JavaScript callers pass their bytes in the
  kernel memory's scratch (`ks_` calls, ADR-0227 §6). A module that exports or is given its own memory "is the user
  memory of an unshared form of the copy module, set once it is instantiated" (§5.12).
- **A memory costs a region.** Chrome reserves a fixed region for every WebAssembly memory (about 8 GiB for wasm32,
  16 GiB for memory64), about 124 to a tab, and a dropped one's region returns only when every realm that saw it has
  collected it. So a worker makes one process memory and keeps it for its life, and every process it runs runs in it
  (ADR-0227 §6, `packages/wali/src/worker-memory.ts`).
- **A WALI program may be position-independent** (ADR-0132): linked `wasm-ld --experimental-pic`, with a `dylink.0`
  section, it imports `env.memory`, `env.__memory_base`, `env.__table_base`, `env.__stack_pointer` and
  `env.__indirect_function_table`, and several instances share one memory at their own bases.
- **A module's ABI is tagged** (ADR-0138): a `wali.abi` custom section names the profile, and a module loaded into an
  address space must have that space's profile.
- **A thread runs in its process's memory**, from a worker of its own posted that memory (ADR-0227 §6).
- **A fork from a host image is a vfork**: the child's calls until its `execve` or `_exit` run in the parent's
  instance under the child's task, limited to what a child makes before its exec (setsid, setpgid, the controlling
  terminal's ioctls, dup2, close, chdir, its signal state); "node-pty's `forkpty` in a Node realm is this fork"
  (ADR-0227 §5.12).

## Decision

### 1. The entry points, and what each does

Two entry points load an addon, and they are Node's (§Context):
1. **`require` of a path ending `.node`.** Resolution is `require`'s, with the run's binding map (browser-substrate
   ADR-0094: a bound path is its provider, a path under a refusal root or bound by no map is refused by the most
   recent map) and the host's stand-ins (a package the holder answers in JavaScript, `__browserRuntimeNativeStandIns`)
   applied there, as today. A path it answers with JavaScript is that module. Otherwise the module is made, put in
   `require`'s cache, and loaded by the `.node` extension, which is `process.dlopen(module, filename)` of the run's
   process, read at the call. A second `require` of the path is the cached module; a failed load leaves no cache
   entry, as every failed load does.
2. **`process.dlopen(module, filename[, flags])`.** Node's own checks first: fewer than two arguments
   `ERR_MISSING_ARGS` "process.dlopen needs at least 2 arguments", flags that are no integer `ERR_INVALID_ARG_TYPE`,
   `module` no object and `module.exports` not convertible to one each a `TypeError`. The path is taken against the
   process's working directory. A host stand-in's package is answered as `require` answers it: its module's exports
   are the target's `exports`. Every other path is opened (§2), and its initializer is called with a new environment
   on this target's `module.exports` (§4), however many times the file was opened before; it sets `module.exports`
   where it returns another value. A missing file is `<path>: cannot open shared object file: No such file or
   directory`. The flags name dynamic-linker modes and have nothing to act on.
   The binding map does not apply here: the substrate's prelude wraps `process.dlopen` with it (a bound path gets its
   provider's exports, a refused one its refusal, any other the engine's `dlopen`), and the `.node` extension reaching
   `process.dlopen` is what makes that wrapper apply to `require` too.

Nothing in the loader names a package; a variant is recognised by its own bytes.

### 2. Opening a file: validated before anything trusts its structure

A `.node` is untrusted bytes. Before any part of it is trusted, the loader makes these reads, in this order, each
bounded by the file, and the first that fails is the load's `ERR_DLOPEN_FAILED`:
1. **The magic.** Fewer than eight bytes, or a first word that is not `\0asm`: `<path>: invalid ELF header`,
   `dlerror()`'s message for a file that is no shared object on Linux, which the engine presents itself as.
2. **The whole module, by the engine's own WebAssembly compiler** (`new WebAssembly.Module(bytes)`). It checks the
   version, every section's length against the file, every LEB's width, every vector's count against its section,
   every name's length and UTF-8, every limit and every function body, and allocates nothing a count asks before its
   bytes are there. A file it refuses: `<path>: <the compiler's message>`, the linker's own refusal.
3. **Its interface, from the compiled module and nothing else**: `WebAssembly.Module.exports` (an export
   `napi_register_wasm_v1`, else "Module did not self-register: '<path>'."), `WebAssembly.Module.customSections(...,
   'dylink.0')` (none: `<path>: cannot dynamically load executable`, glibc's refusal of an executable, since a module
   linked at fixed addresses has no place in a memory beside another's), and `WebAssembly.Module.imports` (step 5).
4. **The tree** (§7): one that offers no `TREE_NATIVE`: `<path>: a tab runs no native code`.
5. **The imports** (§4): an import the loader does not answer (a `uv_*` symbol, a `napi_*` or `emnapi_*` emnapi lacks)
   is `<path>: undefined symbol: <name>`, as the linker answers an unresolved symbol.
6. **The substrate's load** (§7): its `{ error }` (an ABI other than the process's, `wali.abi`, ADR-0138; an import
   nothing answers) as the linker's own message.
The loader parses no byte itself. The substrate's linker compiles the bytes it is handed again (its own reads and
admission, `dynamic-link.ts`); one file is compiled twice, once by each.

A file opened once in a process stays open for the process's life, as `dlopen` keeps a library loaded: a later open of
the same path is the same instance, and only its initializer runs again (§1).

### 3. Memory: one per process, shared by its addons, never the kernel's

- **Not the kernel memory.** It is the kernel's state (§2 of ADR-0227); a module that wrote it would write the
  kernel's structures, and its pointers would be the kernel's addresses. So an addon has a memory of its own.
- **One memory per process, made at its first addon, kept for its worker's life.** The realm's worker makes one shared
  wasm32 memory (`shared: true`, the process profile's maximum) the first time its process loads an addon, by
  `worker-memory.ts`'s rule, and every later addon of that process is loaded into it. It costs one of the tab's ~124
  regions for each Node process that loads any addon, not one per addon, and a realm that loads none costs nothing.
- **Each addon is a position-independent module** (ADR-0132's convention, `-fPIC`, `wasm-ld --experimental-pic
  -shared`, its own static musl and C++ runtime, linked by browser-substrate ADR-0231's `bin/link-side-module`), placed
  by the substrate's own dynamic linker (`packages/wali/src/dynamic-link.ts`, `WaliDynamicLinker`), which reads
  `dylink.0`, takes the module's memory and stack from the process's address space (one address allocator, so two
  addons and the C heaps stay disjoint), gives it its table slots, checks its ABI (ADR-0138), and runs
  `__wasm_apply_data_relocs` and `__wasm_call_ctors`, and which re-instantiates a loaded module in each thread's
  worker. The engine places nothing itself; it hands the linker the module's Node-API imports (§4) and calls
  `napi_register_wasm_v1` on the instance the linker returns.
- **That memory is the process's user memory.** The realm's instance of the kernel is bound to it (the copy module's
  user memory), so an addon's system calls copy in and out of it as a WALI program's do. The realm's own `ks_` calls
  keep using the kernel scratch.

### 4. Node-API is emnapi's runtime, and the boundary where its bytes meet JavaScript's

The substrate implements Node-API for addons through emnapi (ADR-0151's producer; decisions fdd3a53d5), so the loader
takes emnapi's runtime, `@emnapi/core` and `@emnapi/runtime` at 1.11.3 (the version ADR-0231 builds `emnapi-mt`
from), as its Node-API: the `napi` and `emnapi` imports are those `createNapiModule` makes, and no second Node-API is
written in the engine. A variant is built with emnapi's `include/node` headers and its threaded library `emnapi-mt`,
and linked by ADR-0231's side-module link, which exports `napi_register_wasm_v1`, `node_api_module_get_api_version_v1`,
`malloc` and `free`. The engine calls `napiModule.init` with the instance, memory and table, which makes the
environment, checks the module's Node-API version exactly as Node's `node_napi_env__::New` does (its supported maximum
is 10, v24.21.0's), and calls the initializer.

emnapi's runtime answers handles, strings in the addon's memory, errors and finalizers, and Tabnode adds nothing to
them. Each rule below names its source: Node's own (`doc/api/n-api.md`, `src/node_api.cc`, `src/node_binding.cc` at
v24.21.0) or the pinned emnapi's own behaviour, read in its 1.11.3 sources (`@emnapi/core` `dist/emnapi-core.js`,
`@emnapi/runtime` `dist/emnapi.js`, `emnapi`'s `include/node/emnapi.h` and C).

**The memory boundary is emnapi's.**
- *Node:* `napi_get_buffer_info` answers "the underlying data buffer of the `node::Buffer`" (`n-api.md:3443`, 3453),
  and the other data-pointer answers the same of theirs: an addon's pointer is the buffer's own bytes.
- *emnapi, at the pin:* a buffer whose bytes are JavaScript's (an `ArrayBuffer`, a `SharedArrayBuffer`, a view or
  `Buffer` over one) is not in the addon's memory. Its data pointer is a copy emnapi keeps there, `malloc`'d at the
  first ask and refreshed from the JavaScript bytes at every ask (`getArrayBufferPointer`, `emnapi-core.js:3737-3777`;
  `getViewPointer`, 3827-3838), and the creating calls that answer a data pointer make the same kind of copy
  (`napi_create_arraybuffer`, `node_api_create_sharedarraybuffer`, `napi_create_buffer_copy`, and the external ones,
  `napi_create_external_arraybuffer`, 6378-6446, and `node_api_create_external_sharedarraybuffer`, 6450-6500, which copy
  the addon's bytes into a new JavaScript buffer). emnapi's call wrapper never writes the copy back
  (`emnapiCreateFunction`, 5285-5311). Bytes cross between a copy and JavaScript by emnapi's own calls,
  `emnapi_sync_memory` and `emnapi_get_memory_address` (`emnapi.h:72-83`; `emnapi-core.js:5944-5969`, 6005), which an
  addon built against emnapi's headers (every variant, ADR-0231) calls where it hands bytes back. A `Buffer` the
  addon makes with a data pointer or over its own bytes (`napi_create_buffer`, 6712-6771; `napi_create_external_buffer`
  and `emnapi_create_memory_view`, 5753-5865) is a view of the addon's memory, and both sides see every write.
- *So:* Tabnode adds no copy, lending or write-back of its own. The difference from Node is emnapi's, and a variant
  meets it as emnapi requires.

**The `Buffer` is the process's.**
- *Node:* `napi_create_buffer` "allocates a `node::Buffer`" (`n-api.md:2403`): the process's own class, so the
  guest's `Buffer.isBuffer` is true of it.
- *emnapi:* every buffer it makes is made with its context's `feature.Buffer`, which `@emnapi/runtime` takes from the
  `Buffer` it sees when it is evaluated (`emnapi.js:195-203`).
- *So:* the process's own `@emnapi/runtime` (§6) sees the process's `Buffer`, the one its guest's global and
  `require('buffer')` answer.

**Threads are the kernel's tasks, not emnapi's workers** (a departure). emnapi's clang path makes a thread by WASI's
`thread-spawn` and a worker its `onCreateWorker` makes, and wakes the main thread by that worker's messages. A WALI
module's `pthread_create` is WALI's `clone`, answered by a kernel task in a worker the substrate starts (ADR-0227 §6),
so `thread-spawn` is not offered. The thread side of the imports is emnapi's own child-thread module
(`createNapiModule({ childThread: true, postMessage })`) in that worker, whose one message to the main thread is
`uv_async_send`'s (`_emnapi_async_send_js`, which `emnapi-mt`'s async work and thread-safe functions are built on, its
payload a callback and its data, 1488-1499): `postMessage` writes it to the load's queue (§5) and the main side calls
the callback through the module's table, as emnapi's own send listener does (1236-1239). Every `napi` and `emnapi`
import on the thread side aborts, `napi_fatal_error`'s answer to a call Node-API forbids off the main thread.

**One memory per process needs position-independent variants** (§3). emnapi's documented clang link is a reactor at
fixed addresses, so two such variants in one memory would overlap; a variant is loaded only where it is linked
position-independent (ADR-0231: `emnapi-mt`, musl and the C++ runtime built PIC).

### 5. Threads, the loop and libuv

- **An addon's threads are its process's tasks.** `pthread_create` is WALI's `clone`, answered by the kernel's task
  creation and a worker of the process posted its memory (ADR-0227 §6), in which the dynamic linker instantiates the
  same module at the same bases with the thread side of the imports (§4), which that worker makes by importing
  `@volter/tabnode/native-thread` and calling its `threadImports(queue)` with the load's queue.
- **The queue** (`native-queue.ts`) is one per opened file, a `SharedArrayBuffer` of 32-bit words: its read and write
  counters, the writers' lock, its stop word, then 1024 slots of two words, `uv_async_send`'s callback (a table index)
  and data (a pointer). A thread writes a slot under the lock, advances the write counter and `Atomics.notify`s it;
  a thread that finds the queue full waits on the read counter (`Atomics.wait`; a worker may block). The main side
  waits with `Atomics.waitAsync` (no timer) and calls each slot's callback (§6). The counters wrap modulo 2³²: the
  fill is their difference as a signed 32-bit number (never more than 1024) and a slot is a counter's low ten bits, so
  every count of sends is the same arithmetic.
- **The thread side of Node-API** is what Node-API allows off the main thread: `napi_call_threadsafe_function`,
  `napi_acquire_threadsafe_function` and `napi_release_threadsafe_function`, which `emnapi-mt` implements in C (a queue
  under a pthread mutex, `uv_async_send` to the main thread). Any other `napi_*` call from a thread aborts the process.
- **Async work** (`napi_create_async_work`, `napi_queue_async_work`) runs `execute` on `emnapi-mt`'s pool of the
  process's threads and `complete` on the realm's loop through the same queue; queued work holds the loop until its
  `complete` has run, and `napi_cancel_async_work` removes work not yet started.
- **The loop is held** while `emnapi-mt` asks it (a live thread-safe function, queued work), by emnapi's
  waiting-request counter on a port of the process (§6).
- **libuv itself is not offered.** `napi_get_uv_event_loop` answers a non-NULL token that names the realm's loop and
  is valid only as an argument; a module that imports a `uv_*` function is refused at its load (§2), since libuv's ABI
  is not Node-API's and the engine has no libuv.
- **A child is the kernel's spawn** (browser-substrate ADR-0231 §5): the variant's `forkpty` is `posix_spawn` through
  `wali.SYS_posix_spawn_v1`, and fork and vfork answer ENOSYS; the engine adds nothing.

### 6. One process owns its addons' runtime

Each rule names its source, as §4's do.

- **Whose runtime it is.**
  - *Node:* an addon's `napi_env` belongs to the environment of the process that loaded it (`node_api.cc:757-790`,
    `Environment::GetCurrent`), whose exit tears it down (64); its callbacks run on that process's loop, and an
    exception one throws is that process's uncaught exception.
  - *emnapi:* `@emnapi/runtime` takes its host from what it sees when it is evaluated: `process` (a context's
    `beforeExit` subscription and its waiting-request counter, 1358-1364; uncaught exceptions and warnings,
    `NodeEnv.triggerFatalException` and `callbackIntoModule`, 743-784), `setImmediate` (`_setImmediate`, 176-194,
    which runs `_emnapi_set_immediate`, every `uv_close` completion and the finalizer queue, `enqueueFinalizer`,
    800-818), `MessageChannel` (167-175, the waiting-request counter's port and `_setImmediate`'s fallback), `Buffer`
    (195-203) and `globalThis` (`_global`, 74, `napi_get_global`'s answer). One evaluation shared by every process
    of a realm would give all of them whichever process was ambient.
  - *So:* `@emnapi/runtime` is evaluated once per process, by the path a process's builtins take
    (`node-lib/load.ts`, `loadDependencyFor`), its `process`, `require`, `globalThis`, `MessageChannel` and `Buffer`
    that process's own, and its `setImmediate` the process's addon runtime's native immediates (below, "A process's end").
    Its context therefore subscribes to the loading process's own `beforeExit`; its waiting requests ref a port of
    that process (`guest-message-ports.ts`), which holds that process's loop while a thread-safe function or queued
    work is live, so emnapi-mt's `runtime_keepalive` imports keep emnapi's empty answers; its immediates, finalizers
    and `uv_close` completions are scheduled as that process's own immediates (`guest-timers.ts`) while it lives:
    counted in its loop, and a throw from one is its uncaught exception; its warnings and fatal exceptions go to its
    process.
  - *What a per-process evaluation does not redirect:* `@emnapi/core` stays one per realm (it requires
    `@emnapi/wasi-threads`, and holds nothing of a process but the context it is given). It reads `process.versions.node`
    when a module is made (`emnapi-core.js:1068`, `_emnapi_get_node_version`, 1293), the engine's one Node line for
    every process; and its `_emnapi_next_tick` (1331-1336) is a microtask of the frame that scheduled it, which is a
    call already running as the process. The thread queue's receiver (§5) is Tabnode's, in place of emnapi's worker
    listener (1236-1239): it calls each callback in the loading process's run (`ownedRun`), its throw that run's
    uncaught exception.
- **One runtime per process, for the process's whole life.**
  - *Node:* an environment's native immediates, cleanup queue and request counts are its own, made with it and ended
    only by `FreeEnvironment` (`api/environment.cc:518-537`); a `dlopen` that fails returns its error and leaves the
    environment as it was (`node_binding.cc:445-522`). Once `FreeEnvironment` begins, no JavaScript runs in it
    (`DisallowJavascriptExecutionScope`, 520-521).
  - *emnapi:* the process's evaluation of `@emnapi/runtime` is kept with the process (`node-lib/load.ts`,
    `NodeLibScope.surface`) and captures the `setImmediate` it was given at that evaluation (`emnapi.js:176-178`,
    `feature.setImmediate`, 1352), so whatever it captured must live as long as the process does.
  - *So:* the process's addon runtime (`ProcessAddons`: its emnapi evaluation, its context, its native immediates and
    its waiting native requests) is made at the process's first `dlopen` that reaches the linker and is ended only by
    the process's end. A refused or throwing open (an unresolved import, the linker's refusal, a throwing initializer)
    leaves it as it was, with every environment it made. A `dlopen` once the end has begun is refused
    (`ERR_DLOPEN_FAILED`, "the process is exiting"), since no JavaScript runs once Node's environment is being freed.
- **One context per process.** The runtime's context is emnapi's `Context`, made once with the runtime. *emnapi:* a
  context holds its environments and their cleanup queue, `newEnv` adds each environment's release to it
  (`emnapi.js:821-834`), and `destroy` stops every call into JavaScript and runs that queue (1478-1482); it destroys
  itself at its process's `beforeExit` (1358-1364). Its public doors carry what the end needs (below, "A process's
  end"): `addCleanupHook` and `removeCleanupHook`, which every environment's and addon's cleanup hook goes through, and
  `increaseWaitingRequestCounter` and `decreaseWaitingRequestCounter`, which `emnapi-mt` calls for every native request.
  A cleanup hook's registration is its (env, fn, arg), as Node's `CleanupQueue` keys one (`cleanup_queue.cc`): adding
  a live one again is refused by emnapi's own queue ("Can not add same fn and arg twice"); a removed one is skipped,
  and one added again after its removal is a new registration. emnapi's `CleanupQueue.drain` snapshots its hooks and,
  after each, splices the entry it finds by `indexOf` (`emnapi.js:1289-1302`), so a hook removed while the queue drains
  stays in emnapi's queue, skipped, until the drain takes it; removed at once, the drain's `indexOf` would answer -1 and
  splice another hook.
- **One environment per initialization.**
  - *Node:* each `process.dlopen` makes a new `napi_env` for the initializer it calls (`node_api.cc:790`), so an
    initializer that loads another addon makes a second environment, and a later `dlopen` of the same file makes a
    third over the one library (`node_binding.cc:445-522`).
  - *emnapi:* a `napiModule`'s `init` makes one environment in its context and calls the initializer
    (`emnapi-core.js:1096-1152`), and only once.
  - *So:* each initialization is one emnapi module's `init` over the file's one instance, in the process's context:
    the first is the module whose imports the instance was made with, each later one a `createNapiModule` of its own.
- **A failed initialization keeps its environment until the process ends.**
  - *Node:* `napi_module_register_by_symbol` keeps the environment it made whatever the initializer does
    (`node_api.cc:790-805`), and a referenced thread-safe function it made "will cause the event loop ... to remain
    alive until the thread-safe function is destroyed" (`n-api.md:6692-6694`).
  - *emnapi:* `init` throws with the environment it made (1131) still in its context, before `loaded` (1150).
  - *So:* the loader tears nothing down; the error is the load's.
- **A process's end.**
  - *Purpose:* however a process ends, its ordinary work stops at once, and its native teardown runs to completion as
    Node's does: until no cleanup hook remains, no native immediate is queued and no native request is waiting. Only
    then has the process ended, and only then is its exit reported.
  - *Callers, by grep* (`__endOwnedProcess`): the run's `finally` (`shims/child_process.ts`, `launchNode`), which a
    return from the entry, a throwing entry, a `process.exit` that unwinds and a caller's abort all reach;
    `process.exit()` itself; a kill of a child the realm runs (its `kill`); a kill of a shell job
    (`shims/shell-jobs.ts`); and the host's `stopProcess` (`index.ts`). A process may be ended twice
    (`process.exit`, then the `finally`).
  - *Node v24.21.0:* a Tabnode process shares its realm with others, as a worker shares its living OS process, so
    Node's worker is the reference, not the main thread's `exit()`, which leaves release to the OS
    (`api/environment.cc:1162-1184`, `node_process_methods.cc:502-511`). Every end of a worker, its loop draining,
    `process.exit` (its exit handler, `node_worker.cc:391`, to `Worker::Exit` and `Stop`, 1325-1346) or `terminate()`,
    leaves `Worker::Run`'s scope, whose environment's deleter is `FreeEnvironment` (298-330), and the worker's exit is
    reported after it. `FreeEnvironment` (`api/environment.cc:518-537`) disallows JavaScript, clears
    `can_call_into_js`, sets `stopping`, then runs `RunCleanup` (`env.cc:1349-1377`):
    - it closes the JavaScript timer and immediate handles (`ClosePerEnvHandles`), so ordinary JavaScript work never
      runs again;
    - `CleanupHandles` (1279-1301) runs the native immediates, cancels requests, closes handles, and turns the loop
      (`uv_run(UV_RUN_ONCE)`) while a request is waiting or a close is outstanding, so it waits for native work in
      flight to complete;
    - while the cleanup queue, the realm's pending cleanup or native immediates remain, it drains the cleanup queue
      and runs `CleanupHandles` again. `CleanupQueue::Drain` (`cleanup_queue.cc:27-40`) runs every hook in its order,
      skipping one removed meanwhile.
    - An async cleanup hook "should initiate the asynchronous cleanup actions at the end of which `handle` must be
      passed in a call to `napi_remove_async_cleanup_hook`" (`n-api.md:1017-1034`, 794-796, 1996-2004): the end is
      when its chain completes, not when the hook returns.
  - *emnapi at the pin:*
    - its native releases are deferred through `_emnapi_set_immediate`: `uv_close`'s completion
      (`uv/unix/core.c:29-47`), which runs a thread-safe function's finalize and destroy (`threadsafe_function.c:86-123`,
      170-264); an async-cleanup environment unref (`async_cleanup_hook.c:85-98`); and the finalizer queue
      (`emnapi.js:800-818`);
    - its waiting native requests are counted through the context's `increaseWaitingRequestCounter` and
      `decreaseWaitingRequestCounter`: queued async work until its `complete` (`async_work.c:118-125`), a referenced
      thread-safe function (`threadsafe_function.c:99-100, 146-147, 604-605, 619-620`), and a started async cleanup
      hook until its chain's done callback (`async_cleanup_hook.c:34-46`). Work in flight completes from the
      process's threads by `uv_async_send` (`uv/unix/async.c:176-178`) through the load's queue (§5);
    - `CleanupQueue.drain` (`emnapi.js:1289-1302`) stops at a hook that throws and leaves it queued, so the hooks
      after it do not run.
  - *Interface:*
    - **One door.** `__endOwnedProcess(token)` (`node-lib/binding/handles.ts`) is every caller's. Synchronously, it
      releases the process's servers and then every owned handle, and cancels its ordinary guest work (its timers,
      immediates and ports: `__stopOwnedProcess`, `stopGuestTimers`). It answers the end's completion, a promise
      that settles when every owned handle whose release outlives its close (`OwnedHandle.released`) has finished. A
      repeated end answers the same completion.
    - **The addon runtime's close** starts its native teardown, and its `released` settles when the teardown is done:
      1. its context is destroyed: stopping, no call into JavaScript, its cleanup queue drained;
      2. then, turn after turn, as `RunCleanup` repeats `CleanupHandles`:
         - every native immediate runs, those queued and those they queue;
         - the cleanup queue runs again, for hooks added meanwhile;
         - each thread queue keeps delivering its sends as they arrive;
         - while a native immediate is queued (one the cleanup queue's run queued among them) it goes again at
           once, as `RunCleanup` repeats `CleanupHandles` while native immediates remain; while only a native
           request is waiting it waits for the next native event (an immediate queued, a send delivered, a request
           completing), as `CleanupHandles` turns the loop; with neither, it is done;
      3. then its thread queues are stopped and the runtime is released.
    - **The end is asynchronous.** `CleanupHandles` blocks its thread in `uv_run`, but a Tabnode process shares its
      realm's thread, and its native completions arrive as that thread's events (`Atomics.waitAsync`, §5). So the
      native part of an end completes on later turns, and each caller that reports the process's exit does so at
      completion:
      - the run's `finally` awaits it before it releases the rest of what the run holds;
      - a child's and a shell job's kill report their exit when it settles;
      - the host's `stopProcess` answers at once, since it reports only whether the run was known.
  - *Failures:*
    - **A cleanup call's throw.** Every cleanup hook goes through the context's `addCleanupHook`, which wraps it so
      that it runs in the process's run (`ownedRun`) and counts as run whatever it does, so the remaining hooks still
      run, as `CleanupQueue::Drain` runs every hook; native immediates and deliveries of the teardown are run the same
      way. While the process lives (emnapi's own `beforeExit` destroy, above), a throw is the process's uncaught
      exception. Once its end has begun the process has exited: Node runs `RunCleanup` under
      `DisallowJavascriptExecutionScope`, where nothing of the program reports anything, so a throw is not offered to
      the run's uncaught report and is the end's failure instead.
    - **The end's failures** (those, a throw the run did not take while it lived, and a handle's close that throws)
      reject the end's completion after every remaining step has run. The run's `finally` awaits it, releases the rest
      of what the run holds, and rejects the run with it, so a run whose teardown failed never reports a clean result.
      Unawaited (a kill's report, a host's stop), the rejection reaches the realm as an unhandled rejection.
  - *Every end:*
    - **A normal return.** The loop drains only once no native request waits (their port holds it, §5), emnapi's
      `beforeExit` destroys the context, and the `finally`'s end completes the teardown.
    - **`process.exit`.** Its end, then the `finally`'s, share one completion.
    - **A throwing entry or a caller's abort** reaches the `finally`.
    - **A child's or a shell job's kill** ends the process and reports its exit at completion.
    - **The host's stop** ends it at once, the run's `finally` awaiting the same completion.
    - **A refused first open** leaves the runtime as it was.
    - **A failed initialization's environment** is torn down with the rest at step 1.
  - *Invariants:*
    - After completion the process holds no handle, timer, port, native immediate or waiting native request.
    - Every deferred release emnapi scheduled before or during the end has run, and nothing runs on its account
      afterwards.
    - A second end answers the first's completion.
    - A Runtime made outside any run has no end the engine sees, and its addons live as long as it does, as its other
      handles do.
- **The loading process's tree loads the file.**
  - *Node:* `DLOpen` loads into the calling environment (`node_binding.cc:446`).
  - *So:* the tree's `TREE_NATIVE` is chosen, and its `load` called, inside the loading process's resource scope
    (`withNodeResourceScope`), so `callingTree` answers that process's tree whatever is ambient.

### 7. What the substrate supplies

Under a tree capability beside `TREE_SOCKETS` (`TREE_NATIVE`, `src/host-native.ts`), one call:
- `load({ path, bytes, imports, thread })`: the module loaded into the process's user memory (made at the first load
  by `worker-memory.ts`'s rule and kept, the realm's kernel instance bound to it as its user memory) by the substrate's
  dynamic linker, with the process's `wali` imports bound to the calling task and the engine's `imports` (`env`,
  `napi`, `emnapi`) beside them; `thread` names the module a thread's worker imports for its side of those imports
  (`@volter/tabnode/native-thread`) and the `SharedArrayBuffer` it is called with. It answers `{ instance, module,
  memory, table }`, or `{ error }` with the dynamic linker's own message, which the engine throws as
  `ERR_DLOPEN_FAILED`.

## Where the evidence stops

- **Read:** Node v24.21.0's `src/node_binding.cc` (sha256 b1d9a6e2…, `DLOpen`, its `ERR_DLOPEN_FAILED` messages),
  `src/node_api.cc` (`node_napi_env__::New`, `napi_module_register_by_symbol`), `lib/internal/modules/cjs/loader.js`
  (the `.node` extension), `doc/api/n-api.md` (thread rules, async work, thread-safe functions,
  `napi_get_uv_event_loop`), `node_api.h` and `js_native_api.h` (installed, v26.12.0, the wasm lines equal to
  v24.21.0's); emnapi 1.11.3 as published, `@emnapi/core` (sha256 2f902aa1…, `dist/emnapi-core.js`), `@emnapi/runtime`
  (e6eb8913…, `dist/emnapi.js`: `Context`, `Env`, `NodeEnv`, `newEnv`, `CleanupQueue`, `getDefaultContext`) and
  `emnapi`'s C (e7f4fd97…, the archive ADR-0231 builds from: `src/threadsafe_function.c`, `src/async_work.c`,
  `src/async_cleanup_hook.c`, `src/uv/unix/async.c`, `src/uv/unix/core.c`); node-pty's `src/unix/pty.cc`; browser-substrate ADR-0227 §2, §5.12 and
  §6, ADR-0132, ADR-0138, ADR-0218 §1, ADR-0231 and `worker-memory.ts`; the substrate's native-binding prelude
  (`packages/node/src/native-binding-hook.ts`, its `process.dlopen` wrapper); Tabnode's `runtime.ts` addon paths and
  `node-lib/binding/handles.ts` with every caller of `__endOwnedProcess`; Node v24.21.0's `src/cleanup_queue.cc`,
  `src/env.cc` (`CleanupHandles`, `RunCleanup`) and `src/api/environment.cc` (`FreeEnvironment`).
- **The toolchain** is browser-substrate ADR-0231's (`toolchains/wali/side-module/`): libc++, libc++abi and libunwind
  built position-independent with Wasm exceptions and threads, `emnapi-mt` built position-independent for
  `wasm32-linux-muslwali`, and `bin/link-side-module`, which links and records a `-shared` side module.
- **Extrapolation:** that one memory per addon-loading process keeps the tab's region count where it is, since the
  substrate's terminal processes are few; that compiling a file twice (§2) costs little beside its instantiation for an
  addon of node-pty's size; and that emnapi's copy boundary (§4) costs a pty nothing, since its bytes move through
  descriptors, not buffers an addon is handed; and that the waiting-request doors count every native request
  `emnapi-mt` has in flight (read for async work, thread-safe functions and async cleanup hooks, not for every C
  path), so that none waiting means none in flight. An unreferenced thread-safe function is not counted, as Node's
  unreferenced handle is not, and its later sends are delivered only while the teardown is still turning.
- **Coded, not run.** `src/native-addon.ts`, `src/native-queue.ts`, `src/native-thread.ts`, `src/host-native.ts` and
  `runtime.ts`'s two entry points are §1-§7. No substrate on its main offers `TREE_NATIVE` yet (its `load`, over
  `WaliDynamicLinker`, is the kernel lane's), so every `.node` that is a WALI Node-API module fails `<path>: a tab runs
  no native code` until one does.
