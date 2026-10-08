# ADR-0005: The engine is a client of the kernel's store

Status: Accepted (2026-10-06). Built in the engine: the descriptor door and a run's own tree (§1, §4). The store's one owner and every realm's tree are the substrate's, in browser-substrate ADR-0129 step 5.

Date: 2026-10-06. TRACKER A4 "one owner", part 4 (consolidation): "done when no client keeps its own process table, descriptor table or file copy (grep-checked)". Owner's aim, as relayed: a file Node writes is the file Bash reads, with no second VFS and no boot-time copy.

## Where the evidence is, and where it stops

Read at tabnode `origin/main` f4abdc5 and browser-substrate `origin/main` (with `fix/catalog-shell-boot` 1cb0480b for the kernel-shell work). Nothing below was run or measured for this record. Numbers come from the substrate's own ADRs, cited where used. Every statement marked **(extrapolation)** is design, not reading.

What the code says today:

- **The engine reads and writes one duck-typed tree.** Every builtin `fs` call lands in `src/node-lib/binding/fs.ts`, which takes the run's tree off its process (`kRunFilesystem`) and calls `existsSync`, `statSync`, `lstatSync`, `readFileSync`, `writeFileSync`, `appendFileSync`, `writeAtSync`, `mkdirSync`, `readdirSync`, `unlinkSync`, `rmdirSync`, `renameSync`, `realpathSync`, `readlinkSync`, `symlinkSync`, `chmodSync`, `utimesSync` and `accessSync` on it. The module loader (`runtime.ts`, `node-resolution.ts`), the installer (`src/npm/`), the esbuild shim and the engine's own shell (`shims/vfs-adapter.ts`) use the same object. `VirtualFS` (`src/virtual-fs.ts`) is the in-memory implementation, and `mount(path, MountedTree)` is its read-only extension point (`/proc`).
- **The engine keeps its own open-file table.** `openFiles` in `binding/fs.ts` maps an fd (allocated from 20 by `fds.ts`) to `{ path, flags, position, cached, tree }`. `cached` holds a copy of the file's bytes for the life of the descriptor. fds 0, 1 and 2 are answered from the run's own streams (0108e14 on `feat/argv-node-entry-and-modes`). Pipes past fd 2 and IPC channels live in a per-run table (`registerRunFd`).
- **A remote tree already exists in the engine.** `shims/sync-child.ts` runs a second engine on a thread over a `ProxyVFS`: a `VirtualFS` subclass whose every method crosses a SharedArrayBuffer window synchronously (`Atomics.wait`) to the parent's tree. The engine already runs over a tree it does not hold.
- **In the substrate, a Node process's tree is the project's pack store.**
  - `PackedVirtualFS` (`packages/node/src/packed-virtual-filesystem.ts`) extends `VirtualFS`. It keeps the index in memory and the bytes in the pack. Paths outside `PROJECT_ROOTS` (`/tmp` among them) stay in the base class's memory.
  - The container worker is the store's owner and writer.
  - A Node process reads the store itself in its own realm while the owner's clock says its index is current (ADR-0019, ADR-0044, `node-invocation-filesystem.ts` `storeReads`). Its writes, and every read it cannot prove current, cross a `BrowserFilesystemChannel` to the owner.
- **The kernel's filesystem is a second writer.** `packages/wali` gives every WALI process a `WaliFilesystemChannel`: SharedArrayBuffers for `control` and `payload`, plus a port. `WaliFilesystemClient` (`filesystem-remote.ts`) makes each request synchronous with `Atomics.wait` (`exchange`), as path operations (`FilesystemOperation.Exists`…`Rename`, `ReadRange`/`WriteRange`) and as binary syscalls (`SyscallBinary`) against the process's kernel descriptor table (`WaliProcessDescriptorTable`, `WaliDescriptionRegistry`). Fork and exec copy that table (`CopyForFork`, `CopyForExec`). The host (`filesystem-host-session.ts`) builds its tree as a `SnapshotWaliFileSystem` over a pack *reader* (`openPackReader`, ADR-0048) and keeps written bytes in its own memory (`dirty` nodes). It publishes them to the page as snapshots and patches on a debounce (`updatePort`, `importPeerPatch`).
- **The cost of the round trip is measured.** ADR-0044 measured about 150,000 filesystem calls in one model-editor boot: 78k existence checks, 28k stats, 21k reads (218 MB), 14k realpaths. Processes spent 9 s blocked on round trips; the owner spent 1.1 s answering. TRACKER A3 records about 60 µs per round trip. ADR-0046 measured the WALI request hop as the whole gap to Emscripten for small-file work, 24 ms against 2 ms for 200 files and their stats.

So today one project has two writers: the container's `PackStore`, which holds Node's writes, and the kernel host's snapshot memory, which holds Bash's writes. They are reconciled by patches. That is the second store this record removes.

## Decision

### 0. The one owner (a prerequisite this record depends on)

Owner: the substrate (browser-substrate ADR-0129 step 5).

**(extrapolation)** The kernel's filesystem host becomes the project store's only writer. Its tree's upper layer is the `PackStore` itself (`applyNow`, publishing the ADR-0044 clock), not dirty nodes published by patch. The container stops owning the store. The writer publishes the clock, so the kernel's tree publishes it, and every client follows the kernel's clock. None of this is tabnode code. Everything below assumes it, and works without it only in the degraded sense that the engine's writes reach the kernel's tree and the kernel publishes them as it publishes Bash's.

### 1. Which engine operations become kernel requests, over which channel, on which thread

- **The channel.** A Node process is a kernel process: it is given a `WaliFilesystemChannel` as a WALI process is (`createChannel`, `copyForExecChannel` when Bash execs `node`). It reaches the kernel through `WaliFilesystemClient`. There is no second protocol: the engine is one more caller of the requests WALI programs make.
- **The seam in tabnode.** The run's tree is still the object on `kRunFilesystem`, and the substrate supplies it. A new class in the substrate, `KernelVirtualFS` (a name for the design), implements the tree interface over `WaliFilesystemClient`. tabnode gains no dependency on the substrate.
- **The descriptor door (in tabnode).** The fs binding asks the tree for descriptor operations when the tree has them, as it already asks for `appendFileSync` and `writeAtSync`:
  - `openSync(path, flags, mode) → fd`, `readSync(fd, buf, off, len, pos)`, `writeSync(fd, …)`, `fstatSync(fd)`, `closeSync(fd)`, `ftruncateSync`, `fsyncSync`, `getdentsSync`.
  - A tree that has them owns the descriptor; the binding's `openFiles` is not used for its files.
  - `KernelVirtualFS` answers them with `SyscallBinary`: `openat`, `read`/`pread64`, `write`/`pwrite64`, `lseek`, `fstat`, `close`, `ftruncate`, `fsync`, `getdents64`, `dup3`, `fcntl`.
  - `VirtualFS` does not have them, so a library user's engine keeps its own table.
- **Path operations.**
  - **Through syscalls:** `stat`/`lstat`/`access`/`exists` (`newfstatat`, `faccessat`), `mkdir`/`unlink`/`rmdir`/`rename`/`symlink`/`readlink`/`chmod`/`utimes` (`*at` calls), `realpath` (Node's own JS realpath over `lstat`/`readlink`, as on Linux).
  - **Whole-file read/write:** stays `ReadRange`/`WriteRange`.
  - **Reason (S, "one source per rule"):** going through the same handlers as a WALI program gives one implementation of open flags, errno precedence, permissions and symlinks. The JSON path operations (`Exists`, `Stat`…) carry the same answers through a second encoder, so the syscall path is the one taken. **(extrapolation: per-call cost of the two encodings not measured for Node's mix)**
- **How they block.** `fs.*Sync` calls `WaliFilesystemClient.exchange`, which is `Atomics.wait` on `control[0]`. The thread is the Node process's own worker (ADR-0037: each process is a worker realm), never the page's main thread, which refuses `Atomics.wait`; there the run is refused by name, as `ERR_STDIN_BLOCKING_READ` is. Async `fs` calls run the same synchronous request and answer on the next tick, which is what `binding/fs.ts`'s `answer(req, work)` already does. A worker blocked for one request is what Node's threadpool would cost a single caller. Concurrency between async calls is lost, measured nowhere yet **(extrapolation)**.
- **Threads.** A `worker_threads` thread has its own channel (`createChannel(payloadBytes, process)`), because one channel carries one request at a time ("Concurrent WALI filesystem RPC on one channel"). ADR-0019's thread-reads-the-store rule becomes thread-reads-under-the-kernel's-clock (§2).

### 2. What the engine keeps locally, and why that is not a second store

A second store is state that can answer a read with something the owner does not hold. The engine keeps only views that are invalidated by the owner, and derived artifacts keyed by what they were derived from.

- **The clocked read view (ADR-0044, kept).** Existence, stat, read, readdir and realpath on store-backed paths are answered from a pack reader in the process's realm while the kernel's clock says that reader is current. Anything else asks the kernel. This is the only way to keep the 150k-call boot off the round trip. It holds no writes and no state of its own: a stale epoch sends the read to the kernel.
  - **A write the kernel's tree holds ahead of the store.** Where the kernel's tree commits a write to the store after the call that made it returns, "the reader is current" is not enough on its own: a store path is answered in the realm only while no uncommitted change lies on the path or on a directory above it, and a process that sees the tree from a container's root answers nothing in the realm, because its paths are not the tree's. How a realm learns that is designed when the view is built, on a measured need (browser-substrate ADR-0129, "The read path, and the rule each row keeps").
- **Resolution caches.** ADR-0001's positive module-path cache (`Module._pathCache` semantics, per process) and the resolver's package-manifest reads stay per process, as Node keeps them on Linux.
- **The module cache and compiled code.** These are the CommonJS cache (`require.cache`), the lowered-ESM cache (`processedCodeCache`), the image's prepared modules (`PREPARED_MODULES_DIR`, ADR-0048's installed host trees) and the esbuild transform cache. Every derived artifact is keyed by the digest of the bytes it was derived from, not by path and clock. A content key is correct by construction and needs no clock: a module re-read after another process rewrote it has a new digest and misses. Node keeps `require.cache` per process too, by path, as on Linux.
- **Nothing else.** The descriptor `cached` copy in `openFiles` goes for kernel-owned descriptors: a read is a `pread`, and the kernel answers from its page of the file. `/proc` comes from the kernel (emscripten-map §4 item 10), not from a `MountedTree`. `/tmp`'s bytes live in the kernel host's memory, as Linux's tmpfs keeps them: not in the store, and not in `PackedVirtualFS`'s overlay, which does not survive this.

### 3. Open file descriptions

- **Descriptor numbers.** A Node process's fds are kernel fds in its `WaliProcessDescriptorTable`. Numbers come from the kernel's allocator, so the engine's `allocateFd` (from 20) and the kernel's must not both hand out numbers in one process. `fds.ts` asks the tree for a number when the tree owns descriptors. The engine's pipe and TCP handles keep `registerFd` numbers only until they too become kernel descriptions (A4's descriptors-and-sockets step, after this one).
- **Offsets and `O_APPEND`.** They live in the kernel's open description (`WaliOpenDescription`). The engine's `position` and its append arithmetic (`writeBuffer`'s held/at logic) are not used for kernel descriptors. `fs.write` with a position is `pwrite64`, and without one `write`, so `O_APPEND` is the kernel's rule.
- **fd 0, 1 and 2.** These are kernel descriptions (pipe, pts, file, char). `describeDescriptor`/`descriptorStat` give `stdioKind`. Bytes to and from them are the description's: the `stdinShared` ring and the byte sinks of 0.6.0 are the interim doors, and become reads and writes on fds 0–2 when the process's stdio is the kernel's.
- **Fork and exec.** A Node child spawned by Bash arrives by `execve` with its inherited table (`CopyForExec` with `stdio`), so its fds 3+ are the shell's redirections, shared offsets included. A child spawned by Node (`child_process.spawn` of anything) becomes a kernel spawn with the same inheritance. That is A4's process step; until then the engine's `startChildRun` keeps its route. `close-on-exec` and `dup` semantics are the kernel's.
- **Locks.** `flock`/`fcntl` locks are the kernel's coherent locks (`coherent-file-locks.ts`). The engine has none today.

### 3a. One number space: the kernel's descriptors and sockets (the descriptors-and-sockets step)

Names are browser-substrate paths on `fix/wali-network-fd-parity` (off `fix/catalog-shell-boot` c4f1b8a9).

**Read: how it works today.**
- A WALI process has two descriptor tables, split by number.
- Files, pipes, stdio and the local specials are in the process's `WaliProcessDescriptorTable` (`descriptors.ts`). The kernel's filesystem host owns that table. Its entries and its description metadata are SharedArrayBuffers every realm of the family reads (`sharedPipes.table`, `sharedPipes.descriptions`).
- Sockets, epoll sets, eventfds, timerfds and pidfds are in the network session's own maps (`network-host.ts` `sockets`, `epolls`, `children`), numbered from `NETWORK_FD_MIN` = 20000 (`network-protocol.ts`, `takeFd`).
- The guest tells the two apart by number alone: `network.ts` `isNetworkFd(fd) = fd >= NETWORK_FD_MIN`.
- So a socket can never be fd 0, 1 or 2, `dup2(sock, 5)` lands in the file table and answers EBADF, and no file can sit at 20000 or above. Linux has one table, and none of these rules.

**Decision.**
- **One table, one allocator.** Every descriptor of a process is an entry of its `WaliProcessDescriptorTable`. Its allocator hands out every number, lowest free first, as Linux's `alloc_fd`.
- **A network description is a description of the table.** A socket, epoll set, eventfd, timerfd or pidfd is registered in the table's registry as kind `"network"`, whose value names the session's description. The session keeps the object (the socket, the epoll set) and its readiness. The table keeps the number, `FD_CLOEXEC`, and the reference count that `dup` and `fork` share.
- **Routing by kind, never by range.** The description metadata (`registry.pipeMetadata`, per description id) gains a kind mark that the guest's layers read for an fd, as they read a pipe's entry today. `isNetworkFd(fd)` asks that mark, and `NETWORK_FD_MIN` and range checks go.
- **Who allocates.** The realm that owns the table: the kernel's filesystem host, or a local run's own table. The guest drives both sides, because it is the only realm with a channel to each.
  - **socket(2):** the guest asks the table for a number reserved as `"network"`, then asks the session to create the object at that number.
  - **close:** the session releases the object when the table's description goes, so the table's release callback is where the session hears it. The guest's close goes to the table.
  - **dup, dup2, dup3, F_DUPFD:** the table's own operation on the description. The session learns the new number for routing its calls, through the description id.
- **Fork and exec.** The table's `copy()` and `exec()` already carry `"network"` entries with their flags, so close-on-exec is the table's rule. `CaptureDescriptors` keeps carrying the session's objects by token, keyed by description id rather than by number.
- **What does not change.** The session still answers every socket operation. Readiness still comes from the session, and the family's readiness word (`readiness.ts`) still wakes waits. A host image (Node) still refuses an inherited socket (gap 6).

**Order of the code.** One commit each:
1. The kind mark in the description metadata, and `"network"` descriptions with a session-object id.
2. Allocation through the table for `socket`, `socketpair`, `accept`, `epoll_create`, `eventfd`, `timerfd_create`, `pidfd_open`.
3. Routing by kind in `network.ts`, `runtime.ts` and `thread-worker.ts`, with `NETWORK_FD_MIN` removed.
4. dup, close, fork and exec through the table.
5. The handoff keyed by description id.

**Where the evidence stops.**
- Everything under "Read" was traced in the code at c4f1b8a9.
- The decision is extrapolation: no build or run has measured it. In particular, that a socket at fd 1 survives `exec` into a WALI image, and that `accept`'s new number is the table's lowest free one, are claims for the reading.
- The reading:
  - `exec 3<>/dev/tcp/…` style redirection, and `dup2(sock, 1)`, then a write to fd 1 reaching the peer;
  - after `fork`, both processes reading the same socket (one description);
  - `ls -l /proc/self/fd` showing every descriptor in one numbering.

**Disproof:** a guest call routed by a number's range; a socket number the file table did not allocate; two descriptions sharing one number across the two tables.

### 4. Where each part lands

1. **The descriptor door (engine, built).** The fs binding asks a tree that offers `TREE_DESCRIPTORS` (`src/tree-descriptors.ts`) for every descriptor operation on a file it opened, with the tree's numbers, offsets and `O_APPEND`. `VirtualFS` does not offer it, so a library user's engine keeps its own table.
2. **A run's own tree (engine, built).** `RunOptions.filesystem` gives one `runNode` its tree in place of the container's; a synchronous child runs on its parent run's tree. A tree a host hands the engine is the host's, and the engine writes nothing into it on its own account. The substrate's `KernelVirtualFS` is that tree for a process the kernel runs.
3. **The store's one owner, and every realm on a kernel connection (substrate).** browser-substrate ADR-0129 step 5 owns the order, row by row, and each row's reading.
4. **Check (A4's own):** grep finds no client with its own process table, descriptor table or file copy. Proof is Node's test/parallel count (A1) on the kernel path, against the same count on `VirtualFS`.

### 5. Performance risks

The operations that matter:

- **The require/resolve storm.** It is existence, stat, read and realpath by the tens of thousands in a boot: 150k calls, 9 s blocked at ADR-0044's measurement. Every one of them must stay on the clocked read view. A design that sends them to the kernel repeats ADR-0044's 9 s. The view's precondition is that the kernel's tree is a store with a clock (§0). A process whose tree is the kernel's has no such view until one is built for it, so a realm moves onto the kernel's tree with its request count measured (browser-substrate ADR-0129 row 5a).
- **The installer's write storm.** `npm install` writes thousands of small files. That is one `openat`/`write`/`close`/`chmod` sequence per file, a few round trips each, against today's in-realm pack append. **(extrapolation: no measurement; the binary `WriteRange` and a batched write request are the levers)**.
- **readdir plus stat walks** (globbing, watchers' rescans, bundlers' scans): one `getdents64` and N `newfstatat`, unless the read view answers them.
- **Positional reads of large files** (source maps, `.wasm`, archives): `pread` in chunks (`FILESYSTEM_SNAPSHOT_CHUNK_BYTES`) instead of one `readFileSync` of a held node.
- **One request per channel.** A process's async fs calls serialize on its channel. A server that reads many files concurrently waits on itself. Threads need their own channels.
- **fs.watch.** Change events must come from the kernel's tree (the clock's log, or a notification port). Today they come from `PackedVirtualFS`'s listeners. Watch latency is unmeasured.
- **The JSON path operations.** `Exists`/`Stat`/`ReadFile` encode JSON and base64 (`readFileSync` returns base64 for small files). ADR-0046 records encoding as most of a call's cost. The design uses the binary syscall path; any JSON operation left in the hot path is a regression to measure.

## What is not decided here

- When Pyodide and PGlite (WasmFS backends) follow. Their client is the same channel; the backend is a WasmFS backend over `WaliFilesystemClient`, which is A4 part 1's WasmFS-in-the-kernel trial's other side.

Disproof: a read by Node that answers a byte Bash wrote over, after Bash's write returned; a boot slower on the kernel path than on `PackedVirtualFS` for the same image; a descriptor offset not shared across a fork; any client keeping a file copy once the substrate's rows have landed; a Node realm writing to a path where the kernel holds a file the realm cannot see; a derived artifact served after the content it was derived from changed.
