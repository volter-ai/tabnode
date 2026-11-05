/**
 * A process's socket calls, as its kernel offers them (ADR-0009).
 *
 * On Linux a process makes its sockets with `socket(2)` in its own network namespace, and every socket is a
 * descriptor of its own table. The engine makes none of its own: a tree that is a client of a kernel offers that
 * kernel's socket calls for the process it serves under `TREE_SOCKETS`, beside the descriptor calls it offers under
 * `TREE_DESCRIPTORS` (ADR-0006), and `tcp_wrap`, `udp_wrap`, `dns`, `os` and `tls` make their calls there. The
 * namespace, its loopback, its bind tables, its routes and its resolver are the kernel's; the engine holds no copy of
 * any of them.
 *
 * Each call is Linux's call of its name, with Linux's numbers (`linux` below). A result is the call's return: a
 * non-negative value, or a negative errno, which is libuv's number on Linux and goes to Node unchanged. An address is
 * a `struct sockaddr`'s bytes; an option its value's bytes. Every socket the engine makes is non-blocking, so no call
 * blocks: readiness is `wait`, a promise of the descriptor's `revents` that settles once one of the asked events (or
 * an error, a hangup or the descriptor's close) holds.
 *
 * A tree that offers no sockets is a process on a Linux built without IPv4 and IPv6: `socket(AF_INET)` is
 * `EAFNOSUPPORT`, it has no interface addresses, and a name resolves from `/etc/hosts` alone.
 */
import { namedTree, withFilesystem } from './node-lib/binding/fs';
import { captureNodeResourceScope, resourceScopeProcess } from './node-lib/binding/handles';
import type { VirtualFS } from './virtual-fs';

/** The key a tree offers its process's socket calls under. */
export const TREE_SOCKETS = Symbol.for('tabnode.tree.sockets');

/** One address of an interface, as `getifaddrs(3)` lists it (`struct ifaddrs`). */
export interface InterfaceAddressEntry {
  /** `ifa_name`: `lo`, `eth0`. */
  readonly name: string;
  /** `ifa_flags`: `IFF_UP`, `IFF_RUNNING`, `IFF_LOOPBACK` and the rest. */
  readonly flags: number;
  /** `ifa_addr`: a `sockaddr_in` or `sockaddr_in6`. */
  readonly address: Uint8Array;
  /** `ifa_netmask`: a sockaddr of the same family. */
  readonly netmask: Uint8Array;
  /** The interface's hardware address (its `AF_PACKET` entry's `sll_addr`), six bytes; none for the loopback. */
  readonly hardware?: Uint8Array;
}

/**
 * The socket calls of one process, each Linux's of its name: a non-negative result or a negative errno.
 * Addresses the call fills are given 28 bytes, room for a `sockaddr_in6`.
 */
export interface TreeSockets {
  /** socket(2): `type` may carry `SOCK_NONBLOCK` and `SOCK_CLOEXEC`; answers the descriptor. */
  socket(domain: number, type: number, protocol: number): number;
  /** bind(2). */
  bind(fd: number, address: Uint8Array): number;
  /** listen(2). */
  listen(fd: number, backlog: number): number;
  /** accept4(2): answers the connection's descriptor and fills `address` with its peer, where given. */
  accept4(fd: number, flags: number, address: Uint8Array | null): number;
  /** connect(2): a non-blocking socket answers `-EINPROGRESS` and is writable once the connection is made or failed. */
  connect(fd: number, address: Uint8Array): number;
  /** sendto(2): `address` null for a connected socket; answers the bytes taken. */
  sendto(fd: number, data: Uint8Array, flags: number, address: Uint8Array | null): number;
  /** recvfrom(2): answers the bytes read (0 at a stream's end) and fills `address` with the source, where given. */
  recvfrom(fd: number, buffer: Uint8Array, flags: number, address: Uint8Array | null): number;
  /** shutdown(2). */
  shutdown(fd: number, how: number): number;
  /** close(2); a `wait` pending on the descriptor settles `POLLNVAL`. */
  close(fd: number): number;
  /** getsockname(2). */
  getsockname(fd: number, address: Uint8Array): number;
  /** getpeername(2). */
  getpeername(fd: number, address: Uint8Array): number;
  /** getsockopt(2): fills `value`, answers the option's length. */
  getsockopt(fd: number, level: number, name: number, value: Uint8Array): number;
  /** setsockopt(2). */
  setsockopt(fd: number, level: number, name: number, value: Uint8Array): number;
  /** fcntl(2), for `F_GETFL`, `F_SETFL` and `F_DUPFD_CLOEXEC`. */
  fcntl(fd: number, command: number, argument: number): number;
  /**
   * The descriptor's readiness, as poll(2) reports it: settles with its `revents` once any of `events`, or
   * `POLLERR`, `POLLHUP` or `POLLNVAL`, holds (at once if one does). Never rejects.
   */
  wait(fd: number, events: number): Promise<number>;
  /** getifaddrs(3): the addresses of the namespace's interfaces. */
  getifaddrs(): readonly InterfaceAddressEntry[];
}

/** The socket calls a tree offers, where it offers them. */
export function treeSocketsOf(tree: unknown): TreeSockets | undefined {
  if (tree === null || (typeof tree !== 'object' && typeof tree !== 'function')) return undefined;
  const offered = (tree as Record<symbol, unknown>)[TREE_SOCKETS];
  return offered !== null && typeof offered === 'object' ? offered as TreeSockets : undefined;
}

const kRunFilesystem = Symbol.for('tabnode.run.vfs');

/**
 * The calls of the process that is calling, as its `fs` finds its tree: a tree named for one call (an engine door
 * acting as its container), else the process whose binding scope is executing, else the realm's process.
 */
export function callingSockets(): TreeSockets | undefined {
  const named = namedTree();
  if (named) return treeSocketsOf(named);
  const process = (resourceScopeProcess() ?? (globalThis as unknown as { process?: object }).process) as Record<symbol, unknown> | undefined;
  return treeSocketsOf(process?.[kRunFilesystem]);
}

/**
 * The calling process, to resume a continuation of the engine's own in (a lookup's answer, in which Node's `net.js`
 * makes a listener's handle): a socket made there is the caller's, as `callingSockets` finds it.
 */
export function captureCallingSockets(): <T>(continuation: () => T) => T {
  const named = namedTree();
  const scoped = captureNodeResourceScope();
  return <T>(continuation: () => T): T => named ? withFilesystem(named as VirtualFS, () => scoped(continuation)) : scoped(continuation);
}

/** Linux's numbers for the calls above (asm-generic; the same on x86-64 and on WALI's wasm32). */
export const linux = Object.freeze({
  AF_UNIX: 1, AF_INET: 2, AF_INET6: 10,
  SOCK_STREAM: 1, SOCK_DGRAM: 2, SOCK_NONBLOCK: 0o4000, SOCK_CLOEXEC: 0o2000000,
  MSG_DONTWAIT: 0x40, MSG_NOSIGNAL: 0x4000,
  SHUT_WR: 1,
  SOL_SOCKET: 1, SO_REUSEADDR: 2, SO_TYPE: 3, SO_ERROR: 4, SO_BROADCAST: 6, SO_SNDBUF: 7, SO_RCVBUF: 8,
  SO_KEEPALIVE: 9, SO_LINGER: 13, SO_REUSEPORT: 15, SO_DOMAIN: 39,
  IPPROTO_IP: 0, IPPROTO_TCP: 6, IPPROTO_IPV6: 41,
  TCP_NODELAY: 1, TCP_KEEPIDLE: 4, TCP_KEEPINTVL: 5, TCP_KEEPCNT: 6,
  IP_TOS: 1, IP_TTL: 2, IP_MULTICAST_IF: 32, IP_MULTICAST_TTL: 33, IP_MULTICAST_LOOP: 34,
  IP_ADD_MEMBERSHIP: 35, IP_DROP_MEMBERSHIP: 36, IP_ADD_SOURCE_MEMBERSHIP: 39, IP_DROP_SOURCE_MEMBERSHIP: 40,
  IPV6_UNICAST_HOPS: 16, IPV6_MULTICAST_IF: 17, IPV6_MULTICAST_HOPS: 18, IPV6_MULTICAST_LOOP: 19,
  IPV6_ADD_MEMBERSHIP: 20, IPV6_DROP_MEMBERSHIP: 21, IPV6_V6ONLY: 26, IPV6_TCLASS: 67,
  F_GETFL: 3, F_SETFL: 4, F_DUPFD_CLOEXEC: 1030, O_NONBLOCK: 0o4000,
  POLLIN: 0x1, POLLOUT: 0x4,
  IFF_UP: 0x1, IFF_LOOPBACK: 0x8, IFF_RUNNING: 0x40,
  EINTR: 4, EAGAIN: 11, EINVAL: 22, EOPNOTSUPP: 95, EAFNOSUPPORT: 97, EADDRINUSE: 98,
  ECONNREFUSED: 111, EINPROGRESS: 115,
});

/** A `sockaddr_in` or `sockaddr_in6`, read: its address as inet_ntop prints it, its family as Node names it, its port. */
export interface SocketName {
  address: string;
  family: 'IPv4' | 'IPv6';
  port: number;
  /** An IPv6 address's `sin6_scope_id`. */
  scopeid?: number;
}

/** inet_pton(AF_INET): a dotted quad, each part a decimal number below 256 with no leading zero. */
export function ipv4Bytes(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!;
    if (!/^(0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255) return undefined;
    bytes[index] = Number(part);
  }
  return bytes;
}

/** inet_pton(AF_INET6), with a dotted quad allowed in the last 32 bits; any zone (`%eth0`) is not part of it. */
export function ipv6Bytes(text: string): Uint8Array | undefined {
  let rest = text;
  const tail: number[] = [];
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(rest);
  if (dotted) {
    const four = ipv4Bytes(dotted[1]!);
    if (!four) return undefined;
    tail.push((four[0]! << 8) | four[1]!, (four[2]! << 8) | four[3]!);
    rest = rest.slice(0, dotted.index + 1);
    if (rest.endsWith(':') && !rest.endsWith('::')) rest = rest.slice(0, -1);
  }
  const halves = rest.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string): number[] | undefined => {
    if (half === '') return [];
    const out: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const back = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !back) return undefined;
  const total = head.length + back.length + tail.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return undefined;
  const words = [...head, ...new Array<number>(8 - total).fill(0), ...back, ...tail];
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) { bytes[index * 2] = words[index]! >> 8; bytes[index * 2 + 1] = words[index]! & 255; }
  return bytes;
}

/** inet_ntop(AF_INET6), as libuv's (ISC's) prints it: the longest run of two or more zero words compressed, lower case. */
export function ipv6Text(bytes: Uint8Array): string {
  const words: number[] = [];
  for (let index = 0; index < 8; index += 1) words.push((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!);
  let best = { base: -1, len: 0 }, current = { base: -1, len: 0 };
  for (let index = 0; index < 8; index += 1) {
    if (words[index] === 0) {
      if (current.base === -1) current = { base: index, len: 1 }; else current.len += 1;
    } else if (current.base !== -1) {
      if (best.base === -1 || current.len > best.len) best = current;
      current = { base: -1, len: 0 };
    }
  }
  if (current.base !== -1 && (best.base === -1 || current.len > best.len)) best = current;
  if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };
  let out = '';
  for (let index = 0; index < 8; index += 1) {
    if (best.base !== -1 && index >= best.base && index < best.base + best.len) {
      if (index === best.base) out += ':';
      continue;
    }
    if (index !== 0) out += ':';
    if (index === 6 && best.base === 0 && (best.len === 6 || (best.len === 7 && words[7] !== 0x0001) || (best.len === 5 && words[5] === 0xffff))) {
      out += `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      break;
    }
    out += words[index]!.toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ':';
  return out;
}

/** The interface index a zone names (`fe80::1%eth0`), from the scope a link-local address of it carries; 0 for none. */
function zoneIndex(zone: string, sockets: TreeSockets | undefined): number {
  if (/^\d+$/u.test(zone)) return Number(zone);
  for (const entry of interfaceEntries(sockets)) {
    if (entry.name !== zone) continue;
    const name = readSocketName(entry.address);
    if (name?.family === 'IPv6' && name.scopeid) return name.scopeid;
  }
  return 0;
}

/** The name of interface `index`, from the scope its link-local address carries. */
function zoneName(index: number, sockets: TreeSockets | undefined): string {
  for (const entry of interfaceEntries(sockets)) {
    const name = readSocketName(entry.address);
    if (name?.family === 'IPv6' && name.scopeid === index) return entry.name;
  }
  return String(index);
}

function interfaceEntries(sockets: TreeSockets | undefined): readonly InterfaceAddressEntry[] {
  try { return sockets?.getifaddrs() ?? []; } catch { return []; }
}

/**
 * A `sockaddr_in` (family 4) or `sockaddr_in6` (family 6) for a numeric address and a port, as `uv_ip4_addr` and
 * `uv_ip6_addr` make one (an IPv6 zone is its interface's index); undefined for a string that is not one.
 */
export function socketAddress(family: 4 | 6, address: string, port: number, sockets?: TreeSockets): Uint8Array | undefined {
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    if (!bytes) return undefined;
    const out = new Uint8Array(16);
    out[0] = linux.AF_INET & 255; out[1] = linux.AF_INET >> 8;
    out[2] = (port >> 8) & 255; out[3] = port & 255;
    out.set(bytes, 4);
    return out;
  }
  const percent = address.indexOf('%');
  const bytes = ipv6Bytes(percent < 0 ? address : address.slice(0, percent));
  if (!bytes) return undefined;
  const out = new Uint8Array(28);
  out[0] = linux.AF_INET6 & 255; out[1] = linux.AF_INET6 >> 8;
  out[2] = (port >> 8) & 255; out[3] = port & 255;
  out.set(bytes, 8);
  const scope = percent < 0 ? 0 : zoneIndex(address.slice(percent + 1), sockets);
  new DataView(out.buffer).setUint32(24, scope >>> 0, true);
  return out;
}

/** An empty sockaddr for a call to fill: room for a `sockaddr_in6`. */
export function socketAddressBuffer(): Uint8Array { return new Uint8Array(28); }

/** A filled sockaddr, read; undefined for a family that is not IPv4 or IPv6. */
export function readSocketName(bytes: Uint8Array, sockets?: TreeSockets): SocketName | undefined {
  if (bytes.byteLength < 4) return undefined;
  const family = bytes[0]! | (bytes[1]! << 8);
  const port = (bytes[2]! << 8) | bytes[3]!;
  if (family === linux.AF_INET && bytes.byteLength >= 8) {
    return { address: `${bytes[4]}.${bytes[5]}.${bytes[6]}.${bytes[7]}`, family: 'IPv4', port };
  }
  if (family === linux.AF_INET6 && bytes.byteLength >= 28) {
    const raw = bytes.subarray(8, 24);
    const scopeid = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(24, true);
    let address = ipv6Text(raw);
    // Node's AddressToJS names a link-local address's interface after it.
    if (raw[0] === 0xfe && (raw[1]! & 0xc0) === 0x80 && scopeid > 0 && sockets) address += `%${zoneName(scopeid, sockets)}`;
    return { address, family: 'IPv6', port, scopeid };
  }
  return undefined;
}

/** An `int` option's value. */
export function intOption(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value | 0, true);
  return out;
}

/** An `int` option's value, read. */
export function readIntOption(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
}

/** One address of `os.networkInterfaces()`, as libuv's `uv_interface_addresses` gives it. */
export interface InterfaceAddress {
  name: string;
  address: string;
  netmask: string;
  family: 'IPv4' | 'IPv6';
  mac: string;
  internal: boolean;
  /** -1 for IPv4, as Node's binding hands it. */
  scopeid: number;
}

/**
 * The process's interface addresses, by libuv's rule on Linux (`uv__ifaddr_exclude`): an interface that is up and
 * running, each of its IPv4 and IPv6 addresses, `internal` for a loopback interface, its hardware address as `mac`.
 */
export function interfaceAddresses(sockets: TreeSockets | undefined): InterfaceAddress[] {
  const out: InterfaceAddress[] = [];
  for (const entry of interfaceEntries(sockets)) {
    if ((entry.flags & (linux.IFF_UP | linux.IFF_RUNNING)) !== (linux.IFF_UP | linux.IFF_RUNNING)) continue;
    const address = readSocketName(entry.address);
    const netmask = readSocketName(entry.netmask);
    if (!address || !netmask) continue;
    const hardware = entry.hardware;
    const mac = hardware && hardware.byteLength >= 6
      ? Array.from(hardware.subarray(0, 6), byte => byte.toString(16).padStart(2, '0')).join(':') : '00:00:00:00:00:00';
    out.push({ name: entry.name, address: address.address, netmask: netmask.address, family: address.family, mac,
      internal: (entry.flags & linux.IFF_LOOPBACK) !== 0, scopeid: address.family === 'IPv6' ? address.scopeid ?? 0 : -1 });
  }
  return out;
}

/** The bytes of a numeric address of either family, IPv4-mapped IPv6 read as IPv4. */
function addressBytes(address: string): Uint8Array | undefined {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const v4 = ipv4Bytes(bare);
  if (v4) return v4;
  const percent = bare.indexOf('%');
  const v6 = ipv6Bytes(percent < 0 ? bare : bare.slice(0, percent));
  if (!v6) return undefined;
  const mapped = v6.subarray(0, 10).every(byte => byte === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

/**
 * Whether a numeric address is on a network the process is directly connected to: its loopback, or an interface's
 * network by that interface's netmask (an on-link route, as an interface's prefix gives Linux one). Nothing lies
 * between the two ends of such a connection but the kernel.
 */
export function directlyConnected(address: string, sockets: TreeSockets | undefined): boolean {
  const target = addressBytes(address);
  if (!target) return false;
  if (target.byteLength === 4 && target[0] === 127) return true;
  if (target.byteLength === 16 && target.subarray(0, 15).every(byte => byte === 0) && target[15] === 1) return true;
  for (const entry of interfaceEntries(sockets)) {
    if ((entry.flags & linux.IFF_UP) === 0) continue;
    const own = readSocketName(entry.address), mask = readSocketName(entry.netmask);
    if (!own || !mask) continue;
    const ownBytes = addressBytes(own.address), maskBytes = addressBytes(mask.address);
    if (!ownBytes || !maskBytes || ownBytes.byteLength !== target.byteLength || maskBytes.byteLength !== target.byteLength) continue;
    if (target.every((byte, index) => (byte & maskBytes[index]!) === (ownBytes[index]! & maskBytes[index]!))) return true;
  }
  return false;
}
