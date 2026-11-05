# ADR-0008: A realm lives in the network namespace its host gives it

Status: Superseded by ADR-0009 (a realm's sockets are its kernel's, called by descriptor).

Date: 2026-11-04. Constitution Article 6 (correct toward Node's own behaviour). Owner: "now the way that the tab runs
things is done like on a real computer right? instead of magically"; "we dont' want any one offs everything has to
fit into the ontology and catagories".

## Context

A process on Linux lives in one network namespace (`network_namespaces(7)`): its own loopback, its own port space,
the addresses its interfaces hold, the routes out of it and the resolver its `/etc/resolv.conf` names. Docker gives
each container one, joins it to bridges (172.17.0.0/16, then 172.18–31.0.0/16), answers names at 127.0.0.11 by the
networks the asker shares, and isolates bridges from one another by dropping their packets: read 2026-11-04 on the
installed Docker (colima, `alpine:latest`), a TCP connect from a container on one user network to a container's
address on another got no answer for the 20 s `nc -w 20` allowed ("Operation timed out"), where a closed port on a
shared network refused at once; so a connect across bridges fails `ETIMEDOUT` once Linux stops retrying its SYN
(about 127 s, `tcp_syn_retries` 6). The reading stopped at 20 s; the 127 s is Linux's documented retry schedule, not
read.

browser-substrate's WALI kernel gives its programs exactly that (its `container-networks.ts` is the one table). A
Node realm in a Compose service is a process of that container too, so it holds the address, ports and names its
container holds, as the container's other programs do.

## Decision

The engine does not know what namespaces exist or how they are wired; that is its host's, as it is the kernel's and
the container runtime's on a computer. The host hands each realm its `NetworkNamespace` (`src/network-namespace.ts`),
and `tcp_wrap`, `dns`, `os`, `tls` and HTTP's Agent read it. A namespace is never the engine's: it is a container's,
held by the container (`container.network`) and by each of its runs, so two containers in one page are in their own.

```ts
interface NetworkNamespace {
  readonly id: string;                                   // one id: one loopback, one port space
  addresses(): readonly NamespaceAddress[];              // { address, prefixLength, interface?, mac? }, eth0 first
  connect(address: string, port: number, family: 4 | 6): NamespaceConnection | Promise<NamespaceConnection>;
  listen(listener: NamespaceListener): number | (() => void);
  resolve(name: string, family: 4 | 6): ResolverAnswer | Promise<ResolverAnswer>;
}
type NamespaceConnection = number                           // a libuv status: refused as the kernel refuses it
  | { namespace: string; source: string }                   // a listener of another namespace this engine serves
  | { source: string; accept(socket: net.Socket): void };  // a listener the host holds
interface NamespaceListener { port; address; family; open(from: { address; port }, to: string): net.Socket | number }
type ResolverAnswer = readonly string[] | undefined;        // [] = NOERROR with no record, undefined = NXDOMAIN
```

Where the host supplies it:

- `createContainer({ network })`: the container's namespace. Every run the container starts begins in it, unless the
  host names another for that run (`RunOptions.network`), whatever namespace the frame that started the run carried, and every process a run forks keeps its parent's
  (`setRunPid`), as fork(2) does; a `node` the run launches through its host is handed it
  (`NodeProcessLaunch.network`). The container's own code (`execute`, `runFile`) runs in it with every continuation
  it makes, and its own doors (`listenNet`, its page bridge) make their sockets in it.
  A container given none has a fresh namespace of its loopback alone (`loopbackOnlyNamespace()`), its own.
- `new NativeStreamScope(limits, emit, ownerPid, network)`: the namespace of a process whose sockets this engine holds
  for another worker. Every TCP handle the scope makes is made in it. A scope given none is in its owning container's:
  that of the code that made it, else the engine's one live container's (a disposed or collected container is no
  owner), else, with no container, the run-less namespace a bare Runtime's code is in; an engine of several
  containers names it.
  That process's own realm, whose `net` handles are the scope's, reads the same namespace for `dns`, `os`, `tls` and
  HTTP's Agent from its bootstrap: its host makes the realm's container with the namespace (`createContainer({
  network })`), so the realm's runs are in it.
- The engine's own continuations (a resolver's answer, a lookup's callback, a routing decision answered later, in
  which Node's `net.js` makes a `listen(port, host)` handle and HTTP's Agent and `tls` make their sockets) run in the
  context of the call that began them: its run and its namespace (`captureNetworkContext`).
- A socket, lookup or interface list made outside any container's code and any host scope is in a namespace of its
  own that reaches nothing; a page bridge made outside a container answers for the namespace it was made in.

What the engine does with it:

- **A socket keeps the namespace it was made in.** Each namespace has its own port space (IPv4, IPv6 and ephemeral),
  so two realms each listen on 5432. Families are Linux's: an IPv4 bind takes the IPv4 port, a dual-stack `::` bind
  both, an `ipv6Only` or address-specific IPv6 bind (`::1`) the IPv6 port alone; an IPv4 connect reaches the IPv4
  port's listener, an IPv6 one the IPv6 port's (an IPv4-mapped address the IPv4 port's); a listener bound to one
  address takes connections to that address alone (127.0.0.1, not 127.0.0.2 or ::1); a connect to a wildcard is to
  its family's loopback. Addresses compare in their canonical form (RFC 5952; an IPv4-mapped address as IPv4).
- **bind** takes a wildcard, a loopback address or one of the namespace's addresses; any other is `EADDRNOTAVAIL`.
- **listen** tells the host (`listen`), which may refuse it with a libuv status (`EADDRINUSE` where the host holds the
  port itself; libuv reports a bind conflict at listen, so Node's error is `listen EADDRINUSE` either way). The host
  keeps the returned function and calls it when the socket stops listening. It opens connections to the listener with
  `open(from, to)`, through whichever descriptor of the socket still listens (a passed server's); a listener bound to
  the loopback is not reached at the namespace's address. A host whose `listen` throws fails the listen (`EIO`).
- **connect** to the namespace's own loopback or addresses goes to its own listener on the port. Every other connect,
  and an own-address connect no listener in this engine takes, is the host's to route (`connect`). The host answers
  with another namespace this engine serves (the connection is paired here), a listener the host holds (the far end is
  handed to it as a `net.Socket`), or a failure: `ECONNREFUSED`, `ETIMEDOUT` where the route drops the packets (across
  Docker's isolated bridges), or `ENETUNREACH` with no route. The connection leaves by the `source` the route names,
  which is what both ends read. A host failure is one failed socket and nothing else: a `connect` that throws or whose
  answer rejects is `ECONNREFUSED`, one that has not answered within Linux's SYN retries (`CONNECT_TIMEOUT_MS`,
  127 s) is `ETIMEDOUT`, and an `accept` that throws resets the connection. The wait ends with the socket; a host
  listener answered after the socket timed out or closed is handed an end that closes at once, so the host releases
  it through its own door.
- **dns.lookup** reads the process's `/etc/hosts` and answers `localhost` and IP literals. It then asks the
  namespace's resolver for A, then AAAA records, as getaddrinfo does. `dns.resolve*` is a query to that resolver: a
  name it does not hold is `ENOTFOUND`, and a held name with no record of the type is `ENODATA`. Nothing resolves to
  the loopback unless the resolver says so. A lookup's `ENOTFOUND` carries getaddrinfo's errno: -3008 (EAI_NONAME)
  for a name nobody holds, -3007 (EAI_NODATA) for a held name with no address of the asked family. A resolver that
  fails, or has not answered within resolv.conf's timeouts (`RESOLVE_TIMEOUT_MS`, 10 s), is `EAI_AGAIN` to a lookup
  and `ESERVFAIL` / `ETIMEOUT` to a query; an rrtype Node does not know is `ERR_INVALID_ARG_VALUE`, thrown.
  `getServers()` is the process's `/etc/resolv.conf`'s nameservers (127.0.0.11 in a Docker container).
- **os.networkInterfaces** lists `lo` (127.0.0.1 and ::1) and one `eth<n>` per interface the namespace holds, each
  with its addresses of both families (`NamespaceAddress.interface` groups them); an IPv6 address carries `scopeid`,
  its interface's index when link-local, else 0.
- **The one routing decision** (`namespaceHolds`) is what `net`'s connect, HTTP's Agent and `tls` read: the namespace
  holds its loopback and wildcards, an address on one of its networks, and a name its resolver answers. A resolver that
  fails or does not answer makes the decision `EAI_AGAIN`, never "the outside".
- **tls.connect** to a destination the namespace holds pairs with its listener as a plain connection marked secure
  (the namespace's network is inside the tab, with no wire to protect); to one it does not hold it fails
  `ERR_TLS_UNAVAILABLE`, as only the host's HTTP exchange carries TLS to the outside.
- **HTTP's Agent** (`installHttpClientTransport`) sends a connection where the namespace routes it: what the namespace
  holds (its loopback, an address on one of its networks by its interfaces' prefixes, a name its resolver answers) is
  its own network, through `net`; a service its host serves itself is the host exchange only where the host's
  `hostService(network, host, port)` says the namespace's routes reach it (a container reaches the host at its
  gateway, so its own `localhost` is its own loopback); only what the namespace does not hold leaves through the
  exchange.

A realm whose host gives it no namespace is in `loopbackOnlyNamespace()`, which is a fresh namespace on Linux
(`ip netns add`, `docker run --network none`). It has its loopback and nothing else: it resolves no name and has no
route (`ENETUNREACH`). A name a host holds as itself is answered by its namespace's resolver, with the address it has
there.

## What the substrate supplies

browser-substrate supplies it on its `container-addresses` branch (`packages/node/src/container-network-namespace.ts`).

- Its host namespace is the Docker host's. Its addresses are each network's gateway. `connect` goes to the kernel's
  host listeners and the page's raw services (`serveRaw`), and `resolve` is `resolveContainerName` for the host.
- A Compose service's Node realm (its kernel process) gets its container's namespace, both for the scope that holds
  its sockets and for its realm's bootstrap. Its addresses come from `container-networks.ts`, `connect` is
  `routeContainerAddress` joined to the listener it reaches (a dropped route answers `ETIMEDOUT` after 127 s, as the
  kernel's does), `listen` claims the port in the namespace's one port space shared with the kernel's programs and
  registers the listener at (namespace, port) where the kernel's connects look, and `resolve` is
  `resolveContainerName` for that container.

The kernel reaches a Node listener at the namespace and port where the realm's `listen` put it.

## Where the evidence stops

The engine side is built and typechecked. Nothing was run: the tests in `tests/node-compat/net.test.ts`,
`dns.test.ts`, `os.test.ts` and `tests/network-namespace-doors.test.ts` state the behaviour above and are unrun. The
Docker reading above is the one reading of the reference; everything else is reasoned from Linux and Node and not
compared against a real kernel:

- two sockets bound to two specific addresses of one namespace on one port still conflict, as the per-port table
  always did (Linux allows it);
- a connect's ephemeral port is drawn from the engine's space for the namespace, not one the host coordinates, and a
  connection through a host's route reads the connector's port as the engine numbered it;
- the page bridge reaches a guest's loopback listener at 127.0.0.1, else at ::1.
