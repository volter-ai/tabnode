/**
 * A realm's network namespace, as Linux gives a process one (`network_namespaces(7)`).
 *
 * A process lives in one network namespace: its own loopback, its own port space, the addresses its interfaces hold,
 * the routes out of it, and the resolver its `/etc/resolv.conf` names. Two processes in two namespaces each listen on
 * 5432 and neither sees the other's; `127.0.0.1` is each one's own; a connection to another namespace's address goes
 * where the host's routes send it, or fails as the kernel fails it (`ETIMEDOUT` where its packets are dropped, as
 * between Docker's isolated bridges; `ENETUNREACH` where there is no route at all).
 *
 * The engine does not know what namespaces exist or how they are wired: that is the host's, as it is the kernel's
 * and the container runtime's on a computer. The host hands each realm its `NetworkNamespace`, and the engine's
 * `tcp_wrap`, `dns`, `os`, `tls` and HTTP's Agent read it. A namespace is a container's (`createContainer({ network })`),
 * held by each of its runs and inherited by the processes a run forks, or a host scope's (`NativeStreamScope`); it is
 * never the engine's, so two containers in one page are in their own namespaces: a listen takes a port of the namespace's own space and is told to the host; a
 * connect to the namespace's own loopback or addresses reaches its own listeners, and every other connect is the
 * host's to route; a lookup asks the namespace's resolver. A namespace the engine makes itself, for a realm no host
 * gave one, is `loopbackOnlyNamespace()`: what a fresh namespace is on Linux (`ip netns add`, `docker run
 * --network none`), its loopback and nothing else, which answers no name and routes nowhere.
 */
import type { Socket } from './node-lib/net-module';
import { UV_ECONNREFUSED, UV_ENETUNREACH } from './node-lib/binding/uv';
import { __currentProcessToken, runNetworkOf } from './process-tokens';
import { AsyncLocalStorage } from './shims/async_hooks';

/** One address an interface of the namespace holds (a container's address on one network it joined). */
export interface NamespaceAddress {
  address: string;
  /**
   * The interface that holds it (`eth0`): a network's IPv4 and IPv6 addresses are one interface's. An address that
   * names none is an interface of its own, in order.
   */
  interface?: string;
  /** The network's prefix length: 16 for a /16. */
  prefixLength: number;
  /** The interface's hardware address, when the host gives one (Docker's is 02:42 and the IPv4 address). */
  mac?: string;
}

/**
 * Where a connect the namespace's own listeners do not take goes, as the host answers it:
 * - a libuv status (`UV_ECONNREFUSED`, `UV_EHOSTUNREACH`, `UV_ENETUNREACH`, `UV_ETIMEDOUT`): failed, as the kernel
 *   fails it, and the socket's `connect` fails with that error. A host whose answer is dropped packets answers
 *   `UV_ETIMEDOUT` once Linux would have given up (`CONNECT_TIMEOUT_MS`), or leaves the promise pending: an answer
 *   that has not come by then is `ETIMEDOUT`, and one that fails or throws is `ECONNREFUSED`;
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
 * How long a connect the host routes may stay unanswered before it fails with `ETIMEDOUT`: Linux's, its SYN sent and
 * retried `tcp_syn_retries` (6) times with doubling waits (1 + 2 + … + 64 s). A host that never answers is a route
 * whose packets are dropped, as Docker's bridge isolation drops them.
 */
export const CONNECT_TIMEOUT_MS = 127_000;
/** How long a resolver's answer may stay away before a lookup fails `EAI_AGAIN`: resolv.conf's `timeout:5`, `attempts:2`. */
export const RESOLVE_TIMEOUT_MS = 10_000;

/**
 * The namespace of a socket made with no process, no container and no host scope: a fresh one of its own, which reaches
 * nothing, as a socket no process could have made would.
 */
const unowned = loopbackOnlyNamespace();
/** A namespace a host-held scope (NativeStreamScope, a container's own door) creates its handles in, while it creates them. */
let creatingIn: NetworkNamespace | undefined;
/**
 * The namespace code is running in, carried through every continuation the code makes (its timers, its promises), as
 * the engine's async context carries a run: a container's own code (`execute`, `runFile`) and an engine continuation
 * resumed in the namespace of the call that began it (captureNetworkContext).
 */
const networkScope = new AsyncLocalStorage<NetworkNamespace>({ name: 'tabnode.network' });

/** The namespace the calling code is in, where it is in one: a host scope's, its own scope's, or its run's. */
export function contextNetworkNamespace(): NetworkNamespace | undefined {
  return creatingIn ?? networkScope.getStore() ?? runNetworkOf(__currentProcessToken());
}

/**
 * The namespace a socket made now is in: the host scope's that is making it, else the code's (its container's, its
 * run's, or the one its parent's fork left it), as socket(2) makes a socket in the calling process's namespace.
 */
export function currentNetworkNamespace(): NetworkNamespace {
  return contextNetworkNamespace() ?? unowned;
}

/** Runs `run`, and every continuation it makes, in `network`'s namespace. */
export function inNetworkScope<T>(network: NetworkNamespace, run: () => T): T {
  return networkScope.run(network, run);
}

/**
 * The caller's context, to resume a continuation of the engine's own in (a resolver's answer, a lookup's callback, a
 * routing decision that arrived later): its run and everything else its async context carries, and its namespace. An
 * engine continuation runs on the host's loop, outside any run, so without this a socket it makes, or a callback it
 * calls, would be in no process's namespace.
 */
export function captureNetworkContext(): <T>(continuation: () => T) => T {
  const snapshot = AsyncLocalStorage.snapshot();
  const network = currentNetworkNamespace();
  return <T>(continuation: () => T): T => snapshot(() => networkScope.run(network, continuation)) as T;
}

/**
 * The namespaces of the containers this engine made, for a host-held scope given none: the one container's, where the
 * engine has one (createContainer records it). An engine with several has no single owner to default to.
 */
const engineContainerNamespaces: NetworkNamespace[] = [];
export function recordContainerNamespace(network: NetworkNamespace): void { engineContainerNamespaces.push(network); }
/**
 * The namespace a host-held scope made with none is in: the calling code's, where it is in one, else the engine's one
 * container's. With several containers and no context, the scope must be given its namespace.
 */
export function owningContainerNamespace(): NetworkNamespace {
  const context = contextNetworkNamespace();
  if (context) return context;
  if (engineContainerNamespaces.length === 1) return engineContainerNamespaces[0]!;
  if (engineContainerNamespaces.length === 0) return loopbackOnlyNamespace();
  throw Object.assign(new TypeError('This engine has several containers: give the scope its network namespace (the owning container\'s `network`).'),
    { code: 'ERR_INVALID_ARG_VALUE' });
}

/** Makes the handles `create` makes in `network`'s namespace, as a socket(2) call in a process of it does. */
export function inNetworkNamespace<T>(network: NetworkNamespace | undefined, create: () => T): T {
  if (!network) return create();
  const previous = creatingIn;
  creatingIn = network;
  try { return create(); } finally { creatingIn = previous; }
}

/** IPv4-mapped IPv6 in hex form (`::ffff:7f00:1`), as a URL canonicalises it, back to its dotted form. */
function dottedMapped(address: string): string {
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (!hex) return address;
  const high = parseInt(hex[1]!, 16), low = parseInt(hex[2]!, 16);
  return `::ffff:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** An address as compared: no brackets, no zone, lower case, and an IPv6 address in its one canonical (RFC 5952) form. */
export function bareAddress(address: string): string {
  const unbracketed = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const name = unbracketed.split('%')[0]!.toLowerCase();
  if (!name.includes(':')) return name;
  try { return dottedMapped(new URL(`http://[${name}]/`).hostname.slice(1, -1)); } catch { return name; }
}

/** An address with an IPv4-mapped IPv6 address read as its IPv4 address. */
export function unmappedAddress(address: string): string {
  return bareAddress(address).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, '');
}

/** 127.0.0.0/8 and ::1 (also as an IPv4-mapped address): every namespace's own loopback. */
export function isLoopbackAddress(address: string): boolean {
  const name = unmappedAddress(address);
  return name === 'localhost' || name === '::1' || name.startsWith('127.');
}

/** The wildcards, which a bind takes as every address and a connect (Linux) as the loopback. */
export function isWildcardAddress(address: string): boolean {
  const name = bareAddress(address);
  return name === '' || name === '0.0.0.0' || name === '::';
}

/** Whether `address` is one `network`'s interfaces hold: loopback, a wildcard, or one of its own addresses. */
export function isOwnAddress(network: NetworkNamespace, address: string): boolean {
  if (isLoopbackAddress(address) || isWildcardAddress(address)) return true;
  const name = unmappedAddress(address);
  return network.addresses().some(held => unmappedAddress(held.address) === name);
}

/** An address as a number of its family's width, or undefined for a name. */
function addressBits(address: string): { bits: bigint; width: 32 | 128 } | undefined {
  const name = unmappedAddress(address);
  const v4 = name.split('.');
  if (v4.length === 4 && v4.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) {
    return { bits: v4.reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n), width: 32 };
  }
  if (!name.includes(':')) return undefined;
  const [head, tail] = name.split('::') as [string, string | undefined];
  const groups = (part: string | undefined): string[] => part ? part.split(':') : [];
  const left = groups(head), right = groups(tail);
  if (tail === undefined && left.length !== 8) return undefined;
  const all = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (all.length !== 8 || all.some(group => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  return { bits: all.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n), width: 128 };
}

/** Whether `address` is on one of the namespace's networks: an on-link route, as an interface's prefix gives Linux one. */
export function isOnLink(network: NetworkNamespace, address: string): boolean {
  const target = addressBits(address);
  if (!target) return false;
  return network.addresses().some(({ address: held, prefixLength }) => {
    const own = addressBits(held);
    if (!own || own.width !== target.width || prefixLength < 0 || prefixLength > own.width) return false;
    const shift = BigInt(own.width - prefixLength);
    return (own.bits >> shift) === (target.bits >> shift);
  });
}

/**
 * THE ONE ROUTING DECISION for a destination by name or address, which `net`'s connect, HTTP's Agent and `tls` all
 * read: whether the namespace holds it (its loopback or a wildcard, an address on one of its networks, a name its
 * resolver answers), so the connection is the namespace's own network; what it does not hold is the outside's. A
 * resolver's answer may arrive later; one that fails is `EAI_AGAIN`, and one that never arrives is too, after
 * `RESOLVE_TIMEOUT_MS`. A name it does not hold (NXDOMAIN) is the outside's.
 */
export function namespaceHolds(network: NetworkNamespace, host: string): boolean | Promise<boolean> {
  const name = bareAddress(host);
  if (name === 'localhost' || isLoopbackAddress(name) || isWildcardAddress(name)) return true;
  if (addressBits(name) || name.includes(':')) return isOwnAddress(network, name) || isOnLink(network, name);
  const answered = (answer: ResolverAnswer): boolean => answer !== undefined;
  const answer = network.resolve(name.replace(/\.$/u, ''), 4);
  return answer instanceof Promise ? settleResolver(answer, name).then(answered) : answered(answer);
}

/** A resolver's pending answer, bounded: its failure, or no answer within `RESOLVE_TIMEOUT_MS`, is `EAI_AGAIN`. */
export function settleResolver<T>(answer: Promise<T>, hostname: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const again = (): Error => Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: 'EAI_AGAIN', errno: -3001, syscall: 'getaddrinfo', hostname });
    const timer = setTimeout(() => reject(again()), RESOLVE_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    answer.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(again()); });
  });
}
