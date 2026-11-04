/**
 * `internalBinding('tcp_wrap')`: TCP in libuv's shape, in the realm's network namespace (`../../network-namespace.ts`).
 *
 * A handle is made in a namespace (the realm's, or the one a host-held scope serves) and keeps it, as a socket keeps
 * the namespace it was made in on Linux. A `bind` reserves a port of that namespace's own space, at a wildcard, a
 * loopback address or one of the namespace's addresses (any other is `EADDRNOTAVAIL`); a `listen` starts answering on
 * it and tells the namespace's host, which may refuse it and can open connections to it; a `connect` to the
 * namespace's own loopback or addresses reaches its own listener on the port, and every other connect is routed by the
 * host: to a listener of another namespace this engine serves, to a listener the host holds, or refused with the
 * error the kernel gives (`ECONNREFUSED`, `ETIMEDOUT`, `ENETUNREACH`). The bytes of a connection paired here are
 * each end's writes as the other's reads. A host that fails, throws or never answers fails the one socket, as a
 * kernel's refusal or timeout does, and nothing else.
 *
 * Families are Linux's: an IPv4 bind takes the IPv4 port, a dual-stack `::` bind both (so `connect('127.0.0.1')`
 * reaches a server that bound `::`), an `ipv6Only` or address-specific IPv6 bind the IPv6 port alone. An IPv4 connect
 * reaches only the IPv4 port's listener, an IPv6 one the IPv6 port's (an IPv4-mapped address the IPv4 port's). A
 * listener bound to one address takes connections to that address alone (127.0.0.1 not 127.0.0.2, nor ::1); a connect
 * to a wildcard is a connect to its family's loopback.
 */
import { queueBindingTask } from '../../guest-loop';
import { LibuvStreamWrap } from './stream_wrap';
import { __adoptHandle, ownerOf, ownerOfInstance, invokeOwned, observeNodeRequest, forgetNodeRequest } from './handles';
import { __runFor } from '../../process-tokens';
import { internalAsyncHooks, internalTimers } from '../internals/runtime';
import { rememberSocketConnect, traceSocketConnect } from '../../socket-connect-trace';
import { nativeStreamFor, registerNativeStreamConstructor } from '../../native-stream-binding';
import { UV_EADDRINUSE, UV_EADDRNOTAVAIL, UV_ECONNREFUSED, UV_EINVAL, UV_ENOTSUP, UV_EBADF, UV_EIO, UV_ETIMEDOUT } from './uv';
import {
  CONNECT_TIMEOUT_MS, bareAddress, currentNetworkNamespace, inNetworkNamespace, isLoopbackAddress, isOwnAddress,
  isWildcardAddress, unmappedAddress, type NamespaceConnection, type NetworkNamespace,
} from '../../network-namespace';
import type { Socket } from '../net-module';

/** libuv's `uv_tcp_t` flavours, and the two flags `getFlags` builds. */
export const constants = {
  SOCKET: 0,
  SERVER: 1,
  UV_TCP_IPV6ONLY: 1,
  UV_TCP_REUSEPORT: 4,
};

/** What `getsockname`/`getpeername` fill in. */
export interface SockName {
  address: string;
  family: string;
  port: number;
}

/** Node's `TCPConnectWrap`: the request a connect fills and is answered through. */
export class TCPConnectWrap {
  oncomplete: ((status: number, handle: unknown, req: unknown, readable: boolean, writable: boolean) => void) | null = null;
  address = '';
  port = 0;
  localAddress: string | undefined = undefined;
  localPort: number | undefined = undefined;
  addressType: number | undefined = undefined;
}

/**
 * Each namespace's ports, by address family: a handle that has bound one, listening or not, and every ephemeral port a
 * client end was given. An IPv4 bind takes the IPv4 space, an `ipv6Only` bind the IPv6 space, and a dual-stack IPv6
 * bind both, so an IPv6-only socket can share a port number with an IPv4 one, as on a host. Two namespaces' spaces
 * are apart: each may hold the same port.
 */
interface PortSpace {
  v4: Map<number, TCP>;
  v6: Map<number, TCP>;
  ephemeral: Set<number>;
  /** Linux's ephemeral range, walked in order as a kernel walks it. */
  nextEphemeral: number;
}
const portSpaces = new Map<string, PortSpace>();
function portSpace(namespace: string): PortSpace {
  let space = portSpaces.get(namespace);
  if (!space) portSpaces.set(namespace, space = { v4: new Map(), v6: new Map(), ephemeral: new Set(), nextEphemeral: 49152 });
  return space;
}
const portTaken = (space: PortSpace, port: number): boolean => space.v4.has(port) || space.v6.has(port) || space.ephemeral.has(port);
/**
 * The family spaces a bind occupies: an IPv4 address the IPv4 space; an IPv6 wildcard both, unless `ipv6Only`; an
 * IPv4-mapped IPv6 address the IPv4 space; any other IPv6 address (`::1`) the IPv6 space alone.
 */
function spacesOf(space: PortSpace, family: string, flags: number, address: string): Array<Map<number, TCP>> {
  if (family !== 'IPv6') return [space.v4];
  if (flags & constants.UV_TCP_IPV6ONLY) return [space.v6];
  if (isWildcardAddress(address)) return [space.v4, space.v6];
  return unmappedAddress(address).includes(':') ? [space.v6] : [space.v4];
}

function allocatePort(space: PortSpace): number {
  for (let tries = 0; tries < 16384; tries += 1) {
    const port = space.nextEphemeral;
    space.nextEphemeral = space.nextEphemeral >= 65535 ? 49152 : space.nextEphemeral + 1;
    if (!portTaken(space, port)) return port;
  }
  return 0;
}

/** The loopback address of a family, which a connect to the loopback or a wildcard leaves by. */
const loopbackOf = (family: string): string => family === 'IPv6' ? '::1' : '127.0.0.1';

/** An IPv4 address as a dual-stack IPv6 socket reads it (`::ffff:a.b.c.d`), as Linux names a mapped peer. */
function seenBy(handleFamily: string, address: string, addressFamily: string): string {
  return handleFamily === 'IPv6' && addressFamily !== 'IPv6' ? `::ffff:${bareAddress(address)}` : address;
}

/** The address a connect dialled, as it arrives: a wildcard is its family's loopback (Linux's connect to INADDR_ANY). */
function arrivingAt(to: string, family: string | undefined): string {
  return isWildcardAddress(to) ? (bareAddress(to) === '::' || (family === 'IPv6' && bareAddress(to) === '') ? '::1' : '127.0.0.1') : unmappedAddress(to);
}

/**
 * Whether a listener takes a connection dialled to `to`: one bound to a wildcard takes every address of its namespace
 * (its port space already chose the family), one bound to an address only that address. A server bound to 127.0.0.1
 * is reached at 127.0.0.1 alone: not at 127.0.0.2, not at ::1, not at the container's network address.
 */
function takesConnectionTo(listener: TCP, to: string, family?: string): boolean {
  const bound = listener.boundAddress;
  if (bound === undefined || isWildcardAddress(bound)) return true;
  return unmappedAddress(bound) === arrivingAt(to, family);
}

/**
 * The listening member of `namespace`'s port that a connection to `to` reaches, if any: an IPv4 connect (or an
 * IPv4-mapped address) the IPv4 space's, an IPv6 connect the IPv6 space's.
 */
function listenerIn(namespace: string, port: number, family: string | undefined, to: string): TCP | undefined {
  const space = portSpaces.get(namespace);
  if (!space) return undefined;
  const arriving = arrivingAt(to, family);
  const order = arriving.includes(':') ? [space.v6] : [space.v4];
  for (const ports of order) {
    const held = ports.get(port);
    if (!held || !takesConnectionTo(held, arriving)) continue;
    const member = held.acceptingMember();
    if (member) return member;
  }
  return undefined;
}

/**
 * How a connection's far end is handed to a host: a `net.Socket` over the handle, as Node's `net.js` wraps an accepted
 * handle. `net-module.ts` installs it; the binding is loaded before Node's `net.js` is.
 */
let hostSocket: ((handle: TCP) => Socket) | undefined;
export function installHostSocket(wrap: (handle: TCP) => Socket): void { hostSocket = wrap; }
function socketFor(handle: TCP): Socket {
  if (!hostSocket) throw new Error('tcp_wrap: net is not loaded, so a connection cannot be handed to the host.');
  return hostSocket(handle);
}

/** What a listening socket told its namespace's host and its namespace's page bridge, by the socket (its connection end). */
const announcements = new WeakMap<object, { release?: () => void; watched?: string }>();

/**
 * What the page bridge is told when a guest starts or stops listening. The
 * bridge used to learn this from the engine's own `http.Server`; `http` is
 * Node's own file now and knows nothing of a page, so the news comes from
 * where a port is actually taken.
 */
type ListenWatcher = (port: number, address: string) => void;
/**
 * An instrument's seam: told, once a handle, that a server began listening, with the process that owns the handle
 * and the port. The engine's load clock says the process's split there (runtime.ts): a server still loading its
 * modules when the page's first request arrives says nothing else before a dry run's capture ends (S2 R17).
 */
let listenClockObserver: ((owner: ReturnType<typeof ownerOf>, port: number | null) => void) | undefined;
export function observeListenClocks(observer: NonNullable<typeof listenClockObserver>): void { listenClockObserver = observer; }
function sayListenClock(handle: TCP, port: number | null): void {
  try { listenClockObserver?.(ownerOf(handle), port); }
  catch { /* Evidence failure must not change a listen. */ }
}
/** Each namespace's page bridge (its container's), told as a listener of that namespace starts and stops listening. */
const portWatchers = new Map<string, { onListen: ListenWatcher; onClose: (port: number) => void }>();
/** A container's page bridge watches its namespace's listeners, until the function it returns runs. */
export function watchNamespacePorts(network: NetworkNamespace, onListen: ListenWatcher, onClose: (port: number) => void): () => void {
  const watcher = { onListen, onClose };
  portWatchers.set(network.id, watcher);
  return () => { if (portWatchers.get(network.id) === watcher) portWatchers.delete(network.id); };
}

/**
 * The listening handle a connect to this port of `network`'s loopback reaches, if any, and the loopback address that
 * reaches it: 127.0.0.1's listener, else ::1's (a guest bound to `::1` alone is reached there).
 */
export function listenerOnPort(port: number, network: NetworkNamespace): { listener: TCP; address: '127.0.0.1' | '::1' } | undefined {
  const v4 = listenerIn(network.id, port, 'IPv4', '127.0.0.1');
  if (v4) return { listener: v4, address: '127.0.0.1' };
  const v6 = listenerIn(network.id, port, 'IPv6', '::1');
  return v6 ? { listener: v6, address: '::1' } : undefined;
}
/** Each shared listening socket's turn: its next connection goes to the member after the last one served. */
const acceptTurns = new WeakMap<object, number>();
/** Each shared listening socket's accept queue (TCP.queueAccepted). */
const acceptQueues = new WeakMap<object, Array<{ accepted: TCP; adoptedBy: TCP | undefined }>>();

export class TCP extends LibuvStreamWrap {
  /** `constants.SOCKET` or `constants.SERVER`. */
  readonly type: number;
  listening = false;
  /** Set by `net.js` on a server handle; how an accepted pairing is announced. */
  onconnection: ((status: number, clientHandle: TCP) => void) | null = null;

  /** The network namespace the handle was made in, and keeps: its port space, its loopback, its routes. */
  #network: NetworkNamespace = currentNetworkNamespace();
  private local: SockName | null = null;
  private remote: SockName | null = null;
  /** Whether the local name was given by a connect rather than a bind: the route then chooses its address. */
  private localByConnect = false;

  constructor(type: number = constants.SOCKET) {
    super();
    this.type = type;
    this.attachNative('tcp', type);
  }

  bind(address: string, port: number, _flags?: number): number {
    const native = nativeStreamFor(this);
    if (native) return native.call({ operation: 'bind', id: native.descriptor.id, address, port, flags: _flags }).status;
    return this.bindTo(address || '0.0.0.0', port, 'IPv4', Number(_flags) || 0);
  }

  bind6(address: string, port: number, _flags?: number): number {
    const native = nativeStreamFor(this);
    if (native) return native.call({ operation: 'bind', id: native.descriptor.id, address, port, flags: _flags, ipv6: true }).status;
    return this.bindTo(address || '::', port, 'IPv6', Number(_flags) || 0);
  }

  /** The address a listener bound, which decides the connections it takes (takesConnectionTo). */
  get boundAddress(): string | undefined { return this.local?.address; }

  private bindTo(address: string, port: number, family: string, flags = 0): number {
    // bind(2) takes an address an interface of the socket's namespace holds, or a wildcard; any other is not here.
    if (!isOwnAddress(this.#network, address)) return UV_EADDRNOTAVAIL;
    const space = portSpace(this.#network.id);
    const wanted = Number(port) || 0;
    const spaces = spacesOf(space, family, flags, address);
    if (wanted !== 0 && spaces.some(ports => ports.has(wanted))) return UV_EADDRINUSE;
    if (wanted !== 0 && space.ephemeral.has(wanted)) return UV_EADDRINUSE;
    const bound = wanted === 0 ? allocatePort(space) : wanted;
    if (this.local) for (const ports of [space.v4, space.v6]) if (ports.get(this.local.port) === this) ports.delete(this.local.port);
    this.local = { address, family, port: bound };
    this.localByConnect = false;
    for (const ports of spaces) ports.set(bound, this);
    this.onLastReferenceClose(() => { for (const ports of spaces) if (ports.get(bound) === this) ports.delete(bound); });
    return 0;
  }

  listen(_backlog: number): number {
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'listen', id: native.descriptor.id, backlog: _backlog }).status;
      if (status === 0) { this.listening = true; sayListenClock(this, this.local?.port ?? null); }
      return status;
    }
    // listen(2) on a listening socket (a passed server's receiver listens on it again) only sets its backlog; what
    // was queued while nobody served it is accepted now.
    if (this.listening) { sayListenClock(this, this.local?.port ?? null); this.drainAccepted(); return 0; }
    if (!this.local) {
      const err = this.bindTo('0.0.0.0', 0, 'IPv4');
      if (err) return err;
    }
    this.listening = true;
    const refused = this.announce();
    if (refused) { this.listening = false; return refused; }
    sayListenClock(this, this.local?.port ?? null);
    return 0;
  }

  /**
   * Tells the namespace's host that this socket listens, with the door through which the host opens a connection to
   * it; a host that holds the port itself refuses it, and a host whose `listen` throws fails the listen (`EIO`) and
   * nothing else. A namespace a container's page bridge watches (watchNamespacePorts) has the port there too.
   */
  private announce(): number {
    const local = this.local;
    if (!local) return 0;
    let release: (() => void) | undefined;
    // The door holds the socket, not this handle: a listener handed to another descriptor (a passed server) is opened
    // through whichever of its members still listens.
    const end = this.connectionEnd;
    const self = this;
    let answer: number | (() => void);
    try {
      answer = this.#network.listen({
        port: local.port, address: local.address, family: local.family === 'IPv6' ? 'IPv6' : 'IPv4',
        open: (from, to) => self.openFrom(end, from, to),
      });
    } catch { return UV_EIO; }
    if (typeof answer === 'number') { if (answer !== 0) return answer; }
    else release = answer;
    const watcher = portWatchers.get(this.#network.id);
    announcements.set(this.connectionEnd, { ...(release ? { release } : {}), ...(watcher ? { watched: this.#network.id } : {}) });
    if (watcher) { try { watcher.onListen(local.port, local.address); } catch { /* a watcher that throws is not the listen's business */ } }
    return 0;
  }

  /**
   * The host's connection to the listening socket `end`: from `from`, dialled at `to`; the connector's end, or a libuv
   * status. Taken by a member of the socket that still listens, whichever descriptor the socket is now held by.
   */
  private openFrom(end: object, from: { address: string; port: number }, to: string): Socket | number {
    if (end !== this.connectionEnd) return UV_ECONNREFUSED;
    const member = this.acceptingMember();
    const local = member?.local;
    if (!member || !local || !takesConnectionTo(member, to)) return UV_ECONNREFUSED;
    const family = to.includes(':') ? 'IPv6' : 'IPv4';
    const client = inNetworkNamespace(member.#network, () => new (this.constructor as typeof TCP)(constants.SOCKET));
    // The connection is the host's, not a guest's: it holds no run open, as the page's listenNet sockets do not.
    __adoptHandle(client, null);
    client.local = { address: from.address, family, port: from.port };
    client.remote = { address: to, family, port: local.port };
    member.acceptFrom(client, to);
    return socketFor(client);
  }

  /**
   * A connection from `connector`, dialled at `to`, accepted on this listening member: the accepted end names the
   * address connected to (inet_getname on a wildcard listener's child) and the connector's address, as a dual-stack
   * socket reads an IPv4 one.
   */
  private acceptFrom(connector: TCP, to: string): void {
    const listening = this.local as SockName;
    const connectorName = connector.local as SockName;
    const accepted = new (this.constructor as typeof TCP)(constants.SOCKET);
    accepted.#network = this.#network;
    const dialled = isWildcardAddress(to) ? loopbackOf(connectorName.family) : bareAddress(to);
    accepted.local = { address: isWildcardAddress(listening.address) ? seenBy(listening.family, dialled, connectorName.family) : listening.address,
      family: listening.family, port: listening.port };
    accepted.remote = { address: seenBy(listening.family, connectorName.address, connectorName.family), family: listening.family, port: connectorName.port };
    // An accepted connection is a handle of the loop that is serving, not of the one that connected: the pairing
    // is made inside the connector's own turn, so without this the server's end would be the connecting run's
    // (its exit would close it, and it would hold that run alive). One that waits in the socket's accept queue is
    // the socket's, no run's (the kernel's, as on Linux): whichever member accepts it makes it its run's.
    __adoptHandle(accepted, this.onconnection === null ? null : ownerOf(this), this);
    LibuvStreamWrap.pair(connector, accepted);
    // A passed socket whose receiver has not yet served it (its net.Server sets onconnection, then listens):
    // the connection waits in the socket's accept queue, as a connect completes on Linux before any accept.
    if (this.onconnection === null) this.queueAccepted(accepted);
    else this.deliverAccepted(accepted, this);
  }

  connect(req: TCPConnectWrap, address: string, port: number): number {
    return this.connectTo(req, address, port, 'IPv4');
  }

  connect6(req: TCPConnectWrap, address: string, port: number): number {
    return this.connectTo(req, address, port, 'IPv6');
  }

  private connectTo(req: TCPConnectWrap, address: string, port: number, family: string): number {
    const native = nativeStreamFor(this);
    const socket = (this as unknown as Record<symbol, unknown>)[internalAsyncHooks.symbols.owner_symbol];
    const owner = ownerOfInstance(req);
    if (socket && typeof socket === 'object') rememberSocketConnect(socket, {
      pid: owner === null ? null : __runFor(owner)?.process.pid ?? null, id: native?.descriptor.id ?? null,
      socketId: (socket as Record<symbol, number>)[internalAsyncHooks.symbols.async_id_symbol] ?? null, request: null,
    });
    const complete = (status: number, request?: number): unknown => {
      const timer = (): unknown => (socket as Record<symbol, unknown> | undefined)?.[internalTimers.kTimeout];
      traceSocketConnect('binding-entered', socket, timer(), status, request);
      try { return invokeOwned(req, 'oncomplete', status, this, req, true, true); }
      finally { traceSocketConnect('binding-returned', socket, timer(), status, request); }
    };
    observeNodeRequest(req, this);
    if (native) {
      try {
        const status = native.connect(address, port, family === 'IPv6', complete);
        if (status !== 0) forgetNodeRequest(req);
        return status;
      } catch (cause) { forgetNodeRequest(req); throw cause; }
    }
    const target = Number(port);
    const network = this.#network;
    const dialled = bareAddress(address);
    // inet_hash_connect: an unbound socket takes a local port of its own namespace as it connects, and keeps it.
    if (!this.local) {
      const space = portSpace(network.id);
      const mine = allocatePort(space);
      space.ephemeral.add(mine);
      this.onLastReferenceClose(() => { space.ephemeral.delete(mine); });
      this.local = { address: loopbackOf(family), family, port: mine };
      this.localByConnect = true;
    }
    this.remote = { address, family, port: target };
    /** The address the connection leaves by, as the route chose it; a socket bound to an address keeps that one. */
    const leaveBy = (source: string): void => {
      if (this.local && (this.localByConnect || isWildcardAddress(this.local.address))) this.local = { ...this.local, address: source };
    };
    /**
     * A host's answer that came after the socket timed out or closed: a listener the host holds is handed an end that
     * closes at once, so the host releases what it opened for the connection through its own door.
     */
    const refuseLate = (answer: NamespaceConnection): void => {
      if (typeof answer !== 'object' || answer === null || !('accept' in answer)) return;
      const far = inNetworkNamespace(network, () => new (this.constructor as typeof TCP)(constants.SOCKET));
      __adoptHandle(far, null);
      let end: Socket;
      try { end = socketFor(far); answer.accept(end); } catch { far.close(); return; }
      queueBindingTask(() => { (end as unknown as { destroy(): void }).destroy(); });
    };
    /** The host's answer for a destination this namespace's listeners in this engine do not take. */
    const routed = (answer: NamespaceConnection): void => {
      if (typeof answer === 'number') { complete(answer < 0 ? answer : UV_ECONNREFUSED); return; }
      leaveBy(answer.source);
      if ('accept' in answer) {
        // A listener the host holds: the connection's far end is the host's, named as the listener it reached.
        const far = inNetworkNamespace(network, () => new (this.constructor as typeof TCP)(constants.SOCKET));
        __adoptHandle(far, null);
        far.local = { address: dialled, family, port: target };
        far.remote = { ...(this.local as SockName) };
        LibuvStreamWrap.pair(this, far);
        complete(0);
        // A host that cannot take the end it was handed resets the connection, as a peer that drops it does.
        try { answer.accept(socketFor(far)); } catch { far.reset(); }
        return;
      }
      const server = listenerIn(answer.namespace, target, family, dialled);
      if (!server) { complete(UV_ECONNREFUSED); return; }
      server.acceptFrom(this, dialled);
      complete(0);
    };
    // libuv answers a connect through the request, never from the call: a
    // refused connection is `oncomplete(UV_ECONNREFUSED)`, which is what
    // `afterConnect` turns into the socket's `ECONNREFUSED` error.
    queueBindingTask(() => {
      let pending = false;
      try {
        if (this.closed) return;
        // The namespace's own loopback and addresses are delivered inside it, to its listener on the port; the
        // loopback is left by from the loopback, an own address from itself.
        if (isOwnAddress(network, address)) {
          const server = listenerIn(network.id, target, family, dialled);
          if (server) {
            leaveBy(isLoopbackAddress(address) || isWildcardAddress(address) ? loopbackOf(family) : dialled);
            server.acceptFrom(this, dialled);
            complete(0);
            return;
          }
        }
        // The host's route. A host that throws, or whose answer fails, refuses this one socket; one that has not
        // answered when Linux would have stopped retrying its SYN fails it ETIMEDOUT. Nothing else is told.
        let answer: NamespaceConnection | Promise<NamespaceConnection>;
        try { answer = network.connect(dialled, target, family === 'IPv6' ? 6 : 4); }
        catch { complete(UV_ECONNREFUSED); return; }
        if (typeof answer === 'object' && answer !== null && typeof (answer as Promise<NamespaceConnection>).then === 'function') {
          pending = true;
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
          const settle = (finish: () => void, closedMeanwhile?: () => void): void => {
            if (settled) return;
            settled = true;
            stop();
            queueBindingTask(() => { try { if (!this.closed) finish(); else closedMeanwhile?.(); } finally { forgetNodeRequest(req); } });
          };
          // The wait is the socket's: it holds no loop open of its own, and ends with the socket.
          timer = setTimeout(() => settle(() => complete(UV_ETIMEDOUT)), CONNECT_TIMEOUT_MS);
          (timer as unknown as { unref?: () => void }).unref?.();
          this.onLastReferenceClose(() => { if (!settled) { settled = true; stop(); forgetNodeRequest(req); } });
          (answer as Promise<NamespaceConnection>).then(
            (value) => { if (settled || this.closed) refuseLate(value); else settle(() => routed(value), () => refuseLate(value)); },
            () => settle(() => complete(UV_ECONNREFUSED)));
          return;
        }
        routed(answer as NamespaceConnection);
      } finally { if (!pending) forgetNodeRequest(req); }
    });
    return 0;
  }

  /**
   * Name both ends of a pairing the engine made without a connect. The page
   * bridge's end of an upgraded connection is one: there was no `connect`, and
   * the socket an `upgrade` listener is handed still has to answer
   * `remoteAddress` and `localPort` as a connection's socket does.
   */
  adoptNames(local: SockName, remote: SockName): void {
    this.local = { ...local };
    this.remote = { ...remote };
  }

  /**
   * A listening socket passed over IPC is one socket under two descriptors, as `SCM_RIGHTS` gives it: either may
   * accept, and it listens until both are closed (net.js's receiver calls `listen` again on it; a cluster primary
   * closes its own when its workers are gone). A native listener is refused by its owner (native-stream-owner.ts).
   */
  override get listenerDuplicates(): boolean { return nativeStreamFor(this) === undefined; }

  /** The member of this handle's socket a connection is accepted on: a listening one, those net.js serves first, in turn. */
  acceptingMember(): TCP | undefined {
    const members = [this, ...this.sharingHandles].filter((handle, index, all): handle is TCP =>
      handle instanceof TCP && handle.listening && !handle.closed && all.indexOf(handle) === index);
    const serving = members.filter(handle => handle.onconnection !== null);
    const pool = serving.length ? serving : members;
    if (pool.length < 2) return pool[0];
    const turn = acceptTurns.get(this.connectionEnd) ?? 0;
    acceptTurns.set(this.connectionEnd, turn + 1);
    return pool[turn % pool.length];
  }

  /** A connection accepted on this member: its onconnection, in the serving run. */
  /** Accepted on this member: it becomes this member's run's (`adoptedBy` this member: it already is). */
  deliverAccepted(accepted: TCP, adoptedBy?: TCP): void {
    if (adoptedBy !== this) __adoptHandle(accepted, ownerOf(this), this);
    invokeOwned(this, 'onconnection', 0, accepted);
  }

  /** The socket's accept queue: connections made while none of its members was served. */
  queueAccepted(accepted: TCP): void {
    const queue = acceptQueues.get(this.connectionEnd) ?? [];
    queue.push({ accepted, adoptedBy: undefined });
    acceptQueues.set(this.connectionEnd, queue);
  }

  /** A member is served now (net.js set its onconnection, then listened): the queue drains to the serving members. */
  private drainAccepted(): void {
    const queue = acceptQueues.get(this.connectionEnd);
    if (!queue?.length) return;
    queueBindingTask(() => {
      while (queue.length) {
        const member = this.acceptingMember();
        if (!member || member.onconnection === null) return;
        const { accepted, adoptedBy } = queue.shift()!;
        if (!accepted.closed) member.deliverAccepted(accepted, adoptedBy);
      }
    });
  }

  /**
   * libuv's `dup()`: the same socket under both its names, listening where it listens. A socket bound and not yet
   * listening (cluster's shared handle, which the worker listens on) keeps its bound name, where the copy had none and
   * its `listen` bound a fresh port.
   */
  override duplicate(): TCP {
    const native = nativeStreamFor(this);
    if (native) {
      const copy = native.duplicate() as TCP;
      if (this.local && this.remote) copy.adoptNames(this.local, this.remote);
      return copy;
    }
    const copy = new (this.constructor as typeof TCP)(this.type);
    copy.#network = this.#network;
    copy.local = this.local ? { ...this.local } : null;
    copy.remote = this.remote ? { ...this.remote } : null;
    copy.shareConnectionFrom(this);
    copy.listening = this.listening;
    return copy;
  }

  getsockname(out: Partial<SockName>): number {
    const native = nativeStreamFor(this);
    if (native) {
      const result = native.call({ operation: 'getsockname', id: native.descriptor.id });
      if (result.address) Object.assign(out, result.address);
      return result.status;
    }
    if (!this.local) return UV_EINVAL;
    out.address = this.local.address;
    out.family = this.local.family;
    out.port = this.local.port;
    return 0;
  }

  getpeername(out: Partial<SockName>): number {
    const native = nativeStreamFor(this);
    if (native) {
      const result = native.call({ operation: 'getpeername', id: native.descriptor.id });
      if (result.address) Object.assign(out, result.address);
      return result.status;
    }
    if (!this.remote) return UV_EINVAL;
    out.address = this.remote.address;
    out.family = this.remote.family;
    out.port = this.remote.port;
    return 0;
  }

  /** Nothing is buffered between two handles in one realm, so there is nothing to delay. */
  setNoDelay(_enable: boolean): number {
    return 0;
  }

  /** There is no idle connection to probe: a pairing is alive while both ends are. */
  setKeepAlive(_enable: boolean, _delay: number, _interval?: number, _count?: number): number {
    return 0;
  }

  /** In-realm streams carry bytes, not IP packet headers (ADR-0003). */
  setTypeOfService(_tos: number): number { return UV_ENOTSUP; }
  getTypeOfService(): number { return UV_ENOTSUP; }

  setSimultaneousAccepts(_enable: boolean): number {
    return 0;
  }

  /** An engine handle carries no descriptor a program can hand it. */
  open(_fd: number): number {
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'open', id: native.descriptor.id, fd: _fd }).status;
      if (status === 0) this.fd = _fd;
      return status;
    }
    return UV_ENOTSUP;
  }

  /** libuv's `uv_tcp_close_reset`: the peer reads ECONNRESET rather than EOF. */
  reset(callback?: () => void): number {
    if (this.closed) return UV_EBADF;
    const native = nativeStreamFor(this);
    if (native) return native.close(callback, true);
    this.sendReset();
    this.close(callback);
    return 0;
  }

  protected override onCloseHandle(): void {
    const wasListening = this.listening;
    this.listening = false;
    this.onconnection = null;
    // A listening socket another descriptor still holds (a passed server) goes on listening.
    const shared = [...this.sharingHandles].some(handle => handle !== this && handle instanceof TCP && handle.listening);
    // The socket stopped listening: its namespace's host and, for the engine's own namespace, the page bridge are told.
    const announced = wasListening && !shared ? announcements.get(this.connectionEnd) : undefined;
    if (announced) {
      announcements.delete(this.connectionEnd);
      try { announced.release?.(); } catch { /* a host's release that throws is not the close's business */ }
      if (announced.watched !== undefined && this.local) { try { portWatchers.get(announced.watched)?.onClose(this.local.port); } catch { /* as above */ } }
    }
    // The socket's last listener closed: what waited in its accept queue is reset (inet_csk_listen_stop: its peers
    // read ECONNRESET), as Linux disconnects an unaccepted child.
    if (wasListening && !shared) { for (const { accepted } of acceptQueues.get(this.connectionEnd)?.splice(0) ?? []) if (!accepted.closed) accepted.reset(); }
  }
}

registerNativeStreamConstructor('tcp', TCP);
export default { TCP, TCPConnectWrap, constants };
