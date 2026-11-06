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
`fs`), `internal/process/permission` (`isEnabled` false). `dgram.js` and
`internal/dgram.js` are Node's own (v24.21.0), vendored. Public modules
resolve to the engine's shims: `buffer`, `events`, `stream`, `timers`, `dns`,
`cluster`, `diagnostics_channel`.

## The binding

One directory, `src/node-lib/binding/`, one file per `internalBinding` name.
A TCP, UDP or AF_UNIX socket is the calling process's kernel's, made
through the socket calls its tree offers (`TREE_SOCKETS`,
`src/host-sockets.ts`, ADR-0009): the engine keeps no port, path, loopback,
listener table or pairing of its own for them, and an IPC channel of such a
process is a kernel AF_UNIX socketpair whose handles cross as `SCM_RIGHTS`
(ADR-0009 §4). A child of such a process gets its stdio as libuv makes it,
in the parent's kernel table: a `pipe` a socketpair, `inherit` or a number
the parent's descriptor, `ignore` /dev/null, placed at the child's numbers
by the host that runs it as its own process (ADR-0010). What else the engine
does for a child stays and is the binding's implementation: the stdio pipes
and IPC channel of a process with no socket calls, the page bridge that hears a listening port and routes a
preview's requests and upgrades, the routing of a spawned command to the engine's
`node`, a page-registered program, a WALI pack or the shell, and the run
ownership that keeps a run alive while it holds a handle.

- `uv`: `errname(code)`, `getErrorMap()`, and the `UV_*` constants Node's
  files read, with Linux numbers (`UV_EOF` -4095, `UV_ECONNREFUSED` -111,
  `UV_ECONNRESET` -104, `UV_EADDRINUSE` -98, `UV_ENOENT` -2, `UV_ENOTSOCK`
  -88, `UV_EPIPE` -32, `UV_EACCES` -13, `UV_EINVAL` -22, `UV_ENOTCONN` -107,
  `UV_EAGAIN` -11, `UV_ECANCELED` -125, `UV_EMFILE` -24, `UV_ENOSYS` -38,
  `UV_ESRCH` -3, `UV_EADDRNOTAVAIL` -99, `UV_EHOSTUNREACH` -113,
  `UV_ENETUNREACH` -101).
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
- `tcp_wrap`: `TCP(type)` with `constants.SOCKET|SERVER|UV_TCP_IPV6ONLY|UV_TCP_REUSEPORT`,
  `TCPConnectWrap` (`oncomplete(status, handle, req, readable, writable)`),
  over the process's socket calls, with libuv's rules (Node v24.21.0's
  `deps/uv/src/unix/tcp.c` and `stream.c`): the socket made at `bind`,
  `connect` or `listen`, non-blocking; `bind`/`bind6` with `SO_REUSEADDR`,
  `SO_REUSEPORT` and `IPV6_V6ONLY` as the flags say, its `EADDRINUSE` said by
  `listen`; `connect`/`connect6` completed when the socket is writable, from
  `SO_ERROR`; `listen(backlog)` accepting one connection per readiness into
  `onconnection(err, clientHandle)`; reads of 64 KiB, 32 per readiness; a
  write tried at once and queued for writability; `shutdown` after the queue;
  `getsockname(out)`, `getpeername(out)`, `setNoDelay`, `setKeepAlive`,
  `setTypeOfService`/`getTypeOfService`, `open(fd)` (a descriptor of the
  process's own), `reset()` (`SO_LINGER` {1, 0}). A process whose tree offers no socket calls has no IPv4
  or IPv6: making a socket is `EAFNOSUPPORT`.
- `udp_wrap`: `UDP` and `SendWrap` under Node's own `dgram.js`, over the same
  calls, with libuv's `udp.c` rules: the socket bound at the first bind,
  connect, send or receive; a send tried at once (its size plus one) or
  queued; `onmessage(nread, handle, buffer, rinfo)` per datagram; the options
  as socket options.
- `pipe_wrap`: `Pipe(type)` with `constants.SOCKET|SERVER|IPC`,
  `PipeConnectWrap`, `bind(path)`, `listen`, `connect(req, path)` (a kernel
  AF_UNIX socket of the process on a `sockaddr_un`: the kernel makes the
  path's node and answers `ENOENT`, `ECONNREFUSED` and `EADDRINUSE`; a
  process with no socket calls has none, `EAFNOSUPPORT`), `fchmod` (0),
  `setPendingInstances` (0), `open(fd)` (the fd of a forked child's IPC
  channel, from the per-child fd table `process_wrap` keeps, or a kernel
  descriptor). An IPC pipe of a process with socket calls is a kernel
  AF_UNIX socket too (`kernel_stream.ts`): `writeUtf8String(req,
  string, handle)` is a `sendmsg` carrying the handle's descriptor, and each
  descriptor a `recvmsg` brings becomes the `pendingHandle` of a read's
  `onread`, which is how `setupChannel` in `internal/child_process.js`
  receives a sent handle. On the engine's pairing the handle is a duplicate
  of another pairing, set on the peer before its `onread`.
- `process_wrap`: `Process` with `spawn(options)` (`file`, `args`, `cwd`,
  `envPairs`, `stdio` entries of type `pipe`/`ignore`/`inherit`/`fd`/`wrap`
  with their `handle`, `detached`), which starts the engine's run of the
  command the way the shim's `spawn` routes one today (`node`, a registered
  page program, a WALI pack, the shell) with the given `Pipe` handles as its
  stdio, sets `pid`, returns 0 or a `UV_*` code (`UV_ENOENT` when the
  command resolves to nothing); a `pipe` entry past fd 2 is the child's at
  its own number, which an engine `node` child opens by that fd and a
  program the page registered receives as a byte stream in each direction;
  a child that is the engine's `node` (by name or by `process.execPath`) is
  started from its argv by the same launch as `container.runNode`, not as a
  shell line, and its fds 0, 1 and 2 carry the bytes written to them, as a
  pipe does; a shell builtin's output is the shell's text;
  `kill(signal)`; `onexit(exitCode,
  signalCode)` once, when the run ends; `ref()`, `unref()`.
- `spawn_sync`: `spawn(options)` answering `{ status, signal, output: [null,
  stdout, stderr], error, pid }` over the engine's synchronous command door
  (`src/shims/sync-child.ts`), `UV_ENOSYS` in `error` where none exists.
- `tty_wrap`: `isTTY(fd)` and `TTY` for the stdio the engine reports as a
  terminal, and `guessHandleType(fd)` in `internal/util`'s bound object; a
  run's terminal's size and fd 0's mode (`setRawMode`) are its host's
  (`RunStreams.terminal`, ADR-0010 §3).
- `cares_wrap`: `isIP`, `isIPv4`, `isIPv6` (Node's own from
  `internal/net.js` need only these); lookups are the engine's `dns`, a DNS
  exchange over the process's own UDP with its `/etc/resolv.conf`'s
  nameservers, as getaddrinfo and c-ares make it.

Run ownership: a handle registers with the current run token when it is
created, `ref`/`unref` toggle it, and a run is alive while it holds a ref'd
handle or a pending timer, as libuv's loop is; this replaces the socket and
server registries and the `__ownsHandles` rule of .40. The names the
substrate's bridge and `http.ts` read today (`__ownedServerPorts`,
`_registerServer`, `__releaseOwnedServers`, `__adoptSocket`,
`__pairLoopbackSockets`'s effect) are served by the binding under the same
names until `http` is ported the same way.

## The process's sockets

A realm's process makes its sockets in its own network namespace, which is its
kernel's, through the socket calls its tree offers (ADR-0009,
`src/host-sockets.ts`): `socket`, `bind`, `listen`, `accept4`, `connect`,
`sendto`, `recvfrom`, `socketpair`, `sendmsg`, `recvmsg`, `shutdown`,
`close`, `getsockname`, `getpeername`,
`getsockopt`, `setsockopt`, `fcntl`, each Linux's call by descriptor with a
negative errno for a failure; `wait(fd, events)`, a promise of the
descriptor's poll readiness; and `getifaddrs()`. The engine knows nothing of
which namespaces exist, what listens or where a connect goes: a refusal, a
route, a drop and an egress are the kernel's. A handle keeps the calls of the
process that made it, an accepted one its listener's, a received one its
receiver's. HTTP is a `net` or `tls` connection like any other (a process's
TLS, client and server, is its host's, `TREE_TLS`), and a guest's `fetch` is Node's own
undici over the process's `net` and `tls`, so nothing leaves around the
network.

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
