/**
 * A realm's network namespace, as Linux gives a process one (`network_namespaces(7)`).
 *
 * A process lives in one network namespace: its own loopback, its own port space, the addresses its interfaces hold,
 * the routes out of it, and the resolver its `/etc/resolv.conf` names. Two processes in two namespaces each listen on
 * 5432 and neither sees the other's; `127.0.0.1` is each one's own; a connection to another namespace's address goes
 * where the host's routes send it, or is refused as the kernel refuses it (`EHOSTUNREACH` across bridges that are
 * isolated from one another, `ENETUNREACH` where there is no route at all).
 *
 * The engine does not know what namespaces exist or how they are wired: that is the host's, as it is the kernel's
 * and the container runtime's on a computer. The host hands each realm its `NetworkNamespace`, and the engine's
 * `tcp_wrap`, `dns` and `os` read it: a listen takes a port of the namespace's own space and is told to the host; a
 * connect to the namespace's own loopback or addresses reaches its own listeners, and every other connect is the
 * host's to route; a lookup asks the namespace's resolver. A namespace the engine makes itself, for a realm no host
 * gave one, is `loopbackOnlyNamespace()`: what a fresh namespace is on Linux (`ip netns add`, `docker run
 * --network none`), its loopback and nothing else, which answers no name and routes nowhere.
 */
import type { Socket } from './node-lib/net-module';
import { UV_ECONNREFUSED, UV_ENETUNREACH } from './node-lib/binding/uv';

/** One address an interface of the namespace holds (a container's address on one network it joined). */
export interface NamespaceAddress {
  address: string;
  /** The network's prefix length: 16 for a /16. */
  prefixLength: number;
  /** The interface's hardware address, when the host gives one (Docker's is 02:42 and the IPv4 address). */
  mac?: string;
}

/**
 * Where a connect the namespace's own listeners do not take goes, as the host answers it:
 * - a libuv status (`UV_ECONNREFUSED`, `UV_EHOSTUNREACH`, `UV_ENETUNREACH`, `UV_ETIMEDOUT`): refused, as the kernel
 *   refuses it, and the socket's `connect` fails with that error;
 * - `{ namespace, source }`: the address belongs to `namespace`, another namespace this engine serves listeners for;
 *   its listener on the port takes the connection, which leaves by `source` (the connector's address on the network
 *   the two share), and no listener there is `ECONNREFUSED`;
 * - `{ source, accept }`: a listener the host holds (a kernel program, a service of the host's own) takes it, leaving
 *   by `source`; `accept` is handed the connection's far end as a `net.Socket`, whose bytes are the connector's.
 */
export type NamespaceConnection =
  | number
  | { namespace: string; source: string }
  | { source: string; accept(socket: Socket): void };

/** A listener of the namespace, as the host is told of it. */
export interface NamespaceListener {
  readonly port: number;
  /** The address it bound: a wildcard (`0.0.0.0`, `::`), a loopback address, or one of the namespace's own. */
  readonly address: string;
  readonly family: 'IPv4' | 'IPv6';
  /**
   * A connection to it from `from`, arriving at `to` (the address the connector dialled): the connector's end as a
   * `net.Socket`, or a libuv status when the listener takes no connection there (it closed, or it bound an address
   * that is not `to`: a server bound to 127.0.0.1 is not reached at the container's network address).
   */
  open(from: { address: string; port: number }, to: string): Socket | number;
}

/** Addresses of one family for a name; `undefined` when the resolver holds no such name (NXDOMAIN). */
export type ResolverAnswer = readonly string[] | undefined;

/** What the host hands a realm: its network namespace. */
export interface NetworkNamespace {
  /** The namespace's identity on its host. Realms given namespaces with one id share one loopback and one port space. */
  readonly id: string;
  /** The addresses its interfaces hold besides loopback, in the order the interfaces were made (eth0 first). */
  addresses(): readonly NamespaceAddress[];
  /** Routes a connect to `address:port` that none of this namespace's listeners in this engine took. */
  connect(address: string, port: number, family: 4 | 6): NamespaceConnection | Promise<NamespaceConnection>;
  /**
   * Told when a listener of this namespace starts listening: a nonzero libuv status refuses it (`UV_EADDRINUSE`, when
   * something the host holds has the port), else the function that is called when it stops.
   */
  listen(listener: NamespaceListener): number | (() => void);
  /**
   * The namespace's resolver (what its `/etc/resolv.conf` names): the addresses of `family` for `name`, `[]` when the
   * name exists with none of that family, `undefined` when it does not exist.
   */
  resolve(name: string, family: 4 | 6): ResolverAnswer | Promise<ResolverAnswer>;
}

let freshNamespaces = 0;

/**
 * A namespace with its loopback alone: a fresh one on Linux. It holds no address and answers no name; a port of its
 * loopback nothing listens on refuses, and every other address has no route.
 */
export function loopbackOnlyNamespace(): NetworkNamespace {
  freshNamespaces += 1;
  return {
    id: `lo:${freshNamespaces}`,
    addresses: () => [],
    connect: (address) => isLoopbackAddress(address) || isWildcardAddress(address) ? UV_ECONNREFUSED : UV_ENETUNREACH,
    listen: () => () => undefined,
    resolve: () => undefined,
  };
}

/**
 * The engine's namespace: the one its own runs and the page's doors (`listenNet`, the server bridge) live in, set by
 * `createContainer`'s `network`. A realm the host started is in the namespace the host gave it.
 */
let engineNamespace: NetworkNamespace = loopbackOnlyNamespace();
/** A namespace a host-held scope creates its handles in (NativeStreamScope), while it creates them. */
let creatingIn: NetworkNamespace | undefined;

export function setEngineNamespace(network: NetworkNamespace): void { engineNamespace = network; }
export function getEngineNamespace(): NetworkNamespace { return engineNamespace; }

/** The namespace a socket made now is in. */
export function currentNetworkNamespace(): NetworkNamespace { return creatingIn ?? engineNamespace; }

/** Makes the handles `create` makes in `network`'s namespace, as a socket(2) call in a process of it does. */
export function inNetworkNamespace<T>(network: NetworkNamespace | undefined, create: () => T): T {
  if (!network) return create();
  const previous = creatingIn;
  creatingIn = network;
  try { return create(); } finally { creatingIn = previous; }
}

/** An address as compared: no brackets, no zone, lower case. */
export function bareAddress(address: string): string {
  const unbracketed = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  return unbracketed.split('%')[0].toLowerCase();
}

/** 127.0.0.0/8 and ::1 (also as an IPv4-mapped address): every namespace's own loopback. */
export function isLoopbackAddress(address: string): boolean {
  const name = bareAddress(address);
  return name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1' || name.startsWith('127.') || name.startsWith('::ffff:127.');
}

/** The wildcards, which a bind takes as every address and a connect (Linux) as the loopback. */
export function isWildcardAddress(address: string): boolean {
  const name = bareAddress(address);
  return name === '' || name === '0.0.0.0' || name === '::' || name === '0:0:0:0:0:0:0:0';
}

/** Whether `address` is one `network`'s interfaces hold: loopback, a wildcard, or one of its own addresses. */
export function isOwnAddress(network: NetworkNamespace, address: string): boolean {
  if (isLoopbackAddress(address) || isWildcardAddress(address)) return true;
  const name = bareAddress(address).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return network.addresses().some(held => held.address.toLowerCase() === name);
}
