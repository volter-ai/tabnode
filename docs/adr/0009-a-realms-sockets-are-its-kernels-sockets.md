# ADR-0009: A realm's sockets are its kernel's, called by descriptor, and its identity is read from its host

Status: Accepted. Supersedes ADR-0008 whole.

Date: 2026-11-05. Served: browser-substrate ADR-0227 (the kernel is shared memory and a call runs in its caller), §0
"One process kind", §2, §8 and its "Amended at step 3" block: "A Node realm's sockets are kernel sockets of its
process. Tabnode's `tcp_wrap`, `udp_wrap`, `dns` and HTTP client make their calls into the kernel's socket exports, as a
WALI program's import does; the engine keeps no loopback, port space or pairing of its own, and its fetch broker (the
page's relay) goes. This is a change in Tabnode, recorded there (its ADR on the engine's sockets)." This is that record.
Owner's rule, as relayed: "never work from symptoms or findings, only ever top down from the core architecture."

## Context

### What a process is given on Linux

A process makes its sockets with `socket(2)` in its own network namespace, and every socket is a descriptor of its own
table: one number space with its files (ADR-0006 §3a). The namespace holds its loopback, its bind tables and its
routes; a connect, a listen and a datagram are the kernel's to pair, refuse or route. Name resolution is not a system
call: `getaddrinfo(3)` is libc code that reads `/etc/hosts` and exchanges DNS messages over UDP with the nameservers
`/etc/resolv.conf` names, and Node's `dns.resolve*` (c-ares) does the same exchange. `getifaddrs(3)` is libc too, a
netlink exchange with the kernel. `getpid` never changes over a process's life; `getppid` changes when its parent dies
and it is reparented, and its process group and session change at `setpgid` and `setsid`.

### What the substrate's kernel holds (read in ADR-0227 at browser-substrate 1f2ad3666bf)

The kernel is C compiled to wasm, in one shared memory, called in the caller's own worker (§1, §2). It holds every
container's net namespace with its loopback, its TCP and UDP bind tables and its sockets, the bridges, the veth
endpoints and the resolver's table (§8, amended at step 3). Sockets are kinds of open file description, and readiness
is their poll operation, parked on with `Atomics.wait` and woken with `Atomics.notify` (§4); a thread that cannot block
waits with `Atomics.waitAsync` on the object's wait word (§7). Egress belongs to the network: a connect to an address
no namespace holds goes to the bridge and leaves by the egress, whatever process made it (§8). The process table holds
each process's ids (pid, ppid, pgid, sid in its identity block). The resolver Docker's containers name, 127.0.0.11, is
answered on UDP port 53 in the namespace (`packages/wali/src/network-host.ts`, which answers a WALI program's DNS
query from the namespace's table, `dnsResponse`).

### Why the engine holds no copy

A second copy of the namespace's state outside the kernel agrees with the kernel until it does not, and a realm made
without its copy gets a namespace of its own that reaches nothing. A copied identity is the same: a reparented child's
`ppid` would name its dead parent.

## Decision

### 1. A process's socket calls are its kernel's, offered beside its descriptors

A tree that is a client of a kernel offers that kernel's socket calls for the process it serves under
`TREE_SOCKETS`, as it offers its descriptor calls under `TREE_DESCRIPTORS` (ADR-0006 §1, §3a). A socket is a
descriptor of the same table, so its number, `dup`, `close`, `FD_CLOEXEC` and fork inheritance are the kernel's.

The engine takes the calling process's tree as its `fs` binding does: a tree named for one call (`withFilesystem`, how
the engine's own doors act as their container), else the process whose binding scope is executing, else the realm's
process. A socket keeps the calls of the process that made it; an accepted socket is its listener's, and a received
one the receiver's (§4).

Why the tree and not an option of its own: the run's tree is already the process's kernel connection, chosen per run
(`RunOptions.filesystem`, `NodeProcessLaunch.filesystem`, a `spawnSync` child on its parent's tree), and in the
substrate it is `KernelVirtualFS` over that process's kernel channel. A separate `sockets` option would need a per-run
map, inheritance at fork and an async-context scope for code outside a run: the engine's own record of which process
is in which namespace, which is the kernel's to know.

### 2. The interface (`src/host-sockets.ts`, exported from the package entry)

```ts
export const TREE_SOCKETS: unique symbol; // Symbol.for('tabnode.tree.sockets')

export interface TreeSockets {
  socket(domain: number, type: number, protocol: number): number;
  socketpair(domain: number, type: number, protocol: number, pair: Int32Array): number;
  bind(fd: number, address: Uint8Array): number;
  listen(fd: number, backlog: number): number;
  accept4(fd: number, flags: number, address: Uint8Array | null): number;
  connect(fd: number, address: Uint8Array): number;
  sendto(fd: number, data: Uint8Array, flags: number, address: Uint8Array | null): number;
  recvfrom(fd: number, buffer: Uint8Array, flags: number, address: Uint8Array | null): number;
  sendmsg(fd: number, message: SocketMessage, flags: number): number;
  recvmsg(fd: number, message: SocketMessage, flags: number): number;
  shutdown(fd: number, how: number): number;
  close(fd: number): number;
  getsockname(fd: number, address: Uint8Array): number;
  getpeername(fd: number, address: Uint8Array): number;
  getsockopt(fd: number, level: number, name: number, value: Uint8Array): number;
  setsockopt(fd: number, level: number, name: number, value: Uint8Array): number;
  fcntl(fd: number, command: number, argument: number): number;
  wait(fd: number, events: number): Promise<number>;
  getifaddrs(): readonly InterfaceAddressEntry[];
}

export interface SocketMessage {
  readonly data: Uint8Array;
  readonly control?: Uint8Array | null;
  controlLength?: number;
  flags?: number;
}

export interface InterfaceAddressEntry {
  readonly name: string;
  readonly flags: number;
  readonly address: Uint8Array;
  readonly netmask: Uint8Array;
  readonly hardware?: Uint8Array;
}

export function treeSocketsOf(tree: unknown): TreeSockets | undefined;
```

- **Each call is Linux's call of its name**, with Linux's generic constants (`AF_INET` 2, `AF_INET6` 10, `SOCK_STREAM`
  1, `SOCK_DGRAM` 2, `SOCK_NONBLOCK` 0o4000, `SOCK_CLOEXEC` 0o2000000, `MSG_DONTWAIT` 0x40, `MSG_NOSIGNAL` 0x4000,
  `MSG_CMSG_CLOEXEC` 0x40000000, `SOL_SOCKET` 1, `SCM_RIGHTS` 1, `SO_*`, `IPPROTO_*`, `TCP_*`, `IP_*`, `IPV6_*`, `F_GETFL` 3, `F_SETFL` 4, `F_DUPFD_CLOEXEC` 1030,
  `O_NONBLOCK` 0o4000, `SHUT_WR` 1), the values `host-sockets.ts` names, which are the same on x86-64 Linux and on
  WALI's wasm32.
- **A result is the call's return: a non-negative value, or a negative errno**, Linux's number, which is libuv's on
  Linux. The engine hands it to Node unchanged: no exception, no allocation, as the kernel's own exports answer.
- **An address is a `struct sockaddr`'s bytes**: `sockaddr_in` (16 bytes) or `sockaddr_in6` (28), little-endian
  family and scope id, port and address in network order, as on Linux. An address the call fills (`accept4`,
  `recvfrom`, `getsockname`, `getpeername`) is given 28 bytes; its family says which it is. The same calls take
  `sockaddr_un` for AF_UNIX without a change here.
- **A message is a `struct msghdr`** for a connected socket: one buffer (`msg_iov`) and its control bytes
  (`msg_control`), `struct cmsghdr` records as x86-64 Linux lays them out (a 16-byte header whose `cmsg_len` is eight
  bytes, records 8-byte aligned), which the kernel reads for both images; `recvmsg` sets `controlLength`
  (`msg_controllen`) and `flags` (`msg_flags`). A descriptor an `SCM_RIGHTS` record names is the sender's number; one
  received is installed in the receiver's table and its number is in the record.
- **An option is its value's bytes**: an `int` option four little-endian bytes, `SO_LINGER` a `struct linger`, a
  membership a `struct ip_mreq` or `struct ipv6_mreq`. `getsockopt` answers the option's length.
- **Every socket the engine makes is non-blocking** (`SOCK_NONBLOCK`, `accept4`'s flag, `fcntl(F_SETFL, O_NONBLOCK)`
  for a descriptor it is handed), so no call ever blocks: `EAGAIN` and `EINPROGRESS` say to wait. A kernel call runs
  in the caller's worker and returns (ADR-0227 §2), so the calls are synchronous.
- **Readiness is `wait(fd, events)`**: a promise of the descriptor's `revents`, as `poll(2)` reports them for those
  `events` together with `POLLERR`, `POLLHUP` and `POLLNVAL`, settled once any holds (at once if one already does).
  It never rejects; a descriptor closed while it is waited on settles `POLLNVAL`.
  - *Why a promise per question.* The engine's loop is the realm's JavaScript loop, which cannot block in `poll`; a
    readiness the realm waits for has to arrive as a task. One pending promise is one `Atomics.waitAsync` on the
    object's wait word, the primitive ADR-0227 §7 gives the threads that cannot block.
  - *Why not an epoll set.* An interest list the engine registers and re-arms is a table of the engine's; a question
    asked only while the engine wants the answer (reading, a queued write, a connect in progress, a listener served)
    needs none. An answer that arrives after `readStop` leaves the bytes in the kernel's buffer, where libuv leaves
    them.
- **`getifaddrs` is the one call that is not a descriptor call**: libc's, which Linux answers over a netlink socket
  from the namespace's interfaces. The engine does not speak netlink; the host answers `struct ifaddrs`'s fields
  (`ifa_name`, `ifa_flags`, `ifa_addr`, `ifa_netmask`, and the interface's hardware address from its `AF_PACKET`
  entry). It is a read of the namespace, never a copy of it.
- **No resolver call.** A lookup is a DNS exchange over the process's own UDP socket with the nameservers its
  `/etc/resolv.conf` names (§3). The namespace's resolver is a server in the namespace (127.0.0.11 in a container,
  answered in the kernel for every program), so a Node realm resolves exactly as a WALI program's musl does, and the
  engine holds no table, cache or answer of its own. A host `resolve` call would be a second door to the resolver's
  table that no Linux process has.

### 3. What the engine does with it: libuv's and Node's rules, read as the spec

Read in Node v24.21.0's own sources (`deps/uv/src/unix/tcp.c`, `stream.c`, `udp.c`; `src/tcp_wrap.cc`,
`src/udp_wrap.cc`, `src/stream_base.cc`), the line the engine's vendored library is.

- **`tcp_wrap`** (`uv__tcp_bind`, `uv__tcp_connect`, `uv__tcp_listen`, `uv__server_io`, `uv__read`, `uv__write`,
  `uv__drain`, `uv__stream_connect`):
  - the socket is made at `bind`, `connect` or `listen`, of the address's family (`maybe_new_socket`), `listen` on an
    unbound handle making an AF_INET one;
  - `bind` sets `SO_REUSEADDR`, `SO_REUSEPORT` for `UV_TCP_REUSEPORT` and `IPV6_V6ONLY` per `UV_TCP_IPV6ONLY` on an
    IPv6 socket; `UV_TCP_IPV6ONLY` on an IPv4 address is `EINVAL`; bind's `EAFNOSUPPORT` is `EINVAL`; bind's
    `EADDRINUSE` is held (`delayed_error`) and returned by `listen` or a connect's callback, so Node says
    `listen EADDRINUSE`;
  - a connect's `EINPROGRESS` waits for `POLLOUT` and reads `SO_ERROR`; an immediate `ECONNREFUSED` is the callback's;
    any other error is the call's;
  - a listener accepts one connection per readiness (`accept4`, non-blocking and close-on-exec) and hands it to
    `onconnection`; an accept error waits for the next readiness;
  - a read is a `recvfrom` of up to 64 KiB, at most 32 per readiness, stopping at a short read; 0 is EOF (and the
    handle stops); an error is delivered as the read's status;
  - a write is tried at once (`uv_try_write`): taken whole, it completes synchronously (`kLastWriteWasAsync` 0);
    otherwise what remains is queued, sent on `POLLOUT` and completed through the request; `MSG_NOSIGNAL`, as Node
    ignores `SIGPIPE`, so a closed peer is `EPIPE`;
  - `shutdown` follows the queued writes (`SHUT_WR`); `close` completes a pending connect, the queued writes and a
    pending shutdown with `ECANCELED` before its own callback; `reset` sets `SO_LINGER` {1, 0} and closes;
  - `setNoDelay` is `TCP_NODELAY`, `setKeepAlive` `SO_KEEPALIVE` with `TCP_KEEPIDLE`, `TCP_KEEPINTVL` and
    `TCP_KEEPCNT` (`uv__tcp_keepalive`), each remembered and applied when the socket is made (`uv__stream_open`);
    `getsockname` and `getpeername` answer a held bind error first;
  - `open(fd)` makes a descriptor it is handed non-blocking.
  - The stream rules above are `stream.c`'s, shared with a kernel IPC pipe (§4): `kernel_stream.ts`.
- **`udp_wrap`, and Node's own `dgram.js` and `internal/dgram.js`** (v24.21.0, vendored unmodified) in place of the
  stub: `bind` (`SO_REUSEADDR` for `UV_UDP_REUSEADDR`, `SO_REUSEPORT`, `IPV6_V6ONLY`), `connect`, `disconnect`
  (a connect to `AF_UNSPEC`), `send` tried at once (`uv_udp_try_send`: taken whole it answers its size plus one) and
  else queued for `POLLOUT`, `recvStart` delivering each datagram (`onmessage(nread, handle, buffer, rinfo)`), and the
  options as their socket options (`SO_BROADCAST`, `IP_TTL`, `IP_MULTICAST_TTL`, `IP_MULTICAST_LOOP`,
  `IP_MULTICAST_IF`, memberships, `SO_RCVBUF` and `SO_SNDBUF`).
- **`dns`**: `/etc/hosts`, `localhost` (RFC 6761) and literals, then DNS over UDP to `/etc/resolv.conf`'s
  nameservers in order, each tried `attempts` times for `timeout` seconds (resolv.conf's `options`, glibc's defaults 5
  and 2), A then AAAA as getaddrinfo asks. The answers and errors are the ones the code gave: NXDOMAIN is `ENOTFOUND`
  (getaddrinfo's -3008), NOERROR with no record of the family `ENOTFOUND` -3007 to a lookup and `ENODATA` to a query, a
  server that fails or does not answer `EAI_AGAIN` to a lookup; to a query, c-ares's name for the last failure
  (`ESERVFAIL`, `EREFUSED`, `ENOTIMP`, `EFORMERR` by its rcode, `ECONNREFUSED`, `ETIMEOUT`); queries read A and AAAA
  records, and a held name answers `ENODATA` for any other type; a resolv.conf naming no server is the
  local one (127.0.0.1), as glibc and c-ares take it.
- **`os.networkInterfaces`**: `getifaddrs`, by libuv's `uv_interface_addresses`: interfaces up and running, their IPv4
  and IPv6 addresses, `internal` for a loopback interface, `mac` from the hardware address, `scopeid` from
  `sin6_scope_id`.
- **`tls`**: the engine has no TLS. A TLS connect is a plaintext connection marked secure where nothing lies between
  the two ends: a destination on a directly connected network (loopback, or on an interface's network by its netmask,
  read from `getifaddrs` after a lookup); any other is `ERR_TLS_UNAVAILABLE`, as before. This is the old rule with the
  namespace's routing read from the process's interfaces.
- **HTTP**: Node's `http.Agent` and `https.Agent` are unpatched: a request is a `net` or `tls` connection of the
  process. `installHttpClientTransport` and its exchange go.
- **`fetch`**: a guest's global `fetch` is Node's (undici's contract) over the engine's `http` and `https` client, so
  its connections are the process's kernel sockets: redirects followed as `redirect` says (20 at most), the body
  decoded by `content-encoding`, an abort as the signal's reason, every other failure `TypeError: fetch failed` with
  its cause. `data:` and `blob:` URLs, which no socket carries, are the realm's own `fetch`'s. `installFetchTransport`
  and `requestHasStaticBody` go.
- **The page's doors** (`ServerBridge`, `http-bridge`, `container.listenNet`) are a client and a server like any
  other, on the container tree's sockets: a request to a port nothing listens on is refused by the kernel and answered
  503; the bridge learns a guest's port when a handle made through its tree's calls starts listening, an
  announcement of the engine's own handles, not a table of what listens.

### 4. A handle crosses an IPC channel as `SCM_RIGHTS`

Node's IPC channel is an AF_UNIX stream socket, and libuv sends a handle over it with `uv_write2`: a `sendmsg` whose
`SCM_RIGHTS` record names the handle's descriptor; the receiver's `recvmsg` installs the description in its own table
(`scm_detach_fds`) and `OnUvRead` hands the next read's callback a handle of the descriptor's type (`uv_pipe_pending_type`,
`uv_accept`). The engine does the same over the kernel's calls (read in Node v24.21.0's `deps/uv/src/unix/stream.c`,
`process.c` and `src/stream_wrap.cc`):

- **The channel is a socketpair.** An IPC pipe of a process whose tree offers socket calls is a kernel AF_UNIX socket.
  `spawn` makes the channel as `uv_spawn`'s `UV_CREATE_PIPE` does: `socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC)`
  in the parent's table, the parent's pipe one end and the child's end the other, which the child's fork copies. A
  child its parent's realm runs on its parent's tree opens that end; a child a host runs in another realm is started
  with it at its `NODE_CHANNEL_FD` (`NodeProcessLaunch.descriptors`: the host dup2s it in the child's table before the
  exec closes the close-on-exec ones, as `uv__process_child_init` does), and the parent closes its copy.
- **A send is `sendmsg`.** A write that carries a handle sends the handle's descriptor (`uv__handle_fd`: a TCP, UDP
  or kernel pipe's) in an `SCM_RIGHTS` record with the write's first bytes, queued behind earlier writes and written
  at once where none is; a handle with no kernel descriptor is `EBADF`, a handle on a pipe that is not IPC `EINVAL`.
  The kernel holds a reference to the description while the message is in flight, so the sender's close after
  `NODE_HANDLE_ACK` ends nothing the receiver holds.
- **A receive is `recvmsg`** with `MSG_CMSG_CLOEXEC` and room for 64 descriptors (`UV__CMSG_FD_COUNT`). Each received
  descriptor is the receiver's; it waits in the pipe's queue (`queued_fds`), and each read that delivers bytes takes the
  next one as `pendingHandle`, a handle of its socket's type (`SO_TYPE`, `SO_DOMAIN`: TCP, UDP or a kernel pipe) opened
  on it in the receiver's process and counted in its loop. A descriptor of no handle type, and one still queued when
  the pipe closes, is closed.
- **Lifetime is the kernel's.** A received socket is a descriptor of the receiver's table: it lives until the receiver
  closes it or exits, whatever the sender does; a listening one is listened on again (`listen` on a listening socket
  sets its backlog), and both ends accept from its one queue.
- **A tree that offers no sockets** keeps the engine's pairing for its channels, and a pipe crosses one as a duplicate
  of the pairing; such a process has no kernel descriptor to send.

### 5. A process whose tree offers no sockets

A tree with no `TREE_SOCKETS` (`VirtualFS`, a library user's) is a process on a Linux built without IPv4 and IPv6
(`CONFIG_INET` unset): `socket(AF_INET)` and `socket(AF_INET6)` are `EAFNOSUPPORT`, so a listen, connect, bind or send
fails `EAFNOSUPPORT` where libuv makes the socket; there are no interface addresses (`os.networkInterfaces()` is `{}`);
a name resolves from `/etc/hosts`, `localhost` and literals, and otherwise is `EAI_AGAIN` (no server can be asked); a
TLS connect is refused. The engine makes no loopback for it: a loopback of the engine's would answer for a process its
host did not connect, a namespace the kernel does not hold.

### 6. Identity is read from the host

- `pid` is fixed for the process's life, as `getpid` is: the run is that process. It stays a value of `process`, as
  Node's is.
- `ppid` is read through the registry at each read (`process.ppid` is an accessor, as Node's calls `uv_os_getppid`).
- `pgid` is the registry's: publication passes a group only where the starter makes one (a detached spawn), and the
  registry gives the inherited one; `kill(0)` and a group signal ask the registry.
- `sid` is read by nothing in Node, so nothing reads it.
- The engine keeps, per run, its pid and the pid of the process whose fork made it, which waits for it (the
  `wait4` caller that `exit` and `reap` name).
- A realm with no host registry keeps `process-registry.ts`'s own table: there it is the process table, not a copy,
  as `VirtualFS` is such a realm's tree; a kernel with no network still has processes.

### 7. What the substrate provides

Each method is its Linux call, answered in the caller's worker from kernel memory, for the process whose tree it is.

| Method | Linux call |
|---|---|
| `socket` | `socket(2)` in the process's net namespace, into its descriptor table, lowest free number |
| `bind` | `bind(2)` against the namespace's bind tables |
| `listen` | `listen(2)` |
| `accept4` | `accept4(2)` from the listener's backlog, filling the peer's address |
| `connect` | `connect(2)`: paired in the kernel, refused, routed over a bridge, or queued to the network bridge for egress |
| `sendto` | `sendto(2)` |
| `recvfrom` | `recvfrom(2)`, filling the source address |
| `socketpair` | `socketpair(2)` of AF_UNIX, both ends in the caller's table |
| `sendmsg` | `sendmsg(2)`: an `SCM_RIGHTS` record's descriptors held in flight (`scm_fp_copy`) |
| `recvmsg` | `recvmsg(2)`: received descriptors installed in the caller's table (`scm_detach_fds`), the record filled |
| `shutdown` | `shutdown(2)` |
| `close` | `close(2)` of the descriptor (the description goes with its last reference), settling its pending waits `POLLNVAL` |
| `getsockname`, `getpeername` | `getsockname(2)`, `getpeername(2)` |
| `getsockopt`, `setsockopt` | `getsockopt(2)`, `setsockopt(2)` |
| `fcntl` | `fcntl(2)` for `F_GETFL`, `F_SETFL` and `F_DUPFD_CLOEXEC` |
| `wait` | the description's poll operation, waited on with `Atomics.waitAsync` on its wait word, settled with `revents` |
| `getifaddrs` | `getifaddrs(3)`'s answer: the namespace's interfaces (RTM_GETLINK, RTM_GETADDR) |

And for a child's start: a Node child admitted with `NodeProcessLaunch.descriptors` has each `fd` made, in its own
table, a `dup2` of its fork's copy of `from` before its exec closes the close-on-exec ones (`readyKernelChild`).

And for identity: its `ProcessRegistry.lookup(pid)` reads the kernel's process table at each call (its
`KernelRealmProcessRegistry` does, from `/proc/<pid>/stat`), and the engine reads ppid from it at each read.

## Where the evidence stops

- **Read:** Tabnode at caf4b02; browser-substrate at 1f2ad3666bf (ADR-0227 as amended at step 3; `network-host.ts`'s
  DNS answer at port 53; `kernel-realm-process-registry.ts`; `cross-origin-container-worker.ts`); Node v24.21.0's
  `lib/dgram.js`, `lib/internal/dgram.js`, `lib/internal/child_process.js`, `deps/uv/src/unix/tcp.c`, `stream.c`,
  `udp.c`, `process.c`, `src/tcp_wrap.cc`, `src/udp_wrap.cc`, `src/stream_wrap.cc`; browser-substrate's kernel at
  58adec4e358 (`socket.c`'s `msghdr_from_user`, `scm_rights_read`, `scm_detach`, `do_socketpair`).
- **Not run.** The engine side is written and typechecked, and the substrate's `TREE_SOCKETS` is written
  (`packages/node/src/kernel-tree-sockets.ts` on browser-substrate's `kernel-step2-realm-sockets`); nothing was run
  against a kernel.
- **Extrapolation:** that one `Atomics.waitAsync` per pending readiness costs what a kernel-side poll costs; that a
  DNS exchange per lookup (no cache, as glibc keeps none) is fast enough for a boot's lookups.
- **Still the engine's:** AF_UNIX path sockets (`pipe_wrap`'s `bind`, `listen` and `connect` to a path). Such a pipe
  has no kernel descriptor, so it cannot cross a kernel IPC channel (`EBADF`), and `net.Socket({ fd })` on an
  inherited AF_UNIX descriptor is not opened.
- **Not built in `udp_wrap`:** IPv6 source-specific multicast membership answers `ENOSYS`: its `struct
  group_source_req` is laid out by the host's word size, which this interface does not fix.
- **Lost reach, named:** HTTPS to anything beyond a directly connected network fails `ERR_TLS_UNAVAILABLE` (for
  `fetch`, `TypeError: fetch failed` with that cause); before this record it left by the host's exchange. The network
  design needs the client to speak TLS (the egress terminates a twinned host's TLS and tunnels a granted one), so the
  next record is TLS in the engine over its sockets.
