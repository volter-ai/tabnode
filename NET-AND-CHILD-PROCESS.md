# Node's own `net` and `child_process`, on a binding written once

The rule this applies is `CONTRIBUTING.md`'s: a hand-written module that has grown
a patch group is replaced with Node's own file from `nodejs/node/lib` on a
binding written once, and Node's tests are the measure. `src/shims/path.ts`
over `src/node-lib/path.js` is the precedent: the vendored file binds, it
does not implement, and a bug is fixed by moving the file to a newer Node,
never by editing either side.

`src/shims/net.ts` and `src/shims/child_process.ts` are that patch group.
Between fork .36 and .44 they took nine corrections, each one gap of Node's
behaviour an application met in the tab (unix-socket paths, `fork`'s path
resolution, `kill` on an exited child, `send` with a handle, sockets holding
a run alive, `bufferSize`, an `upgrade` listener's socket, uncaught
exceptions, `unhandledRejection`'s promise), and the application at the end
of that run, VS Code's extension host, still does not activate an extension.
What it needs next is not known until the next gap shows, because a
hand-written module carries only the slice of Node one program exercised.
Node's own files carry the whole behaviour, and 260 of Node's own tests
(`test-net-*`, `test-child-process-*`) say how much of it holds.

## What is vendored, unmodified, from Node v22.18.0 (Node's own `lib/`)

`net.js`, `internal/net.js`, `internal/stream_base_commons.js`,
`internal/socket_list.js`, `child_process.js`, `internal/child_process.js`,
`internal/child_process/serialization.js`, `internal/errors.js`,
`internal/validators.js`, `internal/events/abort_listener.js`, and
`internal/per_context/primordials.js`, which builds the whole `primordials`
object over the realm's built-ins the way Node does, so no vendored file's
destructure is hand-written.

Each lands in `src/node-lib/` and is loaded by one loader,
`src/node-lib/load.ts`, which evaluates a file as Node's `BuiltinModule`
does: `(function (exports, require, module, process, internalBinding,
primordials) { ... })`, caches it, resolves `internal/...` names to vendored
or bound modules and public names to the engine's shims, and hands
`internalBinding(name)` the binding below. `runtime.ts`'s builtin table
points `net` and `child_process` at the loaded exports.

Internals the vendored files name that are NOT vendored are bound by hand,
each as the small object the files destructure, in `src/node-lib/internals/`:
`internal/util` (the names `net.js`, `child_process.js` and
`internal/child_process.js` destructure, over the engine's `util`),
`internal/util/debuglog` (a `debuglog(name)` whose function is a no-op with
`enabled: false` unless `NODE_DEBUG` names it), `internal/util/types` and
`internal/util/inspect` (the engine's `util`), `internal/async_hooks`
(`newAsyncId`, `defaultTriggerAsyncIdScope`, `getDefaultTriggerAsyncId`,
`initHooksExist`, `emitInit`, over the engine's `async_hooks`, no-ops where
the engine has nothing), `internal/timers` (`kTimeout`, `TIMEOUT_MAX`,
`setUnrefTimeout`, `getTimerDuration` over the engine's timers),
`internal/streams/state` (`getDefaultHighWaterMark`),
`internal/process/task_queues` (the engine's `process.nextTick`),
`internal/socketaddress` and `internal/blocklist` (`SocketAddress`,
`BlockList` as classes that validate and hold, nothing more),
`internal/options` (`getOptionValue` answering Node's defaults),
`internal/perf/observe` (`hasObserver` false), `internal/assert`,
`internal/fs/utils` (`getValidatedPath`, `validatePath` over the engine's
`fs`), `internal/process/permission` (`isEnabled` false), `internal/dgram`
(the two names `internal/child_process` reads). Public modules resolve to the
engine's shims: `buffer`, `events`, `stream`, `timers`, `dns`, `cluster`,
`diagnostics_channel`, `dgram` (a stub `Socket`), `_http_common` (an
`HTTPParser` stub for the `instanceof` test only).

## The binding

One directory, `src/node-lib/binding/`, one file per `internalBinding` name.
Everything the engine already does for a socket or a child stays and becomes
the binding's implementation: the loopback pairing of a connect to a
listening port or path, the page bridge that announces a listening port and
routes a preview's requests and upgrades, the routing of a spawned command
to the engine's `node`, a page-registered program, a WALI pack or the shell,
and the run ownership that keeps a run alive while it holds a handle.

- `uv`: `errname(code)`, `getErrorMap()`, and the `UV_*` constants Node's
  files read, with Linux numbers (`UV_EOF` -4095, `UV_ECONNREFUSED` -111,
  `UV_ECONNRESET` -104, `UV_EADDRINUSE` -98, `UV_ENOENT` -2, `UV_ENOTSOCK`
  -88, `UV_EPIPE` -32, `UV_EACCES` -13, `UV_EINVAL` -22, `UV_ENOTCONN` -107,
  `UV_EAGAIN` -11, `UV_ECANCELED` -125, `UV_EMFILE` -24, `UV_ENOSYS` -38,
  `UV_ESRCH` -3).
- `stream_wrap`: `LibuvStreamWrap` (the base `TCP` and `Pipe` extend) with
  `readStart()`, `readStop()`, `shutdown(req)`, `writeBuffer(req, buf)`,
  `writev(req, chunks, allBuffers)`, `writeUtf8String(req, str)`,
  `writeAsciiString`, `writeLatin1String`, `writeUcs2String`,
  `useUserBuffer(buf)`, `getAsyncId()`, `ref()`, `unref()`, `close(cb)`,
  `fd` (-1), `bytesRead`, `bytesWritten`, `writeQueueSize` (0); `WriteWrap`
  and `ShutdownWrap` request classes; the exported `streamBaseState`
  `Int32Array` with `kReadBytesOrError`, `kArrayBufferOffset`,
  `kBytesWritten`, `kLastWriteWasAsync`. A read delivers by setting
  `streamBaseState[kReadBytesOrError]` to the byte count (or `UV_EOF`) and
  calling `handle.onread(arrayBuffer)`, exactly what `onStreamRead` in
  `internal/stream_base_commons.js` expects; a write completes
  synchronously (`kLastWriteWasAsync` 0, `kBytesWritten` set, the request's
  `oncomplete` not called), which is what the engine's writes are.
- `tcp_wrap`: `TCP(type)` with `constants.SOCKET|SERVER`,
  `TCPConnectWrap` (`oncomplete(status, handle, req, readable, writable)`),
  `bind`/`bind6`, `listen(backlog)` (registers the port with the loopback
  registry and the page bridge as `http.ts`'s server registration does
  today, so a preview reaches it), `connect`/`connect6` (pairs with a
  listening `TCP` on a loopback address; any other host is
  `UV_ECONNREFUSED`, which is what the shim answers today), `onconnection(err,
  clientHandle)`, `getsockname(out)`, `getpeername(out)`, `setNoDelay`,
  `setKeepAlive`, `setSimultaneousAccepts` (0), `open(fd)` (`UV_ENOTSUP`),
  `reset()`.
- `pipe_wrap`: `Pipe(type)` with `constants.SOCKET|SERVER|IPC`,
  `PipeConnectWrap`, `bind(path)`, `listen`, `connect(req, path)` (the .37
  path registry: `UV_ENOENT` when nothing listens, `UV_EADDRINUSE` on a bound
  path), `fchmod` (0), `setPendingInstances` (0), `open(fd)` (the fd of a
  forked child's IPC channel, from the per-child fd table `process_wrap`
  keeps). An IPC pipe's `writeUtf8String(req, string, handle)` delivers the
  string to the peer and, when `handle` is given, sets the peer's
  `pendingHandle` before the peer's `onread`, which is how
  `setupChannel` in `internal/child_process.js` receives a sent handle.
- `process_wrap`: `Process` with `spawn(options)` (`file`, `args`, `cwd`,
  `envPairs`, `stdio` entries of type `pipe`/`ignore`/`inherit`/`fd`/`wrap`
  with their `handle`, `detached`), which starts the engine's run of the
  command the way the shim's `spawn` routes one today (`node`, a registered
  page program, a WALI pack, the shell) with the given `Pipe` handles as its
  stdio, sets `pid`, returns 0 or a `UV_*` code (`UV_ENOENT` when the
  command resolves to nothing); a `pipe` entry past fd 2 is the child's at
  its own number, which an engine `node` child opens by that fd and a
  program the page registered receives as a byte stream in each direction;
  `kill(signal)`; `onexit(exitCode,
  signalCode)` once, when the run ends; `ref()`, `unref()`.
- `spawn_sync`: `spawn(options)` answering `{ status, signal, output: [null,
  stdout, stderr], error, pid }` over the engine's synchronous command door
  (`src/shims/sync-child.ts`), `UV_ENOSYS` in `error` where none exists.
- `tty_wrap`: `isTTY(fd)` and `TTY` for the stdio the engine reports as a
  terminal, and `guessHandleType(fd)` in `internal/util`'s bound object.
- `cares_wrap`: `isIP`, `isIPv4`, `isIPv6` (Node's own from
  `internal/net.js` need only these); lookups stay the engine's `dns`.
- `udp_wrap`, `http_parser`: the classes `internal/child_process.js` names
  in `instanceof` tests, as stubs.

Run ownership: a handle registers with the current run token when it is
created, `ref`/`unref` toggle it, and a run is alive while it holds a ref'd
handle or a pending timer, as libuv's loop is; this replaces the socket and
server registries and the `__ownsHandles` rule of .40. The names the
substrate's bridge and `http.ts` read today (`__ownedServerPorts`,
`_registerServer`, `__releaseOwnedServers`, `__adoptSocket`,
`__pairLoopbackSockets`'s effect) are served by the binding under the same
names until `http` is ported the same way.

## Lanes and the measure

Lane A: the loader, primordials, the internals, `uv`, `stream_wrap`,
`tcp_wrap`, `pipe_wrap`, `cares_wrap`, and `net.js` in the builtin table;
`http.ts` keeps working over it; the substrate's page bridge and upgrade
paths keep working over it. Measure: `node-tests.mjs --match test-net-`
before and after, and every fork test that touches `net`.

Lane B, after A lands: `process_wrap`, `spawn_sync`, `tty_wrap`, the IPC
pipe, `child_process.js` and `internal/child_process.js` in the table; the
shim's `defineCommand('node', …)`, the WALI and page-program routing and the
shell become what `Process.spawn` runs. Measure: `--match
test-child-process-` before and after, and every fork test that forks or
spawns.

The numbers before and after each lane go into `BUILTINS.md`. The
substrate measures the whole in the tab: VS Code's extension host activates
the git extension and Source Control lists the repository.
