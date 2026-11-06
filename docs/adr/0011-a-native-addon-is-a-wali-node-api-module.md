# ADR-0011: A native addon is a WALI module of Node-API, loaded over the realm's kernel process

Status: Accepted (design); not coded, waiting on the toolchain (Where the evidence stops).

Date: 2026-11-06. Served: browser-substrate ADR-0218 §1, layer 4: "a native addon is its WebAssembly variant pack".
The first consumer is Conduit's terminal in a tab, which needs node-pty's own C, built for WALI and loaded by Tabnode.

## Context

### What Node does (read in Node v24.21.0's `src/node_binding.cc`, `doc/api/n-api.md`, and `node_api.h` as installed)

- **`require` of a `.node` is `process.dlopen(module, filename)`.** `DLOpen` opens the file with the dynamic linker; a
  file it cannot open fails `ERR_DLOPEN_FAILED` with the linker's own message (`dlerror()`, for example `<path>:
  invalid ELF header`). It then looks for a Node-API initializer (`GetNapiInitializerCallback`): found, it calls it with
  an environment and `module.exports`; absent, and with no legacy registration, it fails `ERR_DLOPEN_FAILED` "Module
  did not self-register: '<path>'."
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

### 1. What is loaded, and in what order

`process.dlopen(module, filename)` and `require` of a `.node` (which is that `dlopen`) go:
1. **The run's binding map first** (ADR-0094): a path the image's map binds is its prepared export, as today.
2. **Else the file's bytes are read.** A file that is a WebAssembly module (`\0asm`) importing `napi` and exporting
   `napi_register_wasm_v1` is a **WALI Node-API module** and is loaded by §2-§4. A module of another ABI than the
   process's (`wali.abi`, ADR-0138) is refused `ERR_DLOPEN_FAILED` naming both profiles, as `dlopen` refuses a
   library of another architecture.
3. **Else it fails as Node's `dlopen` fails**, `ERR_DLOPEN_FAILED`:
   - a file that is no WebAssembly module (an ELF, a Mach-O): `<path>: invalid ELF header`, `dlerror()`'s message on
     Linux, which the engine presents itself as;
   - a WebAssembly module without `napi_register_wasm_v1`: "Module did not self-register: '<path>'.";
   - a module whose imports the loader does not answer (a `uv_*` symbol, an unknown `napi_*`):
     `<path>: undefined symbol: <name>`, as the linker answers an unresolved symbol.
   A package that probes for its addon (chokidar's fsevents) still takes its portable path on that error.

Nothing in the loader names a package; a variant is recognised by its own bytes. The `.node` refusals in
`runtime.ts` become this one path.

### 2. Memory: one per process, shared by its addons, never the kernel's

- **Not the kernel memory.** It is the kernel's state (§2 of ADR-0227); a module that wrote it would write the
  kernel's structures, and its pointers would be the kernel's addresses. So an addon has a memory of its own.
- **One memory per process, made at its first addon, kept for its worker's life.** The realm's worker makes one shared
  wasm32 memory (`shared: true`, the process profile's maximum) the first time its process loads an addon, by
  `worker-memory.ts`'s rule, and every later addon of that process is loaded into it. It costs one of the tab's ~124
  regions for each Node process that loads any addon, not one per addon, and a realm that loads none costs nothing.
- **Each addon is a position-independent module** (ADR-0132's convention, `-fPIC`, `wasm-ld --experimental-pic
  -shared`, its own static musl): the loader reads its `dylink.0` section, maps its memory size and alignment, and its
  stack, from the process's address space (`mmap(2)` through the module's own WALI imports, so the kernel's address
  allocator keeps two addons and the C heaps disjoint, ADR-0227's one address allocator), gives it its own table
  (`__table_base` 0; function pointers do not cross addons), and calls `__wasm_apply_data_relocs` and its constructors
  (`__wasm_call_ctors`) before `napi_register_wasm_v1`.
- **That memory is the process's user memory.** The realm's instance of the kernel is bound to it (the copy module's
  user memory), so an addon's system calls copy in and out of it as a WALI program's do. The realm's own `ks_` calls
  keep using the kernel scratch.

### 3. Node-API is emnapi's

*Amended (decisions fdd3a53d5):* the substrate already implements Node-API for addons through emnapi (ADR-0151's
producer compiles addon variants with Emscripten and emnapi; sqlite3 is one). emnapi's runtime (`@emnapi/runtime`,
`@emnapi/core`) answers Node's own wasm ABI (the `napi` imports, `napi_register_wasm_v1`) over JavaScript values and
has a clang path beside Emscripten. So the loader takes emnapi's runtime as its Node-API implementation: the `napi`
and `emnapi` imports are emnapi's, made by its `instantiateNapiModule` over the module and the process memory, and no
second Node-API is written in the engine. A variant is therefore linked as emnapi's clang path links one (its
`include/node` headers and its threaded library `emnapi-mt`, `-mexec-model=reactor`, `--import-memory
--shared-memory`, exporting `napi_register_wasm_v1`, `emnapi_create_env`, `malloc` and `free`), for the WALI target.

What the engine adds around it, and the parts emnapi cannot serve here:
- **Threads are the kernel's tasks, not emnapi's workers** (a departure). emnapi's clang path makes a thread by WASI's
  `thread-spawn` import and a worker its `onCreateWorker` makes, and wakes the main thread by that worker's messages.
  A WALI module's `pthread_create` is WALI's `clone`, answered by a kernel task in a worker the substrate starts
  (ADR-0227 §6), so `thread-spawn` is not offered and the thread side of the imports emnapi's threaded library needs
  (its wakes of the main thread for `uv_async_send`, which its async work and thread-safe functions are built on) is
  the engine's own, in that worker: a queue in the shared memory, `Atomics.notify` to wake the main side, and on the
  main side `Atomics.waitAsync` (no timer) to run emnapi's callbacks on the realm's loop. Async work's pool and
  thread-safe functions are then emnapi's own C over WALI's pthreads.
- **One memory per process needs position-independent variants** (§2). emnapi's documented clang link is a reactor
  at fixed addresses, so two such variants in one memory would overlap. A variant is loaded into the process memory
  at its own base only where it is linked position-independent (`-fPIC`, `--experimental-pic -shared`, with
  `emnapi-mt`, musl and its C++ runtime built PIC); emnapi's runtime is given that memory and the module's base, as it
  is given any imported memory.
- What §3's remainder says of handles, bytes, errors and the version is what emnapi's runtime does; the version the
  loader accepts is still the engine's Node line's (v24.21.0).

The original §3, kept as what emnapi's runtime must answer:
- **Handles are indices.** A `napi_value` is an index into the current handle scope's table (0 reserved for NULL),
  freed when its scope closes; `napi_ref` is an index into a reference table holding a strong value, or a `WeakRef`
  when its count is 0; `napi_env` is one per loaded module. `napi_wrap`, `napi_add_finalizer` and external values run
  their finalizers from a `FinalizationRegistry`, on the main loop, as Node runs them.
- **Bytes are the module's memory.** Strings are read and written as UTF-8, Latin-1 or UTF-16 in the addon's memory;
  an `ArrayBuffer` or `Buffer` an addon creates is a copy in the engine's heap, whose `napi_get_buffer_info` data
  pointer is a region the loader keeps in the addon's memory and copies back at each call boundary; an external
  buffer over the addon's memory is a view of the shared memory itself, which does not detach as it grows.
- **Errors are Node's.** Each call records its last error (`napi_get_last_error_info`), and a pending JavaScript
  exception is thrown when the call returns to JavaScript, as Node's `napi_env` does.
- **The supported set** is the stable Node-API of the engine's Node line (v24.21.0), declared by
  `node_api_module_get_api_version_v1`; a module asking for a higher version is refused "Module did not self-register"
  with the version named, and an experimental function is an unresolved symbol (§1).

### 4. Threads, the loop and libuv

- **An addon's threads are its process's tasks.** `pthread_create` is WALI's `clone`, answered by the kernel's task
  creation and a worker of the process posted its memory (ADR-0227 §6), which instantiates the same module at the
  same bases with the thread side of the `napi` imports.
- **The thread side of Node-API** is what Node-API allows off the main thread: `napi_call_threadsafe_function`,
  `napi_acquire_threadsafe_function` and `napi_release_threadsafe_function`. A thread-safe function is a queue in the
  shared memory with its lock word: a call enqueues its data and wakes the main side (`Atomics.notify`); a blocking
  call on a full queue waits on it (`Atomics.wait`, a worker may block); the main side waits with `Atomics.waitAsync`
  (no timer) and calls the JavaScript function on the realm's loop for each item, as Node's `uv_async` does. The
  function holds the loop while it is referenced (`napi_ref_threadsafe_function`, `napi_unref_threadsafe_function`),
  and its finalizer runs on the main thread when its last thread released it. Any other `napi_*` call from a thread
  aborts the process, `napi_fatal_error`'s answer to a call Node-API forbids.
- **Async work** (`napi_create_async_work`, `napi_queue_async_work`) runs `execute` on a pool of the process's
  threads, four by default (`UV_THREADPOOL_SIZE`, as libuv), and `complete` on the realm's loop through the same queue;
  queued work holds the loop until its `complete` has run, and `napi_cancel_async_work` removes work not yet started.
- **libuv itself is not offered.** `napi_get_uv_event_loop` answers a non-NULL token that names the realm's loop and
  is valid only as an argument; a module that imports a `uv_*` function is refused at its load (§1), since libuv's ABI
  is not Node-API's and the engine has no libuv.
- **A fork is the kernel's vfork of a host image** (ADR-0227 §5.12): node-pty's `forkpty` and the child's calls before
  its `execvp` run in the parent's instance under the child's task; the engine adds nothing.

### 5. What the substrate supplies

Under a tree capability beside `TREE_SOCKETS` (`TREE_NATIVE`):
- `memory()`: the process's user memory, made at the first call by `worker-memory.ts`'s rule and kept, and the
  realm's kernel instance bound to it as its user memory;
- `waliImports(module)`: the `wali` imports a WALI module takes, bound to the calling task, with that memory as their
  user memory;
- `startThread(module, entry, imports)`: a task of the process (`k_task_create`) running `module` from `entry` in a
  worker posted the memory, with the engine's thread-side `napi` imports (§4), and its end reported.

## Where the evidence stops

- **Read:** Node v24.21.0's `src/node_binding.cc` (`DLOpen`, `GetNapiInitializerCallback`, its `ERR_DLOPEN_FAILED`
  messages), `doc/api/n-api.md` (thread rules, async work, thread-safe functions, `napi_get_uv_event_loop`), `node_api.h`
  and `js_native_api.h` (installed, v26.12.0, the wasm lines equal to v24.21.0's); node-pty's `src/unix/pty.cc`;
  browser-substrate ADR-0227 §2, §5.12 and §6, ADR-0132, ADR-0138, ADR-0218 §1 and `worker-memory.ts` at 7cd0f130e3d;
  Tabnode's `runtime.ts` addon paths at 5224b95.
- **Read for the toolchain** (browser-substrate at 7cd0f130e3d), whether a WALI shared module with libc++, C++
  exceptions and `std::thread` can be built today:
  - *pthreads:* yes. The canonical `20261012-pthread` SDK's musl is built `-fPIC -pthread -matomics -mbulk-memory`
    (`toolchains/wali/scripts/prepare-wali-musl.py`).
  - *Position-independent modules:* the pinned clang-24 links them (ADR-0132's `--experimental-pic -pie`), and a
    side module's form is written (`toolchains/wali/README.md`: "Side bodies use dylink.0 and import that
    memory/table/stack"), but no recipe builds a `-shared` side module: the dlopen sysroot recipe "neither builds them
    nor qualifies a load".
  - *libc++, libc++abi, libunwind with Wasm exceptions and threads:* they exist only in Blender's program-local
    sysroot overlay (`programs/blender/deps/build-sysroot.sh` stage 2, reused by MariaDB), built `-fwasm-exceptions
    -pthread` at `-O0` with `CMAKE_POSITION_INDEPENDENT_CODE=OFF` and `LIBCXXABI_ENABLE_PIC=OFF`, with the
    `__cpp_exception` tag object `cpp_exception.o`. Non-PIC archives cannot be linked into a `-shared` module.
  - *emnapi's `emnapi-mt` library for the WALI target:* not built anywhere in the repository.
  - *node-pty needs the C++ runtime whatever its exceptions:* it uses `std::thread` and `std::string`, and its
    `src/unix/pty.cc` `throw`s `Napi::Error`, so `NAPI_DISABLE_CPP_EXCEPTIONS` does not remove C++ exceptions.
  - **So it cannot be built today.** Missing, for the kernel lane's toolchain: a PIC build of libc++, libc++abi,
    libunwind and `cpp_exception.o` (with `-fwasm-exceptions` and `-pthread`) in the SDK; `emnapi-mt` built PIC for
    `wasm32-linux-muslwali`; and a recipe that links and records a `-shared` side module. The loader is not coded
    until they exist.
- **Not read:** whether the vfork of a host image keeps node-pty's `setuid`/`setgid` in the child (§5.12's list does
  not name them; Conduit passes no credentials).
- **Extrapolation:** that one memory per addon-loading process keeps the tab's region count where it is, since the
  substrate's terminal processes are few; and that the copy-back of addon-made buffers at call boundaries is cheap
  enough for a pty's traffic, which is small.
- **Not run.** Nothing here is coded.
