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

### What the substrate's kernel now holds (read in ADR-0227 at browser-substrate 1f2ad3666bf)

The kernel is C compiled to wasm, in one shared memory, called in the caller's own worker (§1, §2). It holds every
container's net namespace with its loopback, its TCP and UDP bind tables and its sockets, the bridges, the veth
endpoints and the resolver's table (§8, amended at step 3). Sockets are kinds of open file description, and readiness
is their poll operation, parked on with `Atomics.wait` and woken with `Atomics.notify` (§4); a thread that cannot block
waits with `Atomics.waitAsync` on the object's wait word (§7). Egress belongs to the network: a connect to an address
no namespace holds goes to the bridge and leaves by the egress, whatever process made it (§8). The process table holds
each process's ids (pid, ppid, pgid, sid in its identity block). The resolver Docker's containers name, 127.0.0.11, is
answered on UDP port 53 in the namespace (`packages/wali/src/network-host.ts`, which answers a WALI program's DNS
query from the namespace's table, `dnsResponse`).

### What Tabnode did (read at origin/main caf4b02, release 0.17.1)

- **A namespace of its own making, per container.** ADR-0008's `NetworkNamespace` (`src/network-namespace.ts`): the
  host handed `addresses`, `connect`, `listen` and `resolve`, and the engine did the rest itself. `tcp_wrap` kept a port
  space per namespace id (IPv4, IPv6 and ephemeral maps), paired a connect with a listener of the same engine by
  joining two `LibuvStreamWrap` endpoints, kept an accept queue and a round-robin turn per shared listener, and asked
  the host only for what it did not hold. A run's namespace was tracked by the engine: `runNetworks` per run token,
  inherited at `setRunPid`, an `AsyncLocalStorage` (`networkScope`) for code outside a run, `captureNetworkContext` to
  resume continuations in it, `creatingIn` for host scopes, and `owningContainerNamespace` for a scope given none.
- **A worker's sockets held in another worker.** `NativeStreamScope` (`src/native-stream-owner.ts`) made a process
  realm's TCP handles in the container worker, in the container's namespace, and served them over a channel.
- **HTTP egress around the network.** `installHttpClientTransport` patched every graph's `http.Agent` and
  `https.Agent` `createConnection`: a destination the namespace did not hold was answered by a host HTTP exchange. A
  guest's global `fetch` was `guestFetch` over `installFetchTransport`'s adapter (the substrate's `brokerFetch`, the
  page's relay), else the realm's own browser `fetch`.
- **The rest.** `dns` asked `namespace.resolve`; `os.networkInterfaces` listed `namespace.addresses()`; `dgram` was a
  stub whose sends succeeded and delivered nothing; `tls` paired a destination the namespace held as plaintext marked
  secure and refused every other (`ERR_TLS_UNAVAILABLE`).
- **Identity copied.** `src/process-tokens.ts` kept `pidsOfRuns` (pid, ppid, pgid per run) and `initialIdentity`
  (pid, ppid); `src/shims/process.ts` fixed `process.ppid` as a value when the process object was made.

### The failure class this removes

ADR-0227's top-down table: Rallly runs 40-43, P1001, "no lookup or connect of the schema engine's realm reached its
container's namespace": a socket placed by a second copy of the namespace state outside the kernel. A copy agrees with
the kernel until it does not, and a realm made without its copy silently gets a namespace of its own that reaches
nothing. The identity copies are the same class: a reparented child's `process.ppid` named its dead parent.

## Decision

### 1. A process's socket calls are its kernel's, offered beside its descriptors

A tree that is a client of a kernel offers that kernel's socket calls for the process it serves under
`TREE_SOCKETS`, as it offers its descriptor calls under `TREE_DESCRIPTORS` (ADR-0006 §1, §3a). A socket is a
descriptor of the same table, so its number, `dup`, `close`, `FD_CLOEXEC` and fork inheritance are the kernel's.

The engine takes the calling process's tree as its `fs` binding does: a tree named for one call (`withFilesystem`, how
the engine's own doors act as their container), else the process whose binding scope is executing, else the realm's
process. A socket keeps the calls of the process that made it; an accepted or duplicated socket is its listener's.

Why the tree and not an option of its own: the run's tree is already the process's kernel connection, chosen per run
(`RunOptions.filesystem`, `NodeProcessLaunch.filesystem`, a `spawnSync` child on its parent's tree), and in the
substrate it is `KernelVirtualFS` over that process's kernel channel. A separate `sockets` option would need what
ADR-0008's `network` needed (a per-run map, inheritance at fork, an async-context scope for code outside a run): the
engine's own record of which process is in which namespace, which is the kernel's to know.

### 2. The interface (`src/host-sockets.ts`, exported from the package entry)

```ts
export const TREE_SOCKETS: unique symbol; // Symbol.for('tabnode.tree.sockets')

export interface TreeSockets {
  socket(domain: number, type: number, protocol: number): number;
  bind(fd: number, address: Uint8Array): number;
  listen(fd: number, backlog: number): number;
  accept4(fd: number, flags: number, address: Uint8Array | null): number;
  connect(fd: number, address: Uint8Array): number;
  sendto(fd: number, data: Uint8Array, flags: number, address: Uint8Array | null): number;
  recvfrom(fd: number, buffer: Uint8Array, flags: number, address: Uint8Array | null): number;
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
  `SOL_SOCKET` 1, `SO_*`, `IPPROTO_*`, `TCP_*`, `IP_*`, `IPV6_*`, `F_GETFL` 3, `F_SETFL` 4, `F_DUPFD_CLOEXEC` 1030,
  `O_NONBLOCK` 0o4000, `SHUT_WR` 1), the values `host-sockets.ts` names, which are the same on x86-64 Linux and on
  WALI's wasm32.
- **A result is the call's return: a non-negative value, or a negative errno**, Linux's number, which is libuv's on
  Linux. The engine hands it to Node unchanged: no exception, no allocation, as the kernel's own exports answer.
- **An address is a `struct sockaddr`'s bytes**: `sockaddr_in` (16 bytes) or `sockaddr_in6` (28), little-endian
  family and scope id, port and address in network order, as on Linux. An address the call fills (`accept4`,
  `recvfrom`, `getsockname`, `getpeername`) is given 28 bytes; its family says which it is. The same calls take
  `sockaddr_un` for AF_UNIX without a change here.
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
  - `open(fd)` makes a descriptor it is handed non-blocking; `duplicate` is `F_DUPFD_CLOEXEC`, the same open
    description under a second number, as `SCM_RIGHTS` gives a receiver one.
- **`udp_wrap`, and Node's own `dgram.js` and `internal/dgram.js`** (v24.21.0, vendored unmodified) in place of the
  stub: `bind` (`SO_REUSEADDR` for `UV_UDP_REUSEADDR`, `SO_REUSEPORT`, `IPV6_V6ONLY`), `connect`, `disconnect`
  (a connect to `AF_UNSPEC`), `send` tried at once (`uv_udp_try_send`: taken whole it answers its size plus one) and
  else queued for `POLLOUT`, `recvStart` delivering each datagram (`onmessage(nread, handle, buffer, rinfo)`), and the
  options as their socket options (`SO_BROADCAST`, `IP_TTL`, `IP_MULTICAST_TTL`, `IP_MULTICAST_LOOP`,
  `IP_MULTICAST_IF`, memberships, `SO_RCVBUF` and `SO_SNDBUF`).
- **`dns`**: `/etc/hosts`, `localhost` (RFC 6761) and literals as before, then DNS over UDP to `/etc/resolv.conf`'s
  nameservers in order, each tried `attempts` times for `timeout` seconds (resolv.conf's `options`, glibc's defaults 5
  and 2), A then AAAA as getaddrinfo asks. The answers and errors are the ones the code gave: NXDOMAIN is `ENOTFOUND`
  (getaddrinfo's -3008), NOERROR with no record of the family `ENOTFOUND` -3007 to a lookup and `ENODATA` to a query, a
  server that fails or does not answer `EAI_AGAIN` to a lookup; to a query, c-ares's name for the last failure
  (`ESERVFAIL`, `EREFUSED`, `ENOTIMP`, `EFORMERR` by its rcode, `ECONNREFUSED`, `ETIMEOUT`); queries read A and AAAA
  records, as before, and a held name answers `ENODATA` for any other type; a resolv.conf naming no server is the
  local one (127.0.0.1), as glibc and c-ares take it.
- **`os.networkInterfaces`**: `getifaddrs`, by libuv's `uv_interface_addresses`: interfaces up and running, their IPv4
  and IPv6 addresses, `internal` for a loopback interface, `mac` from the hardware address, `scopeid` from
  `sin6_scope_id`.
- **`tls`**: a client's TLS is its host's TLS client, offered under `TREE_TLS` beside `TREE_SOCKETS`
  (`src/host-tls.ts`), as a Linux process's is the library inside it over a connection the kernel only carries.
  `connect(transport, { servername, ca, rejectUnauthorized, protocols })` starts a handshake over the bytes the engine
  hands it and answers a session: `plain`, the decrypted connection, and `secure`, which settles with `authorized`,
  `authorizationError`, `alpnProtocol`, the server's certificates (DER, the leaf first), `version` and `cipher`, or
  with the failure that ended the handshake. The engine runs it where Node's `lib/internal/tls/wrap.js` (v24.21.0)
  runs OpenSSL: a client `TLSSocket` is a `net.Socket` whose handle is a TLSWrap over the TCP handle of a connection
  it makes with Node's own `net` to any destination (a name with several addresses tries each on a handle of its own,
  `kReinitializeHandle`), or over the socket it was given; the handshake starts once the connection is made, and
  `secureConnect` follows Node's `onConnectSecure`. The roots are the image's `/etc/ssl/certs/ca-certificates.crt`
  and the file `NODE_EXTRA_CA_CERTS` names, read through the process's files, unless the program passes `ca`; the
  client verifies the chain and the name by Node's `checkServerIdentity` rules and ends the handshake on a failure
  unless `rejectUnauthorized` is false (`NODE_TLS_REJECT_UNAUTHORIZED=0` makes it false); a program's own
  `checkServerIdentity` is asked about a chain that verified. `getPeerCertificate` answers each certificate's `raw`
  and fingerprints; `getCipher`, `getProtocol` and `alpnProtocol` are the session's. A tree that offers no TLS client
  is a Node without TLS: a connect fails `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. A TLS server listens as a net server
  and hands its connections on as secure: the engine has no server TLS for a program's own key and certificate, so a
  TLS client of such a server fails its handshake.
- **HTTP**: Node's `http.Agent` and `https.Agent` are unpatched: a request is a `net` or `tls` connection of the
  process. `installHttpClientTransport` and its exchange go.
- **`fetch`**: a guest's global `fetch` is Node's (undici's contract) over the engine's `http` and `https` client, so
  its connections are the process's kernel sockets: redirects followed as `redirect` says (20 at most), the body
  decoded by `content-encoding`, an abort as the signal's reason, every other failure `TypeError: fetch failed` with
  its cause. `data:` and `blob:` URLs, which no socket carries, are the realm's own `fetch`'s. `installFetchTransport`
  and `requestHasStaticBody` go.
- **The page's doors** (`ServerBridge`, `http-bridge`, `container.listenNet`) are a client and a server like any
  other, on the container tree's sockets: a request to a port nothing listens on is refused by the kernel and answered
  503, as before; the bridge learns a guest's port when a handle made through its tree's calls starts listening, an
  announcement of the engine's own handles, not a table of what listens.

### 4. What ADR-0008 kept, and what is deleted

Nothing of ADR-0008's interface remains: `NetworkNamespace`, `NamespaceAddress`, `NamespaceConnection`,
`NamespaceListener`, `ResolverAnswer`, `loopbackOnlyNamespace`, `CONNECT_TIMEOUT_MS`, `RESOLVE_TIMEOUT_MS`, the routing
helpers, `ContainerOptions.network`, `RunOptions.network`, `container.network`, `NodeProcessLaunch.network`,
`NativeStreamScope`'s `network`, TCP through native streams, `tcp_wrap`'s port spaces, pairing, accept queues and
turns, `listenerOnPort`, `watchNamespacePorts`, `container.portPid`, `__bridgeConnection`, the per-run namespace map and
scope, `src/http-client-transport.ts` and `src/fetch-transport.ts`. Its Linux rules (families, bind conflicts, a
dropped route's `ETIMEDOUT`, a wildcard connect reaching the loopback) are the kernel's now. What stays of it is the
resolver's error mapping, in `dns`, now read off DNS messages.

### 5. A process whose tree offers no sockets

A tree with no `TREE_SOCKETS` (`VirtualFS`, a library user's) is a process on a Linux built without IPv4 and IPv6
(`CONFIG_INET` unset): `socket(AF_INET)` and `socket(AF_INET6)` are `EAFNOSUPPORT`, so a listen, connect, bind or send
fails `EAFNOSUPPORT` where libuv makes the socket; there are no interface addresses (`os.networkInterfaces()` is `{}`);
a name resolves from `/etc/hosts`, `localhost` and literals, and otherwise is `EAI_AGAIN` (no server can be asked); a
TLS connect is refused. The engine makes no loopback for it: a loopback of the engine's would answer for a process its
host forgot to connect, which is the class §0 removes.

### 6. Identity is read from the host

- `pid` is fixed for the process's life, as `getpid` is: the run is that process. It stays a value of `process`, as
  Node's is.
- `ppid` is read through the registry at each read (`process.ppid` is an accessor, as Node's calls `uv_os_getppid`).
- `pgid` is the registry's: publication passes a group only where the starter makes one (a detached spawn), and the
  registry gives the inherited one; `kill(0)` and a group signal ask the registry.
- `sid` is read by nothing in Node, so nothing reads it.
- The engine keeps, per run, its pid and the pid of the process whose fork made it, which waits for it (the
  `wait4` caller that `exit` and `reap` name); `pidsOfRuns`' ppid and pgid, `initialIdentity`'s ppid and the fixed
  `process.ppid` are deleted.
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
| `shutdown` | `shutdown(2)` |
| `close` | `close(2)` of the descriptor (the description goes with its last reference), settling its pending waits `POLLNVAL` |
| `getsockname`, `getpeername` | `getsockname(2)`, `getpeername(2)` |
| `getsockopt`, `setsockopt` | `getsockopt(2)`, `setsockopt(2)` |
| `fcntl` | `fcntl(2)` for `F_GETFL`, `F_SETFL` and `F_DUPFD_CLOEXEC` |
| `wait` | the description's poll operation, waited on with `Atomics.waitAsync` on its wait word, settled with `revents` |
| `getifaddrs` | `getifaddrs(3)`'s answer: the namespace's interfaces (RTM_GETLINK, RTM_GETADDR) |

And for identity: its `ProcessRegistry.lookup(pid)` reads the kernel's process table at each call (its
`KernelRealmProcessRegistry` does, from `/proc/<pid>/stat`). It no longer needs to rewrite the realm's initial
identity with its kernel numbers: the engine reads ppid from it.

## Where the evidence stops

- **Read:** Tabnode at caf4b02; browser-substrate at 1f2ad3666bf (ADR-0227 as amended at step 3; `network-host.ts`'s
  DNS answer at port 53; `kernel-realm-process-registry.ts`; `cross-origin-container-worker.ts`); Node v24.21.0's
  `lib/dgram.js`, `lib/internal/dgram.js`, `deps/uv/src/unix/tcp.c`, `stream.c`, `udp.c`, `src/tcp_wrap.cc`,
  `src/udp_wrap.cc`.
- **Not run.** The engine side is written and typechecked; nothing was run against a kernel, and the substrate's
  implementation of `TREE_SOCKETS` does not exist yet (ADR-0227 step 3).
- **Extrapolation:** that one `Atomics.waitAsync` per pending readiness costs what a kernel-side poll costs; that a
  DNS exchange per lookup (no cache, as glibc keeps none) is fast enough for a boot's lookups.
- **Not moved by this record, and still the engine's:** AF_UNIX path sockets and IPC channels (`pipe_wrap`). Until an
  IPC channel is a kernel socketpair carrying `SCM_RIGHTS`, a kernel TCP socket cannot be sent over a channel to a
  process in another worker (before this record it crossed as a native stream).
- **Not built in `udp_wrap`:** IPv6 source-specific multicast membership answers `ENOSYS`: its `struct
  group_source_req` is laid out by the host's word size, which this interface does not fix.
- **Not built in `tls`:** a peer certificate's subject, issuer, names and validity in `getPeerCertificate` (the
  engine decodes no X.509; the host's client verifies), session tickets and their reuse, and a TLS server's own TLS.
  The host's client (browser-substrate's `tls-client.ts`) speaks TLS 1.3 with TLS_AES_128_GCM_SHA256 only.
