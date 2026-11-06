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
  poll(fds: PollDescriptor[], timeout: number): number; // ADR-0010 §4
  getifaddrs(): readonly InterfaceAddressEntry[];
}

export interface PollDescriptor { readonly fd: number; readonly events: number; revents: number }

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
  `MSG_CMSG_CLOEXEC` 0x40000000, `SOL_SOCKET` 1, `SCM_RIGHTS` 1, `SO_*`, `IPPROTO_*`, `TCP_*`, `IP_*`, `IPV6_*`,
  `F_GETFL` 3, `F_SETFL` 4, `O_NONBLOCK` 0o4000, `SHUT_WR` 1), the values `host-sockets.ts` names, which are the same on x86-64 Linux and on
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
  - a handle holds its run's loop while libuv's would be active (`uv__handle_start`, `uv__handle_stop`): it is made
    stopped (`uv_tcp_init`); `readStart` starts it and `readStop` stops it (`uv_read_start`, `uv_read_stop`); `listen`
    starts it (`uv_listen`); EOF and a read error stop it; `close` releases it. A connect, a queued write and a
    shutdown are requests, each holding the loop for itself (`uv__req_init`) whatever the handle's state or reference,
    until it completes. An accepted or received socket is stopped until it reads or listens, so a paused socket with
    nothing pending lets its process end, as Node's does.
  - The stream rules above are `stream.c`'s, shared with a kernel IPC pipe (§4): `kernel_stream.ts`.
- **`pipe_wrap`'s path sockets** (`uv_pipe_bind2`, `uv_pipe_listen`, `uv_pipe_connect2`, `uv__pipe_close`, read in
  `deps/uv/src/unix/pipe.c`): a pipe that binds or connects to a name is a kernel AF_UNIX stream socket, its address
  a `sockaddr_un` (a path NUL-terminated, an abstract name with its leading NUL and its bytes alone; empty, or longer
  than `sun_path`, `EINVAL`, as Node's `UV_PIPE_NO_TRUNCATE` asks). The kernel makes a path's node at `bind` and
  answers `EADDRINUSE`, `ENOENT` and `ECONNREFUSED`; a bind's `ENOENT` is `EACCES`, as libuv answers, and a refused
  bind leaves no socket. `listen` starts the handle and accepts as TCP's does; a connect completes through its
  request on a later turn (`ECANCELED` where the handle closed first); `fchmod` adds read or write for everyone to the
  bound path's mode (`uv_pipe_chmod`); `close` unlinks a path the handle bound. A pipe opened on an AF_UNIX descriptor of its
  process is that socket. The rest of `stream.c` is the kernel stream's (§4). A stdio pipe is a socketpair as a channel is (ADR-0010).
- **`udp_wrap`, and Node's own `dgram.js` and `internal/dgram.js`** (v24.21.0, vendored unmodified) in place of the
  stub: `bind` (`SO_REUSEADDR` for `UV_UDP_REUSEADDR`, `SO_REUSEPORT`, `IPV6_V6ONLY`), `connect`, `disconnect`
  (a connect to `AF_UNSPEC`), `send` tried at once (`uv_udp_try_send`: taken whole it answers its size plus one) and
  else queued for `POLLOUT`, `recvStart` delivering each datagram (`onmessage(nread, handle, buffer, rinfo)`), and the
  options as their socket options (`SO_BROADCAST`, `IP_TTL`, `IP_MULTICAST_TTL`, `IP_MULTICAST_LOOP`,
  `IP_MULTICAST_IF`, memberships, `SO_RCVBUF` and `SO_SNDBUF`).
- **`dns`**: `dns.lookup` is musl's `getaddrinfo` (1.2.5, the WALI libc), which a WALI program gets, and
  `dns.resolve*` is c-ares (1.34.8 in Node v24.21.0); both exchange DNS over UDP with `/etc/resolv.conf`'s nameservers,
  and a resolv.conf naming none is the local one (127.0.0.1, musl's `resolvconf.c` 86-89). A query asks each server in
  order, `attempts` tries of `timeout` seconds each (resolv.conf's `options`; timeout 5 s and attempts 2 by default):
  this is the shim's own exchange, not c-ares's, whose tries and timeout Node sets itself (`dns.md` 156-159). For a
  query, NXDOMAIN is `ENOTFOUND`, NOERROR with no record of the type `ENODATA`, and a server that fails or does not
  answer gives the name c-ares gives that failure (`ESERVFAIL`, `EREFUSED`, `ENOTIMP`, `EFORMERR` by its rcode,
  `ECONNREFUSED`, `ETIMEOUT`); it reads A and AAAA records, and a held name answers `ENODATA` for any other type. A
  lookup is musl's, below; its errors reach Node as `getaddrinfo`'s: `EAI_NONAME` and `EAI_NODATA` both `ENOTFOUND`
  (`errors.js` 812-816; errno -3008 and -3007), `EAI_AGAIN` itself.
  A name is the one Node hands its libraries and is checked as they check it before any query leaves. Node converts
  every name with `ada::idna::to_ascii` before `getaddrinfo` and before a c-ares query (`src/cares_wrap.cc` 1976 and
  1797), and a name it cannot convert is the empty name. For a lookup, musl answers `EAI_NONAME` for an empty name or
  one of 255 bytes or more, before any source is read (`lookup_name.c` 313-318), and for a name ending in two dots
  (204-206); a name `res_mkquery` will not encode, one longer than 253 bytes after its one trailing dot, with an empty
  label or with a label over 63 bytes (`res_mkquery.c` 15-30), is no answer from DNS (`lookup_name.c` 157-161), and so,
  where the hosts file has not answered it, `EAI_NONAME` (336). A query's name is c-ares's: one trailing dot is the
  root's, and among the names c-ares refuses with `ARES_EBADNAME` are those with an empty label anywhere else, a label
  over 63 bytes, or more than 255 bytes (`ares_dns_name.c` `ares_split_dns_name`, 338-367); Node reports it as
  `EBADNAME` (`dns.BADNAME`, "Misformatted host name", `dns.md` 1629). Such a name sends nothing.
  After Node's own answers for an empty name and an IP literal it recognises (`lib/dns.js` 204-223), a lookup takes
  musl's sources in musl's order (`__lookup_name`, `lookup_name.c` 308-336), with Node's default hints (0):
  - *numeric:* `inet_aton`'s forms are an IPv4 address, `127.1`, `0x7f.1`, `10` and `010.0.0.1` among them (each part
    decimal, `0` octal or `0x` hex, the last part filling the bytes left, `inet_aton.c`); one of the other family is
    `EAI_NODATA` (`lookup_ipliteral.c` 13-22), Node's `ENOTFOUND` -3007. None reaches DNS.
  - *hosts:* `/etc/hosts` as `name_from_hosts` reads it (49-99): a line's text before `#`; the name as given, matched
    exactly and case-sensitively where it stands between white space after the line's first character (`strstr`, so a
    name at the end of a last line with no newline is not matched); the line's first field its address, numeric by
    the same rule; an address of the other family makes the lookup `EAI_NODATA` when no line answers (98), and DNS is
    not asked. `localhost` is answered here or by the resolver, which answers it as RFC 6761 asks (browser-substrate
    ADR-0227 §8); the engine adds no answer of its own.
  - *DNS with the search list:* resolv.conf's `search` or `domain` line (the last one given) and `options ndots:`
    (default 1, at most 15), read as musl's `__get_resolv_conf` reads them (`resolvconf.c`). A name with fewer dots than
    `ndots` and no trailing dot is asked with each search domain first, in order, and then as itself
    (`name_from_dns_search`, 190-232); the first answer that is not "no such name" ends the lookup, an error or a held
    name with no address of the family included (`name_from_dns`, 143-188).
  - *the exchange:* musl's `res_msend` (`res_msend.c` 172-308), once for each name asked, so a lookup with N search
    domains can take up to (N+1) times `timeout`. A and AAAA (one of them where the family is asked) are sent to each
    of the first three servers at the start of each of `attempts` equal slices of `timeout`, the first at once, each
    time only the queries not yet answered (`options timeout:` at most 60 s and `attempts:` at most 10,
    `resolvconf.c`; musl stores an `attempts` of 0 and divides by it, and the shim takes it as 1). A reply from a server it was sent to is matched to
    its query by id and taken when it is NOERROR or NXDOMAIN; SERVFAIL is sent again at once to the server that gave
    it, up to twice the number of queries in a slice, shared among them; FORMERR, NOTIMP and REFUSED are ignored. The
    replies are checked in order, A then AAAA (`lookup_name.c` 174-178): the first that is missing when `timeout` has
    passed makes the lookup `EAI_AGAIN`, so a lone server that answers REFUSED is `EAI_AGAIN` once the timeout has
    passed, not at once, and the first that is NXDOMAIN makes it no answer, whichever comes first; if every reply is
    NOERROR and none holds an address, it is `EAI_NODATA` (186-187). musl takes a truncated reply again over TCP (253-308); the shim does not. That and an
    `attempts` of 0 are the shim's two departures from the exchange.
- **`os.networkInterfaces`**: `getifaddrs`, by libuv's `uv_interface_addresses`: interfaces up and running, their IPv4
  and IPv6 addresses, `internal` for a loopback interface, `mac` from the hardware address, `scopeid` from
  `sin6_scope_id`.
- **`tls`**: a process's TLS is its host's, offered under `TREE_TLS` beside `TREE_SOCKETS` (`src/host-tls.ts`), as a
  Linux process's is the library inside it over a connection the kernel only carries. `connect(transport, {
  servername, ca, rejectUnauthorized, protocols })` starts a client handshake and `serve(transport, { key, cert,
  protocols })` answers one, each over the bytes the engine hands it, and each answers a session: `plain`, the
  decrypted connection, and `secure`, which settles with the handshake's outcome (`alpnProtocol`, `version`, `cipher`;
  a client's `authorized`, `authorizationError` and the server's certificates as Node's `getPeerCertificate`
  describes them, `subject`, `issuer`, `subjectaltname`, `ca`, `valid_from`, `valid_to`, the fingerprints,
  `serialNumber` and `raw`; a server's `servername` from the client's SNI), or with the failure that ended it. The
  engine runs it where Node's `lib/internal/tls/wrap.js` (v24.21.0) runs OpenSSL: a `TLSSocket` is a `net.Socket`
  whose handle is a TLSWrap over the TCP handle of a kernel connection: one it makes with Node's own `net` to any
  destination (a name with several addresses tries each on a handle of its own, `kReinitializeHandle`), one a TLS
  server accepted, or the socket it was given. A client's handshake starts once the connection is made and
  `secureConnect` follows Node's `onConnectSecure`; its roots are the image's `/etc/ssl/certs/ca-certificates.crt` and
  the file `NODE_EXTRA_CA_CERTS` names, read through the process's files, unless the program passes `ca` (or a
  `secureContext` holding one); the client verifies the chain and the name by Node's `checkServerIdentity` rules and
  ends the handshake on a failure unless `rejectUnauthorized` is false (`NODE_TLS_REJECT_UNAUTHORIZED=0` makes it
  false); a program's own `checkServerIdentity` is asked about a chain that verified. A TLS server is a net server
  whose connections are server-side TLS sockets (Node's `tlsConnectionListener`), answered with the program's own
  `key` and `cert` (PEM; an RSA, EC or Ed25519 key); a handshake done is `secureConnection`, one that fails
  `tlsClientError`. A TLS server says, once listening, that its port answers TLS, to the page bridge of the socket
  calls its handle was made with, as `tcp_wrap` tells that bridge the port itself; the bridge reaches such a port as a
  TLS client over its tree's TLS and sends its HTTP inside, and any other port as plain HTTP. It does not verify the
  server's certificate (`rejectUnauthorized: false`), the rule a development server's proxy applies to a local target
  (Vite's and webpack-dev-server's `secure: false`): the page is the person's own, the server is the person's own
  program on their own container's loopback with nothing between the two, and its certificate is a development one no
  root signs, so verifying it would refuse exactly the server being previewed and protect against no one. A tree that
  offers no TLS is a Node without TLS: a handshake fails `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
- **HTTP**: Node's `http.Agent` and `https.Agent` are unpatched: a request is a `net` or `tls` connection of the
  process.
- **`fetch`**: a guest's `fetch`, `Request`, `Response`, `Headers`, `FormData`, `WebSocket`, `CloseEvent` and
  `MessageEvent` are Node's own: undici's bundle as Node v24.21.0 ships it (`deps/undici/undici.js`, vendored byte for
  byte as `internal/deps/undici/undici`), exposed as Node's bootstrap exposes it (`fetch` a value that loads undici at
  its first call, the interfaces lazy accessors). A fetch is undici's over the process's `net` and `tls`, so its
  connections are the process's kernel sockets. A builtin runs with its process's global as `globalThis`, where
  undici keeps its global dispatcher, so a program's own undici's `setGlobalDispatcher` is its `fetch`'s, as on Node,
  and one process's dispatcher is never another's. `data:` URLs are undici's own; a `blob:` URL is resolved through
  `node:buffer`'s `resolveObjectURL`, which answers what the process's `URL.createObjectURL` registered: Node's
  `blob:nodedata:<id>`, held by the process's blob binding (one registry a process, as Node's is one a realm). The
  process's `URL` is the realm's with Node's `createObjectURL` and `revokeObjectURL`. `WebAssembly.compileStreaming` and `instantiateStreaming` take that Response as
  Node's do: the process's `wasm_web_api` binding is given Node's `internal/wasm_web_api.js` callback, which checks the
  Response and pushes its bytes to the realm's streaming compiler.
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
TLS connect is refused. It has no AF_UNIX either (`CONFIG_UNIX` unset): a pipe's bind or connect to a path is
`EAFNOSUPPORT`, and its IPC channels and stdio pipes are the engine's pairing. The engine makes no loopback for it: a loopback of the engine's would answer for a process its
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
| `fcntl` | `fcntl(2)` for `F_GETFL` and `F_SETFL` |
| `wait` | the description's poll operation, waited on with `Atomics.waitAsync` on its wait word, settled with `revents` |
| `poll` | `poll(2)`, blocking the calling worker with `Atomics.wait` (ADR-0010 §4) |
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
- **Not built in `udp_wrap`:** IPv6 source-specific multicast membership answers `ENOSYS`: its `struct
  group_source_req` is laid out by the host's word size, which this interface does not fix.
- **Not built in `tls`:** session tickets and their reuse, client certificates (`requestCert`), SNI contexts
  (`addContext`, `SNICallback`), PFX and encrypted keys. The host's TLS (browser-substrate's `tls-client.ts` and
  `tls-server.ts`) speaks TLS 1.3 with TLS_AES_128_GCM_SHA256 only.
