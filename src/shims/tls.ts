/**
 * tls: a namespace's network inside the tab carries no wire to protect. A TLS
 * server listens as a net server does and hands its connections on as secure;
 * a TLS connect to a destination the caller's network namespace holds (its
 * loopback, a peer on one of its networks, a name its resolver answers: the
 * one routing decision, network-namespace.ts namespaceHolds, that `net` and
 * HTTP's Agent read too) pairs with that listener the same way. Bytes cross
 * unencrypted because nothing lies between the two ends, and the browser holds
 * TLS wherever there is a wire: a page reaches a guest server through the
 * sandbox origin, and a request to another host goes out through the page's
 * HTTP transport. A TLS connect to a destination the namespace does not hold
 * fails asynchronously (`ERR_TLS_UNAVAILABLE`), rather than pretending to
 * connect and leaving Node's HTTPS client waiting forever.
 */

import { lazyExport } from '../node-lib/lazy';
import { nodeLibInternalRequire } from '../node-lib/load';
import type { Socket } from '../node-lib/net-module';
import type { EventEmitter } from '../node-lib/events-module';
import { captureNetworkContext, currentNetworkNamespace, namespaceHolds } from '../network-namespace';

/** A TLS server as Node's module exposes it: constructed with or without `new`. */
export interface TlsServer extends EventEmitter {
  listen(...args: unknown[]): this;
  close(callback?: (err?: Error) => void): this;
  address(): { port: number; family: string; address: string } | string | null;
  addContext(hostname: string, context: unknown): void;
  getTicketKeys(): Buffer;
  setTicketKeys(keys: Buffer): void;
  setSecureContext(options: unknown): void;
}
export interface TlsServerConstructor {
  new (options?: unknown, secureConnectionListener?: (socket: Socket) => void): TlsServer;
  (options?: unknown, secureConnectionListener?: (socket: Socket) => void): TlsServer;
  readonly prototype: TlsServer;
}

// Keep the ordinary stream lifecycle (error, close, destroy) from Node's own
// Socket. Resolve it lazily, like the other builtin classes, to avoid a loader
// cycle while the engine is being imported.
/** Each graph's TLS keeps that graph's Socket and Server identity. */
export function createTlsModule(require?: (name: string) => any) {
const NetSocket = require ? require('net').Socket as new (options?: object) => Socket
    : lazyExport<new (options?: object) => Socket>('net', 'Socket');
const netServer = (): any => (require ? require('net') : nodeLibInternalRequire('net') as any).Server;

class TLSSocket extends NetSocket {
  authorized = false;
  encrypted = true;
  /**
   * True from construction until the socket is secure, as Node's TLSSocket has it (`_tls_wrap.js`; Node 26:
   * `new tls.TLSSocket().secureConnecting` and a refused `tls.connect(...)` are both true). A client that waits for
   * `secureConnect` only while this is true (npm's `@npmcli/agent` races `once(socket, 'secureConnect')` against
   * `once(socket, 'error')` when it is, and resolves at once when it is not) took this socket for connected, stopped
   * listening for `error`, and the failure below reached the process as an uncaught exception: npm's `npx` exited 1
   * on its update check with no message.
   */
  secureConnecting = true;

  constructor(_socket?: unknown, _options?: unknown) {
    super({ allowHalfOpen: false });
  }

  connect(...args: unknown[]): this {
    const options = args[0] as { port?: unknown; host?: unknown; hostname?: unknown; socket?: unknown } | undefined;
    const host = String(options?.host ?? options?.hostname ?? 'localhost') || 'localhost';
    const pair = (): this => {
      // The peer is a listener of the namespace's network, or nothing: a refused port fails as a net connect does.
      this.once('connect', () => {
        this.secureConnecting = false;
        this.authorized = true;
        this.emit('secureConnect');
      });
      return (NetSocket.prototype as unknown as { connect: (this: TLSSocket, options: object) => TLSSocket })
        .connect.call(this, { port: options!.port, host }) as this;
    };
    // Never inherit a plain TCP connect while advertising an encrypted socket.
    // Agent assigns its socket on nextTick after connect returns, so failure
    // follows that assignment and reaches ClientRequest's error listener.
    const fail = (error: Error): void => { queueMicrotask(() => queueMicrotask(() => this.destroy(error))); };
    const unavailable = (): Error => Object.assign(
      new Error('TLS transport is unavailable in this runtime; HTTPS requires an admitted HTTP transport.'),
      { code: 'ERR_TLS_UNAVAILABLE' },
    );
    if (!options || typeof options !== 'object' || options.socket !== undefined) { this.connecting = true; fail(unavailable()); return this; }
    const held = namespaceHolds(currentNetworkNamespace(), host);
    if (held === true) return pair();
    this.connecting = true;
    if (held === false) { fail(unavailable()); return this; }
    // The connection is made when the resolver has answered, on the engine's loop: in the connecting call's context.
    const within = captureNetworkContext();
    held.then(own => within(() => { if (own) pair(); else fail(unavailable()); }),
      (cause: unknown) => within(() => fail(cause instanceof Error ? cause : new Error(String(cause)))));
    return this;
  }

  getPeerCertificate(_detailed?: boolean): object {
    return {};
  }

  getCipher(): { name: string; version: string } | null {
    return null;
  }

  getProtocol(): string | null {
    return null;
  }

  setServername(_name: string): void {}

  renegotiate(_options: unknown, _callback: (err: Error | null) => void): boolean {
    return false;
  }
}

// A function constructor, as Node's: its own `https.js` builds an https.Server
// by calling `tls.Server` on the instance, which a class refuses. It is a net
// server, chained to the graph's `net.Server` when the first one is built.
let chained = false;
const Server = function TLSServer(this: TlsServer, options?: unknown, secureConnectionListener?: (socket: Socket) => void): TlsServer {
  if (!(this instanceof Server)) return new Server(options, secureConnectionListener);
  const NetServer = netServer();
  if (!chained) {
    Object.setPrototypeOf(Server.prototype, NetServer.prototype);
    Object.setPrototypeOf(Server, NetServer);
    chained = true;
  }
  if (typeof options === 'function') {
    secureConnectionListener = options as (socket: Socket) => void;
    options = {};
  }
  NetServer.call(this, options ?? {}, function secure(this: TlsServer, socket: Socket & { encrypted?: boolean; authorized?: boolean }) {
    socket.encrypted = true;
    socket.authorized = false;
    // Node sets it false as a server's socket becomes secure, before `secureConnection`.
    (socket as { secureConnecting?: boolean }).secureConnecting = false;
    this.emit('secureConnection', socket);
  });
  if (secureConnectionListener) this.on('secureConnection', secureConnectionListener);
  return this;
} as unknown as TlsServerConstructor;

Object.assign(Server.prototype, {
  addContext(_hostname: string, _context: unknown) {},
  getTicketKeys() {
    return (require ? require('buffer').Buffer : Buffer).from('');
  },
  setTicketKeys(_keys: Buffer) {},
  setSecureContext(_options: unknown) {},
});

function createServer(options?: unknown, secureConnectionListener?: (socket: Socket) => void): TlsServer {
  return new Server(options, secureConnectionListener);
}

// tls.connect(options[, callback]) and tls.connect(port[, host][, options][, callback]).
function connect(...args: unknown[]): TLSSocket {
  const options: Record<string, unknown> = {};
  let callback: (() => void) | undefined;
  for (const arg of args) {
    if (typeof arg === 'function') callback = arg as () => void;
    else if (typeof arg === 'number' || (typeof arg === 'string' && options.port === undefined && /^\d+$/u.test(arg))) options.port = arg;
    else if (typeof arg === 'string') options.host = arg;
    else if (arg && typeof arg === 'object') Object.assign(options, arg);
  }
  const socket = new TLSSocket();
  if (callback) socket.once('secureConnect', callback);
  return socket.connect(options);
}

const createSecureContext = (_options?: unknown) => ({});

const getCiphers = () => ['TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256'];

const DEFAULT_ECDH_CURVE = 'auto';
const DEFAULT_MAX_VERSION = 'TLSv1.3';
const DEFAULT_MIN_VERSION = 'TLSv1.2';

const rootCertificates: string[] = [];

// Node's certificate-store door, read by callers that build their own agents
// (VS Code's proxy agent, on every fetch it patches). The engine holds no
// store: certificates are the browser's, so every kind answers the same empty
// set `rootCertificates` does.
const getCACertificates = (type: string = 'default'): string[] => {
  if (!['default', 'system', 'bundled', 'extra'].includes(type)) {
    throw Object.assign(new TypeError(`The argument 'type' must be one of: 'default', 'system', 'bundled', 'extra'. Received '${String(type)}'`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  return [];
};

return {
  TLSSocket,
  Server,
  createServer,
  connect,
  createSecureContext,
  getCiphers,
  getCACertificates,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  rootCertificates,
};

}
const tls = createTlsModule();
export const { TLSSocket, Server, createServer, connect, createSecureContext, getCiphers, getCACertificates,
  DEFAULT_ECDH_CURVE, DEFAULT_MAX_VERSION, DEFAULT_MIN_VERSION, rootCertificates } = tls;
export type TLSSocket = InstanceType<typeof TLSSocket>;
export type Server = InstanceType<typeof Server>;
export default tls;
