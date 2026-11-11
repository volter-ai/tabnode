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
- **`dns`**: Node's `dns.lookup` is `getaddrinfo(3)`, run on libuv's threadpool (`doc/api/dns.md` 1667-1671;
  `src/cares_wrap.cc` 1967-2021, `uv_getaddrinfo`), and its `dns.resolve*` is c-ares, which asks the network and reads
  no `/etc/hosts` (`dns.md` 1680-1690); Node v24.21.0 is the reference.
  - *The decided design for a lookup: the WALI libc's own `getaddrinfo`* (musl, which a WALI program gets), delegated
    to rather than copied. A small C side module, built with browser-substrate ADR-0231's toolchain and loaded by the
    process's `TREE_NATIVE` (ADR-0011 §5, §7), has `uv_getaddrinfo`'s shape: a call that queues a lookup, one of the
    module's own threads that runs `getaddrinfo(name, NULL, &hints, &res)`, and the address list or `EAI_*` code
    written back and woken on the realm's loop through the load's queue. libc then does everything a lookup is: its
    name checks, numeric forms, `/etc/hosts`, search list, `res_msend` and result selection, reading the process's
    `/etc/hosts` and `/etc/resolv.conf` through its kernel's files and asking through its kernel's sockets (the
    namespace's resolver, browser-substrate ADR-0227 §8). Node's own front stays as Node has it, and is Node's own
    code wherever the engine holds it rather than a re-derivation. Node's argument checks come first, before any
    conversion or fast answer, on every door (the engine's `dns` and each process's, callback and promise): a lookup
    checks its name and then its family (`lib/dns.js` 151-202, `internal/dns/promises.js` 197-239) before its empty-name
    or literal answer, the family by Node's own `validateOneOf` on 0, 4 and 6 and then `all` and `verbatim` by its
    own `validateBoolean` (`lib/dns.js` 190-197, `internal/dns/promises.js` 225-232), with the one difference Node's
    doors have: the callback door also takes `'IPv4'` and `'IPv6'` in an options object (`lib/dns.js` 175-189), the
    promise door does not (`internal/dns/promises.js` 220-224). The checks Node runs that need
    `internal/dns/utils.js`, `validateHints` on `options.hints` and `validDnsOrders` for `options.order`, are
    browser-substrate ROADMAP 78's (with the `cares_wrap` binding's `AI_*` constants and the DEP0118 warning), and the
    shim does not run them; and a query checks its record type, by Node's own `validateString`
    and `ERR_INVALID_ARG_VALUE` against the one table of record types the shim answers (`RECORD_TYPES`, whose own keys
    are both what a query admits and the type it asks; `internal/dns/callback_resolver.js` 85-105,
    `internal/dns/promises.js` 353-371), and then that its name is a string (Node's own
    `validateString(name, 'name')`, `internal/dns/callback_resolver.js` 55-63, `internal/dns/promises.js` 341-346)
    before the name is converted; a query's name may still hold a NUL, which the conversion's cut takes. The name is
    validated as `lib/dns.js` validates it
    (`validateStringWithoutNullBytes`, `internal/validators.js`); an empty name answers `null` on a later tick, on the
    callback door as `lib/dns.js` 204-212 and on the promise door as `internal/dns/promises.js` 138-142; an IP literal
    is answered as given where Node's own `isIP` (`internal/net.js`, through `libRequire`) recognises the original
    string (`lib/dns.js` 214-223); the name is converted by Ada's own `ada::idna::to_ascii` (`cares_wrap.cc` 1976),
    compiled to WebAssembly (below), and cut at its first NUL, since Node hands the converted name to its libraries as
    `name.c_str()` (`cares_wrap.cc` 1797-1803, 2020-2021); `EAI_*` is named as Node names it (`EAI_NONAME` and
    `EAI_NODATA` both `ENOTFOUND`, `lib/internal/errors.js` 812-816); and `order` is applied as Node applies it.
  - *`to_ascii` is Ada's own code:* the `ada::idna` section of Node v24.21.0's `deps/ada` amalgamation (Ada 4.0.0,
    `ada.h` 32-240, `ada.cpp` 140-6720; pure C++, no system calls), compiled by wasi-sdk 34.0 to a plain WebAssembly
    module that a process instantiates synchronously on its first lookup (`src/node-lib/binding/ada-idna-wasm.ts`,
    `scripts/build-ada-idna-wasm.sh`). Its one import, WASI's `fd_write` (an assertion's message), answers `ENOSYS`.
    The build script owns its scratch: it makes its own directory with `mktemp -d` and removes it with an `EXIT` trap,
    and takes no argument. An embedded dependency's notice is carried by the repository's shipped notices file,
    `THIRD-PARTY-NOTICES.md`, as every vendored body's is: Ada's is the release licence Node v24.21.0 pins beside it
    (`deps/ada/LICENSE-MIT`, "Copyright 2023 Yagiz Nizipli and Daniel Lemire"), and its linked runtime's (wasi-libc
    with its musl, cloudlibc and dlmalloc notices, libc++, libc++abi and compiler-rt's builtins) are those at the commits
    the wasi-sdk-34 tag pins, each copied there unchanged; the generator's and the generated module's headers point at
    them.
    It is built without `ADA_USE_SIMDUTF`, so its UTF-8 transcoding is Ada's own rather than simdutf's; the input is
    always the well-formed UTF-8 a JavaScript string encodes to, as Node's `Utf8Value` makes it. `url.domainToASCII`
    is a different call in Node (`ada::url::set_hostname` on `ws://x`, `node_url.cc` 224-249), the WHATWG URL host
    parser the realm's `URL` implements, and stays the realm's.
    **Waiting on `TREE_NATIVE` with native threads**, the kernel lane's.
  - *Until then (today):* after Node's front, a lookup reads the process's `/etc/hosts` (an alias matched without
    case and without a trailing dot) and then asks its resolver over the process's kernel UDP sockets, A then AAAA,
    each server in order for `attempts` tries of `timeout` seconds (resolv.conf's `options`, 5 s and 2 by default). A
    name no query can carry is refused before anything is sent, never cut or dropped: an empty name, one of 255 bytes
    or more, an empty label, a label over 63 bytes, or more than 253 bytes after one trailing dot is `ENOTFOUND`
    (errno -3008), as `getaddrinfo` answers it. NXDOMAIN is `ENOTFOUND` -3008, NOERROR with no address of the family
    `ENOTFOUND` -3007, and a server that fails or does not answer `EAI_AGAIN`. The engine answers no name itself:
    `localhost` resolves from the hosts line the image carries, or from the resolver.
  - *A realm with no kernel* (a tree that offers no `TREE_SOCKETS`, so no libc to delegate to) answers IP literals and
    its `/etc/hosts`, and nothing else, as a Linux system without a resolver does: any other name is `EAI_AGAIN`.
  - *Queries* (`dns.resolve*`) keep the shim's own exchange until a separate decision on c-ares, which by the same
    principle is c-ares itself compiled to WebAssembly, not a port: each server in order, `attempts` tries of
    `timeout` seconds; NXDOMAIN `ENOTFOUND`, NOERROR with no record of the type `ENODATA`, a server's failure c-ares's
    name for it (`ESERVFAIL`, `EREFUSED`, `ENOTIMP`, `EFORMERR` by its rcode, `ECONNREFUSED`, `ETIMEOUT`); A and AAAA
    records are read, and a held name answers `ENODATA` for any other type. The name is converted and cut at its first
    NUL as a lookup's is, and one with an empty label other than one trailing dot, a label over 63 bytes or more than
    255 bytes is refused `EBADNAME` (`dns.BADNAME`, "Misformatted host name", `dns.md` 1629) and sends nothing. The rest
    of c-ares's name grammar, its escapes (`ares_dns_name.c`), is that decision's, not the shim's.
  - A resolv.conf naming no server is the local one (127.0.0.1).
- **`os.networkInterfaces`**: `getifaddrs`, by libuv's `uv_interface_addresses`: interfaces up and running, their IPv4
  and IPv6 addresses, `internal` for a loopback interface, `mac` from the hardware address, `scopeid` from
  `sin6_scope_id`.
- **`tls`**: a process's TLS is Node's own `lib/tls.js` and `lib/internal/tls/*.js` over OpenSSL 3.5.8 in the
  realm's node-deps.wasm, driven through memory BIOs as Node's `TLSWrap` drives it (ADR-0016), so it is the library
  inside the process over a connection the kernel only carries, as a Linux process's is. A `TLSSocket` is a
  `net.Socket` whose handle is a TLSWrap over the TCP handle of a kernel connection: one it makes with Node's own `net`
  to any destination, one a TLS server accepted, or the socket it was given (a JavaScript stream through Node's own
  `JSStreamSocket`, ADR-0013 §2). A client's roots are the image's `/etc/ssl/certs/ca-certificates.crt` and the file
  `NODE_EXTRA_CA_CERTS` names, as Node's `--use-openssl-ca` makes them (ADR-0016 §4). A TLS server's port is known to
  the page bridge by its listening handle's owner, a `net.Server` holding Node's `_sharedCreds` SecureContext
  (`listensWithTls`, `node-lib/binding/tls_wrap.ts`); the bridge reaches such a port as a TLS client and sends its
  HTTP inside, and any other port as plain HTTP. It does not verify the server's certificate
  (`rejectUnauthorized: false`), the rule a development server's proxy applies to a local target (Vite's and
  webpack-dev-server's `secure: false`): the page is the person's own, the server is the person's own program on their
  own container's loopback with nothing between the two, and its certificate is a development one no root signs, so
  verifying it would refuse exactly the server being previewed and protect against no one.
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
  in the parent's table, the parent's pipe one end and the child's end the other, which the child's fork copies. The
  child is its host's (ADR-0010 §2: a child of a process with a kernel is always its host's, and none with kernel
  descriptors runs in its parent's realm): it is started with that end at its `NODE_CHANNEL_FD`
  (`NodeProcessLaunch.descriptors`: the host dup2s it in the child's table before the exec closes the close-on-exec
  ones, as `uv__process_child_init` does), and the parent closes its copy.
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
a name resolves from IP literals and its `/etc/hosts` only, and otherwise is `EAI_AGAIN` (no server can be asked;
`localhost` is its hosts file's, §3); a
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
- **Not built in `udp_wrap`:** IPv6 source-specific multicast membership answers `ENOSYS`: the binding does not
  yet lay out `struct group_source_req` in the kernel's WALI form, which is x86-64's (browser-substrate ADR-0227 §2).
- **`tls`** is OpenSSL in `node-deps.wasm` through memory BIOs (ADR-0016 §4); what it does not carry yet is that
  ADR's list, each an open defect, not a platform limit.
