# ADR-0004: MessagePort references belong to the guest loop

Status: Accepted

The orchestrator assigned the global and worker_threads MessagePort ref/unref gap
before the Node24 migration. This fix stays on the released Node22 library/DNS0.5.64
and preserves pgid semantics; the Node24 checkpoint is a separate worktree.

A port is real messaging transport, either the host's native MessageChannel or
the embedding thread host's installed channel. No fake postMessage/start/close
transport stands in for it. Node's setupPortReferencing in internal/worker/io.js
unrefs new ports, refs/starts them on the first message listener, and unrefs them
when their last message listener is removed. Explicit ref/unref controls the same
per-process end-of-program decision as timer references, including after a listener
was attached. Closing releases the hold; process teardown closes its ports even
when unref'd. No sampling timer or global live-port handle is created at import.

The guest's global constructors and worker_threads module expose this behavior
without replacing the embedding host's constructors or prototypes. A transferred
native port retains its actual object identity; calls through the guest's bound
MessagePort prototype can register a received port for its current process.
Host-owned control channels are not guest handles merely because they exist.

The assigned page Shell reading observes a listener-only program stay alive until
close, and the same program exit after unref. Both Node builtin and global doors
are read; actual message delivery provides the closing signal. It is a bounded
engine-liveness reading, not a sharp PNG/pthread qualification. After release the
catalog worker receives version/ABI and re-runs that original reading. No suite,
standalone typecheck, lint or review is authorized during this unit.

A worker's Runtime initialization may prewarm a synchronous-child service as an
optimization. Withholding native Worker authority must not abort an unrelated
worker_threads entry before it can receive a message. Prewarming tolerates a
synchronous constructor refusal; an actual spawnSync/execSync request performs
the construction with errors enabled and reports the original refusal. No
native Worker authority is added, and no successful child result is fabricated.
The page Worker/SAB reading exposed this before the oxide entry could run.

Browser worker transport globals are absent Node globals and remain process-local
when a guest assigns them. A worker adapter may install postMessage/onmessage on
its own global without replacing the host's control transport or receiver. The
embedding host also captures its native postMessage and close before guest code
runs, so its channel never depends on a guest-writable lookup. The oxide page
reading exposed a real recursive call when those two namespaces were shared.

A file entry uses the ordinary module loader, including its image-prepared body
and main-module identity. An asynchronous worker entry waits for that module's
settling before draining messages; it does not recompile a prepared dependency
through the source-evaluation door.

On a kernel, a message on its way to a port the program listens to is the process's loop's work until the worker
delivers it (`system.ts` `portMessagesDue`), as a Node port's message is its handle's on libuv
(`src/node_messaging.cc`, a MessagePort's `uv_async_t`). The worker delivers a port's messages from its task queue,
which runs only between the loop's turns; a loop parked in Linux runs none of it (browser-substrate ADR-0236 hole 12).
The transport stays the host's: the engine counts each message posted to a port of the same guest channel, and a
listener of its own, attached beside the program's only while the program listens, counts each delivery. A message to
an unstarted port counts from its start; one to a started port nobody listens to, or to a port sent away in a message,
is not the process's to wait for. *Read 2026-11-15 on browser-substrate's Node host, before:* a `MessageChannel`
ping-pong between one process's two ports never completed (ended at 20 s); after, 0.10 ms a hop (real Node 0.25 ms).
