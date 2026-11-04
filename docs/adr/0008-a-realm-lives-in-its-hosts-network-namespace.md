# ADR-0008: A realm lives in the network namespace its host gives it

Status: Accepted

Date: 2026-11-04. Constitution Article 6 (correct toward Node's own behaviour). Owner: "now the way that the tab runs
things is done like on a real computer right? instead of magically"; "we dont' want any one offs everything has to
fit into the ontology and catagories".

## Context

A process on Linux lives in one network namespace (`network_namespaces(7)`): its own loopback, its own port space,
the addresses its interfaces hold, the routes out of it and the resolver its `/etc/resolv.conf` names. Docker gives
each container one, joins it to bridges (172.17.0.0/16, then 172.18–31.0.0/16), answers names at 127.0.0.11 by the
networks the asker shares, and isolates bridges from one another (`EHOSTUNREACH`).

browser-substrate's WALI kernel gives its programs exactly that (its `container-networks.ts` is the one table). The
engine had one host loopback and no namespaces: `tcp_wrap` reached only loopback addresses and every listener shared
one port table, and `dns` answered every name the host listed with the loopback. A Node realm in a Compose service
therefore could not hold the address, ports or names its container holds, and the substrate kept two one-offs to
paper over it: a by-port mirror of every kernel listener into the engine's loopback, and a kernel fallback that sent a
connection with no kernel listener to the host's port table, whatever namespace it was dialled in.

## Decision

The engine does not know what namespaces exist or how they are wired; that is its host's, as it is the kernel's and
the container runtime's on a computer. The host hands each realm its `NetworkNamespace` (`src/network-namespace.ts`),
and `tcp_wrap`, `dns` and `os` read it.

```ts
interface NetworkNamespace {
  readonly id: string;                                   // one id: one loopback, one port space
  addresses(): readonly NamespaceAddress[];              // { address, prefixLength, mac? }, eth0 first
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

- `createContainer({ network })`: the namespace of the engine's own runs and of the host's doors into it (the page
  bridge, `listenNet`). One engine serves one such namespace.
- `new NativeStreamScope(limits, emit, ownerPid, network)`: the namespace of a process whose sockets this engine holds
  for another worker. Every TCP handle the scope makes is made in it.

What the engine does with it:

- **A socket keeps the namespace it was made in.** Each namespace has its own port space (IPv4, IPv6 and ephemeral),
  so two realms each listen on 5432.
- **bind** takes a wildcard, a loopback address or one of the namespace's addresses; any other is `EADDRNOTAVAIL`.
- **listen** tells the host (`listen`), which may refuse it with a libuv status (`EADDRINUSE` where the host holds the
  port itself; libuv reports a bind conflict at listen, so Node's error is `listen EADDRINUSE` either way). The host
  keeps the returned function and calls it when the socket stops listening. It opens connections to the listener with
  `open(from, to)`; a listener bound to the loopback is not reached at the namespace's address.
- **connect** to the namespace's own loopback or addresses goes to its own listener on the port. Every other connect,
  and an own-address connect no listener in this engine takes, is the host's to route (`connect`). The host answers
  with another namespace this engine serves (the connection is paired here), a listener the host holds (the far end is
  handed to it as a `net.Socket`), or a refusal: `ECONNREFUSED`, `EHOSTUNREACH` across isolated networks, or
  `ENETUNREACH` with no route. The connection leaves by the `source` the route names, which is what both ends read.
- **dns.lookup** reads the process's `/etc/hosts` and answers `localhost` and IP literals. It then asks the
  namespace's resolver for A, then AAAA records, as getaddrinfo does. `dns.resolve*` is a query to that resolver: a
  name it does not hold is `ENOTFOUND`, and a held name with no record of the type is `ENODATA`. Nothing resolves to
  the loopback unless the resolver says so.
- **os.networkInterfaces** lists `lo` and one `eth<n>` per address the namespace holds.
- **HTTP's Agent** (`installHttpClientTransport`) sends a connection where the namespace routes it: what the namespace
  holds (its loopback, an address on one of its networks by its interfaces' prefixes, a name its resolver answers) is
  its own network, through `net`; a service its host serves itself is the host exchange only where the host's
  `hostService(network, host, port)` says the namespace's routes reach it (a container reaches the host at its
  gateway, so its own `localhost` is its own loopback); only what the namespace does not hold leaves through the
  exchange. The per-port `hostPorts` list, which sent a loopback port to the host whatever namespace asked, is gone.

A realm whose host gives it no namespace is in `loopbackOnlyNamespace()`, which is a fresh namespace on Linux
(`ip netns add`, `docker run --network none`). It has its loopback and nothing else: it resolves no name and has no
route (`ENETUNREACH`). There is no "every name is this host" default and no held-name list: a name a host holds as
itself is answered by its namespace's resolver, with the address it has there.

## What the substrate supplies

This is design for browser-substrate, read at `container-addresses` 697c6a93123 and not built or run here.

- Its host namespace is the Docker host's. Its addresses are each network's gateway. `connect` goes to the kernel's
  host listeners and the page's raw services (`serveRaw`), `listen` registers in the host's port table, and `resolve`
  is `resolveContainerName` for the host.
- A Compose service's Node realm (its kernel process) gets its container's namespace. Its addresses come from
  `container-networks.ts`, `connect` is `routeContainerAddress` joined to the kernel listener it reaches, `listen`
  registers the listener at (namespace, port) where the kernel looks, and `resolve` is `resolveContainerName` for
  that container.

With that in place the substrate's by-port mirror and its kernel fallback to the host's port table have no work left.
The kernel reaches a Node listener at the namespace and port where the realm's `listen` put it.

## Where the evidence stops

The engine side is built and typechecked. Nothing was run: the tests in `tests/node-compat/net.test.ts`,
`dns.test.ts` and `os.test.ts` state the behaviour above and are unrun. Three points are reasoned from Linux and not
yet compared against a real kernel:

- a bind of a specific address and a wildcard on one port of one namespace still conflicts, as the per-port table
  always did (Linux allows two specific addresses to share a port);
- a connect's ephemeral port is drawn from the engine's space for the namespace, not one the host coordinates;
- a host whose `connect` promise rejects refuses the connect and rethrows the rejection unhandled.
