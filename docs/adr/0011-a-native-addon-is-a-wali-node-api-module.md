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
- *emnapi:* every buffer it makes is made with its context's `feature.Buffer` (`emnapi.js`, the `Context`
  constructor's `feature`; `emnapi-core.js:6712-6771`).
- *So:* the process's context (§6) has as `feature.Buffer` the `Buffer` of the process's own `buffer` module
  (`loadNodeLibFor(process, 'buffer')`), the one its guest's global and `require('buffer')` answer.

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
- **The loop is held** while `emnapi-mt` asks it (`_emnapi_runtime_keepalive_push`/`_pop`: a live thread-safe
  function, queued work), by the process's addon handle (§6).
- **libuv itself is not offered.** `napi_get_uv_event_loop` answers a non-NULL token that names the realm's loop and
  is valid only as an argument; a module that imports a `uv_*` function is refused at its load (§2), since libuv's ABI
  is not Node-API's and the engine has no libuv.
- **A child is the kernel's spawn** (browser-substrate ADR-0231 §5): the variant's `forkpty` is `posix_spawn` through
  `wali.SYS_posix_spawn_v1`, and fork and vfork answer ENOSYS; the engine adds nothing.

### 6. One process owns its addons' lifetime

Each rule names its source, as §4's do.

- **One emnapi context per process.**
  - *Node:* the environment a process runs in owns every `napi_env` made in it, and each `napi_env`'s teardown is a
    cleanup hook of that environment (`node_api.cc:64`), run "once the current Node.js environment exits", with the
    addon's own `napi_add_env_cleanup_hook` hooks (`n-api.md:1928-1929`).
  - *emnapi:* a `Context` holds its environments and their cleanup queue, `newEnv` adds each environment's release to
    it (`emnapi.js:821-834`), and `destroy` stops every call into JavaScript and runs that queue (1478-1482).
    `getDefaultContext` is one context for the realm (1489-1493), and a context's constructor subscribes `destroy` to
    the `beforeExit` of whichever `process` is ambient (1358-1365); `suppressDestroy` is emnapi's own door for an owner
    that calls `destroy` itself (1367-1377).
  - *So:* a process's first load makes its context with `createContext()`, calls `suppressDestroy()`, and its end
    calls `destroy()`.
- **One environment per initialization.**
  - *Node:* each `process.dlopen` makes a new `napi_env` for the initializer it calls (`node_api.cc:790`), so an
    initializer that loads another addon makes a second environment, and a later `dlopen` of the same file makes a
    third over the one library (`node_binding.cc:445-522`).
  - *emnapi:* a `napiModule`'s `init` makes one environment in its context and calls the initializer
    (`emnapi-core.js:1096-1152`), and only once.
  - *So:* each initialization is one emnapi module's `init` over the file's one instance, in the process's context:
    the first is the module whose imports the instance was made with, each later one a `createNapiModule` of its own,
    so a nested load and a reload each have an environment of their own.
- **A failed initialization keeps its environment until the process ends.**
  - *Node:* `napi_module_register_by_symbol` keeps the environment it made whatever the initializer does
    (`node_api.cc:790-805`), and its teardown is the process environment's hook (64). A referenced thread-safe
    function it made "will cause the event loop ... to remain alive until the thread-safe function is destroyed"
    (`n-api.md:6692-6694`).
  - *emnapi:* `init` throws with the environment it made (1131) still in its context, before `loaded` (1150).
  - *So:* the loader tears nothing down; the error is the load's.
- **The loop is held while emnapi-mt asks it.**
  - *Node:* a referenced thread-safe function and queued async work hold the loop (`n-api.md:6692-6694`).
  - *emnapi:* `emnapi-mt`'s C calls `_emnapi_runtime_keepalive_push` and `_pop` around both
    (`threadsafe_function.c:99`, 146; `async_work.c:118`, 124), imports `emnapi-core.js` answers with nothing
    (1312-1319) for its host to supply.
  - *So:* the process's record answers them: a count of holds that starts and stops one owned handle of the process
    (`node-lib/binding/handles.ts`, registered stopped).
- **The process's end ends its addons.**
  - *Node:* the environment's exit runs every `napi_env`'s teardown (above).
  - *So:* the record's handle is closed with the run's other handles by `__releaseOwnedHandles`, which every end of a
    run calls (`process.exit()`, the end of the run's entry, a kill of the run or of a shell job, the host's
    `stopProcess`). Closing calls the context's `destroy` and stops the thread queues (§5). A Runtime made outside any
    run has no end the engine sees, and its addons live as long as it does, as its other handles do.
- **Callbacks into an addon are emnapi's.** Its main-thread `uv_async_send` and `uv_close` (`_emnapi_set_immediate`,
  the context's `feature.setImmediate`, `emnapi-core.js:1323-1327`), its finalizer queue (`NodeEnv.enqueueFinalizer`
  and its `_setImmediate`, `emnapi.js:800-812`, drained by `drainFinalizerQueue`, 813-818) and `_emnapi_next_tick` (1331-1336) are emnapi's own and Tabnode leaves
  them as they are. After `destroy` an environment cannot call into JavaScript (`canCallIntoJs`, `emnapi.js:1471-1473`).
  The one Tabnode supplies is the thread queue's receiver (§5), in place of emnapi's worker listener, which calls each
  callback through the table as that listener does (`emnapi-core.js:1236-1239`), in the loading process's run, and stops
  with the process.
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
  `src/uv/unix/async.c`, `src/uv/unix/core.c`); node-pty's `src/unix/pty.cc`; browser-substrate ADR-0227 §2, §5.12 and
  §6, ADR-0132, ADR-0138, ADR-0218 §1, ADR-0231 and `worker-memory.ts`; the substrate's native-binding prelude
  (`packages/node/src/native-binding-hook.ts`, its `process.dlopen` wrapper); Tabnode's `runtime.ts` addon paths and
  `node-lib/binding/handles.ts` with every caller of `__releaseOwnedHandles`.
- **The toolchain** is browser-substrate ADR-0231's (`toolchains/wali/side-module/`): libc++, libc++abi and libunwind
  built position-independent with Wasm exceptions and threads, `emnapi-mt` built position-independent for
  `wasm32-linux-muslwali`, and `bin/link-side-module`, which links and records a `-shared` side module.
- **Extrapolation:** that one memory per addon-loading process keeps the tab's region count where it is, since the
  substrate's terminal processes are few; that compiling a file twice (§2) costs little beside its instantiation for an
  addon of node-pty's size; and that emnapi's copy boundary (§4) costs a pty nothing, since its bytes move through
  descriptors, not buffers an addon is handed.
- **Coded, not run.** `src/native-addon.ts`, `src/native-queue.ts`, `src/native-thread.ts`, `src/host-native.ts` and
  `runtime.ts`'s two entry points are §1-§7. No substrate on its main offers `TREE_NATIVE` yet (its `load`, over
  `WaliDynamicLinker`, is the kernel lane's), so every `.node` that is a WALI Node-API module fails `<path>: a tab runs
  no native code` until one does.
