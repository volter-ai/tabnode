# ADR-0005: The engine is a client of the kernel's store

Status: Accepted (2026-10-06, with the rulings below written in; nothing here is built)

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

Owner: unassigned, after thread A's re-landing of the kernel shell switch. It is not part of step 2 (§4).

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
  - **Amended 2026-10-07 (browser-substrate ADR-0129 step 5, c3a; ADR-0132).** The kernel's one tree holds a write ahead of the store, which receives it from the tree's commit in slices. So "the reader is current" is not enough on its own. A store path is answered in the realm only while no uncommitted change lies on the path or on any directory above it. The tree keeps 4096 uncommitted-change counters by path hash, shared with every realm (`kernel-tree.ts` `words`, on every connection it issues). A mutation raises the buckets of the paths it changes (the path, its inode's names, the directory whose listing it is in) before it returns. The durable slice that commits them lowers them. A rename, unlink or rmdir raises the buckets of the names it changes, so only the paths below them go to the kernel. A hash collision costs one kernel read and never a stale answer. A process that sees the tree from a container's root reads nothing in the realm, because its paths are not the tree's.
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

### 4. Migration with no flag day

Each step ships alone, and each leaves every existing run working.

1. **tabnode: the descriptor door.** The binding uses the tree's `openSync`/`readSync`/… when present, and asks the tree for fd numbers and for fstat. With `VirtualFS`, nothing changes. This is general to any tree; it names no host.
2. **substrate: `KernelVirtualFS`.** It is given to the process kinds the kernel already runs: a `node` Bash execs under the kernel shell (`fix/catalog-shell-boot`). A run's tree is chosen when the run starts, by how it was started, not by a global switch. Dev servers and the toolchain stay on `PackedVirtualFS` until their reading on the kernel path is level with today's (§5).
   - **Amended 2026-10-07 (browser-substrate ADR-0129 step 5, c3).** The interim ends. Every realm runs on a kernel connection issued by the page's init, the execution worker's own tree included, and `PackedVirtualFS` is no realm's tree. The level check is the verification run's boot and first-draw figures, beside the last run before c3.
3. **substrate: the kernel becomes the store's writer** (§0, owner unassigned, after thread A's re-landing), with the clock; file by file in §4a. Node's clocked reads then follow the kernel's clock instead of the container's. A write by Bash is visible to Node's next read without a patch.
4. **substrate: the boot copy goes.** The image tree is the store's layers (ADR-0045/0048). Neither the engine nor the kernel copies it into a tree of its own at boot. `PackedVirtualFS`'s owner role and the container's write path are removed, and the patch publication between the kernel and the page becomes the clock.
5. **Check (A4's own):** grep finds no client with its own process table, descriptor table or file copy. Proof is Node's test/parallel count (A1) on the kernel path, against the same count on `VirtualFS`.

### 4a. Step 3 file by file: the kernel as the store's only writer, with the clock

Step 3.1 is written, unbuilt and unread, on browser-substrate `feat/kernel-store-owner` (0c2bdd63 to 027b16c5, a1923f68). It compiles in `tsc` against a local engine (§4c). Steps 3.2 to 3.5 are a plan. Owner: this lane. Nothing more is written before the re-landing and §4c's sequence. Names are browser-substrate paths at `fix/catalog-shell-boot` 37ef172a. **Read** marks what this record traced in the code. **(extrapolation)** marks a flow that was not traced end to end.

**Today's writers.**
- **Node's writes.** The execution worker's store holds them. **Read:** `packages/node/src/node-store-hold.ts` takes the project's lock (`holdProject`) and calls `createPackStore`. `PackedVirtualFS` writes into it with `applyNow` (`packed-virtual-filesystem.ts`).
- **The kernel's writes.** **Read:** the filesystem host builds `SnapshotWaliFileSystem` over `openPackReader` (`packages/wali/src/filesystem-host-session.ts`, `initializeHost`). It keeps written bytes as dirty nodes and posts them on `updatePort` as `filesystem` patches (`publishUpdates`, about line 256). `worker-program.ts` hands those patches to the program's `onFilesystemCommit` (about line 1290). How that reaches the execution worker's store is **(extrapolation)**: through the page's filesystem and the container's `fs-apply`.
- **A third store owner.** **Read:** `packages/runtime/src/browser-opfs-filesystem-worker.ts` also opens a pack store for a project. Whether it is ever the project's writer beside the execution worker on the kernel path is not traced **(extrapolation)**; step 3.1 settles it.

Each step below ships alone, keeps every run working, and has its disproof.

1. **One lock, one writer.** The kernel's filesystem worker takes the project's lock and opens the store as its writer (`createPackStore`), in place of a reader.
   - **Files:** `packages/wali/src/kernel-filesystem.ts`, `kernel-filesystem-worker.ts` and `filesystem-host-session.ts` (initialize from `store.projectId` as the writer); `packages/node/src/node-store-hold.ts` (the execution worker stops creating the writer and opens a reader seeded by the kernel, `readerSeed`); `packages/runtime/src/browser-opfs-filesystem-worker.ts` (a reader, or gone, by what 3.1's reading shows).
   - **The switch:** within one page there is only ever one writer. The move happens at a deploy, not behind a flag in a running page.
   - **Disproof:**
     - Two realms of one page holding the project as writer at once.
     - An `applyNow` from any realm other than the kernel's filesystem worker. This is a grep of the call sites plus a counter at the store.
2. **The kernel's writes are store writes.**
   - **Upper layer:** `SnapshotWaliFileSystem`'s upper layer for paths under `PROJECT_ROOTS` becomes the store itself. A write, rename, unlink, chmod or utimes by any process is a store mutation applied on the kernel's thread when the syscall completes (`applyNow`, or `applyExtentsNow` for large bytes). It is made durable at `fsync` and at the store's own flush.
   - **Outside the store:** paths outside `PROJECT_ROOTS` (`/tmp`, homes) stay in the kernel host's memory, which is the tmpfs ruling.
   - **Files:** `packages/wali/src/snapshot-filesystem.ts` (dirty nodes to mutations), `shared-file-layer.ts` (the lower tree is the store's index), `filesystem-host-session.ts` (no `filesystem` patch for store paths).
   - **Disproof:**
     - After Bash's `write` returns, a pack reader opened elsewhere reads different bytes at that path.
     - Any `filesystem` patch still carrying store-path bytes.
2b. **Every WALI run reads through the one store; no run carries a copy.** **Read** (thread A's finding, verified at 37ef172a): `worker-program.ts` (about lines 342 to 372) prepares each run by snapshotting the page's filesystem. When that filesystem has no local store (`localBrowserFileSystemStore` is undefined), it copies the files' bytes into a SharedArrayBuffer layer (`createSharedFileLayer`, `shared-file-layer.ts` about line 97). The layer is cached only for a filesystem with `fileContentVersionSync`. The kernel shell's takeover filesystem has none, so every command copied the whole tree (about 320 MB, inferred), and the renderer crashed after a few commands (fixture8: `CRASHED page`, error 5, SIGTRAP; isolate heap from 206 MB to 8115 MB in 6 s). The interim fix, the content-version door on that filesystem, belongs to the re-landing. The fix of the class is here: a run's tree is the kernel's store, read in place (ADR-0048's reader), and `createSharedFileLayer` is never asked for store bytes.
   - **Files:** `packages/wali/src/worker-program.ts` (the run's image is the store's metadata, always), `shared-file-layer.ts` (a layer only for a tree that has no store, which after step 2 is none of the project's), `filesystem-host-session.ts` (the run reads the store).
   - **Disproof:** any SharedArrayBuffer that carries store bytes allocated per run (count `createSharedFileLayer` calls with store paths, and the bytes they copy); the renderer's summed backing store growing with the number of commands run.
3. **The kernel publishes the clock.**
   - **Clock:** the writer's `clock()` and `readerSeed` are the kernel's.
   - **Who follows it:**
     - The execution worker's `storeReads` grants (`cross-origin-container-worker.ts` `storeReadsFor`, `node-invocation-filesystem.ts`).
     - Node threads (ADR-0019).
     - `KernelVirtualFS`, which gains the clocked read view: exists, stat, read, readdir and realpath answered from a reader in its realm while the epoch is the reader's. This is the 150,000-call path.
   - **Files:** `kernel-filesystem.ts` (hands a seed and the clock to a realm that asks), `packages/node/src/kernel-virtual-filesystem.ts`, `node-invocation-filesystem.ts`, `cross-origin-container-worker.ts`.
   - **Disproof:**
     - A read served across an epoch change.
     - The model editor's boot (ADR-0044's measurement) slower with node on the kernel's tree than on `PackedVirtualFS` for the same image.
4. **The page follows the clock, not patches.**
   - **Change:** the page's index of the tree reads the store's log, and the spawn patch flow (`patchAgainst`, `encodeProcessPatch` in `worker-program.ts`) and the execution worker's `installFilesystemForwarding` stop carrying store paths.
   - **Files:** `packages/wali/src/worker-program.ts`, `packages/runtime/src/browser-filesystem.ts`, `browser-project-store.ts`, `packages/node/src/cross-origin-container-worker.ts`.
   - **Disproof:**
     - The page showing a tree older than a write that returned.
     - Any patch with store-path bytes crossing a realm.
5. **No second writer is left.** `PackedVirtualFS` loses its writer mode. Every Node run is on `KernelVirtualFS` (ADR step 4's check) or on a reader. The container's `fs-apply` and `fs-import` for store paths go.
   - **Disproof:** grep finds `applyNow` or `applyExtentsNow` on a project store outside the kernel's filesystem worker, or a client keeping a file copy.

### 4b. Release 0.6.1: steps 1 and 2's engine doors on top of 0.6.0

A plan; no code. It lands after 0.6.0 is on tabnode main, as two merges in this order. Each claim of "no change for a current caller" is read in the code, not measured; the reading named under each is what measures it.

1. **`feat/run-filesystem`** (922f069, 7b9216f; 72cf0e0 merges 0.6.0's 3631ed9). It goes first because it is cut from the release branch and merges onto 0.6.0 without conflict.
   - **`RunOptions.filesystem`**: a run's own tree. A caller that does not pass it runs on the container's tree, as before.
   - **A synchronous child runs on its parent run's tree** (the `tabnode.run.vfs` the runtime sets on every run), not on the last tree the engine was given. For a host with one tree, nothing changes. For a host with several containers in one realm, a `spawnSync` now runs on its parent's tree; before, it ran on whichever tree was initialised last. This is a fix, and it is the one change a `VirtualFS` caller can see.
   - **`statArray`** keeps a tree's S_IFMT type bits, or derives them from every stat predicate. `VirtualFS` modes carry no type bits apart from links, which carry `0o120777`, and it has no devices, FIFOs or sockets. Its file, directory and link answers are therefore what they were.
   - **Reading:** the substrate's kernel shell runs `node -e` with `filesystem` set to the run's `KernelVirtualFS`. The node writes a file, and Bash's `cat` of it in the same line prints it. A fixture without the option prints what build 17 printed.
2. **`feat/descriptor-door`** (d777ab7, 6d508bc; a4d27e9 is already 0.6.0's cabed5a).
   - **The merge conflicts** in `fs.ts`, `index.ts`, `CHANGELOG.md` and the face comment in `child_process.ts`. The resolution keeps both sides:
     - The tree owner's check comes before the standard-stream check in `read`, `write`, `fstat` and `descriptorWriter`.
     - `stdioOf` excludes owned descriptors, so an owned fd numbered 0, 1 or 2 is never taken for a run's stream.
     - It was compiled once, in a scratch tree; `build:lib` ran clean there.
   - **`TREE_DESCRIPTORS`** is offered by a tree, never by `VirtualFS`, so a current caller keeps the engine's descriptor table, its `allocateFd` from 20, and its offsets.
   - **`TreeDescriptorStats` gains four optional predicates** (6d508bc): a type-only, additive change.
   - **Reading:** a kernel-shell `node -e` opens `/tmp/a` with `'a'`, writes `x` and `y`, and prints `fstatSync(fd).size` and `fd`. Both of the following must hold:
     - It prints `2`.
     - The fd number is one the kernel's table holds; `/proc/<pid>/fd` lists it while the process runs.

The substrate's `feat/kernel-virtual-fs` (step 2) and `feat/kernel-store-owner` (step 3.1) pin 0.6.1 and land after it. Both compile against a local build of these two merges (`build:packages` clean in tsc; the shell bundle refused only by the engine pin).

### 4c. Integration after the re-landing: one sequence

What exists, where, and the order it lands in once thread A's re-landing is merged. Heads were read on 2026-10-06. Nothing below has been built in a page or read on the owner's surface. "Compiles" means `build:lib`/`build:packages` `tsc` against a local engine, nothing more.

**tabnode** (`volter-ai/tabnode`, main at v0.5.70 f4abdc5):

| # | Branch @ head | What it is | Base, and its merge |
|---|---|---|---|
| T1 | `feat/argv-node-entry-and-modes` @ 177cd3d | 0.6.0: `runNode`, modes, per-fd kinds, byte stdio, the stdin ring, VFS events, argv0 | Fast-forward of main. Publishing is its merge. |
| T2 | `feat/run-filesystem` @ 72cf0e0 | `RunOptions.filesystem`; a spawnSync child on its parent's tree; statArray's full type | Cut from T1 (a529c11, 3631ed9 merged in). Merges onto T1 clean (`git merge-tree`). |
| T3 | `feat/descriptor-door` @ 6d508bc | `TREE_DESCRIPTORS` (step 1) and its stat predicates | Cut from main. Conflicts with T1 in `fs.ts`, `index.ts`, `child_process.ts` and `CHANGELOG.md`. The resolution is §4b's, compiled once in a scratch tree (77fe510, not pushed). |

T2 and T3 are release 0.6.1 (§4b). Each needs §4b's reading before its merge.

**browser-substrate**:

| # | Branch @ head | What it is | Base, and its merge |
|---|---|---|---|
| S1 | `feat/kernel-virtual-fs` @ 02c7dc45 | `KernelVirtualFS` (step 2); channel retirement; the wali-before-node build order | 922c2ed3 (an older re-landing). Merges onto the re-landing (5f5cd86a) clean. Needs tabnode 0.6.1 pinned. |
| S2 | `feat/kernel-store-owner` @ a1923f68 | Step 3.1 (§4a): one lock, one writer, the execution worker a seeded reader | Contains S1 at 832efaa1. 02c7dc45 is a cherry-pick of a1923f68, so the two merge to the same tree. Clean onto the re-landing. |
| S3 | `fix/wali-network-fd-parity` @ 7e1782d9 | §3a: one number space, fstat/dup of network fds, local blocking reads, the readiness word that ends the 2 ms rescans | c4f1b8a9 (the re-landing at its cut). Two conflicts with the re-landing's head, listed below. |

S3's conflicts with the re-landing's head, both small:
- **`filesystem-protocol.ts`:** the re-landing's `LinkTarget = 39` and S3's `ReserveNetworkDescriptor = 39` take the same number. S3's becomes 40.
- **`filesystem.ts` `virtualStat`:** the re-landing's `anonymousPipeStat` (8b5aa622) replaces the inline pipe stat. Keep it, and put S3's network branch after it.

S3 onto S2 conflicts in `ARCHITECTURE.md`, `ROADMAP.md`, `filesystem-protocol.ts` and `runtime.ts`. That is the same enum number and neighbouring document lines, so the merge is read, not guessed.

**The order**, each step after the one before is merged, with the one reading that admits it:
1. **T1 → tabnode main, published as 0.6.0.** The substrate pins 0.6.0. Reading: the re-landing's own fixture run on 0.6.0.
2. **T2, then T3 → 0.6.1, published.** The readings are §4b's.
3. **S1 with the 0.6.1 pin → substrate.** Reading: a kernel-shell `node -e` reads a file Bash wrote and writes one Bash reads, with no patch between.
4. **S2 → substrate.** Reading: §4a step 1's disproof. One writer per page (a counter at the store); a Node write visible to Bash's next read; the editor's boot not slower.
5. **S3 → substrate**, with its two conflicts resolved as above. Readings:
   - §3a's: `dup2(sock, 1)` reaching the peer; one socket read by both sides of a fork; `/proc/self/fd` in one numbering.
   - The readiness word's: a local-mode `poll`/`epoll_wait` waking on a pipe from another process before its timeout, and an `epoll_wait` with no event using no CPU.

**Disproof of the sequence:** a step merged before its predecessor's reading; a substrate merge whose pin names an engine without the door it uses; a conflict resolved by taking one side whole.

### 5. Performance risks

The operations that matter:

- **The require/resolve storm.** It is existence, stat, read and realpath by the tens of thousands in a boot: 150k calls, 9 s blocked at ADR-0044's measurement. Every one of them must stay on the clocked read view. A design that sends them to the kernel repeats ADR-0044's 9 s. The view's precondition is that the kernel's tree is a store with a clock (§0). **Until step 3, a process whose tree is the kernel's has no fast path, and step 2 must be limited to processes whose boot is small (a CLI under Bash), never a dev server (extrapolation).**
- **The installer's write storm.** `npm install` writes thousands of small files. That is one `openat`/`write`/`close`/`chmod` sequence per file, a few round trips each, against today's in-realm pack append. **(extrapolation: no measurement; the binary `WriteRange` and a batched write request are the levers)**.
- **readdir plus stat walks** (globbing, watchers' rescans, bundlers' scans): one `getdents64` and N `newfstatat`, unless the read view answers them.
- **Positional reads of large files** (source maps, `.wasm`, archives): `pread` in chunks (`FILESYSTEM_SNAPSHOT_CHUNK_BYTES`) instead of one `readFileSync` of a held node.
- **One request per channel.** A process's async fs calls serialize on its channel. A server that reads many files concurrently waits on itself. Threads need their own channels.
- **fs.watch.** Change events must come from the kernel's tree (the clock's log, or a notification port). Today they come from `PackedVirtualFS`'s listeners. Watch latency is unmeasured.
- **The JSON path operations.** `Exists`/`Stat`/`ReadFile` encode JSON and base64 (`readFileSync` returns base64 for small files). ADR-0046 records encoding as most of a call's cost. The design uses the binary syscall path; any JSON operation left in the hot path is a regression to measure.

## What is not decided here

- When Pyodide and PGlite (WasmFS backends) follow. Their client is the same channel; the backend is a WasmFS backend over `WaliFilesystemClient`, which is A4 part 1's WasmFS-in-the-kernel trial's other side.

Disproof: a read by Node that answers a byte Bash wrote over, after Bash's write returned; a boot slower on the kernel path than on `PackedVirtualFS` for the same image; a descriptor offset not shared across a fork; any client keeping a file copy past step 4; a Node realm writing to a path where the kernel holds a file the realm cannot see; a derived artifact served after the content it was derived from changed.
