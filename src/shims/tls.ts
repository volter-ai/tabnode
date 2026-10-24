/**
 * tls: a tab's loopback carries no wire to protect. A TLS server listens on
 * the engine's loopback as a net server does and hands its connections on as
 * secure; a TLS connect to a loopback port pairs with that listener the same
 * way. Bytes cross unencrypted because nothing lies between the two ends, and
 * the browser holds TLS wherever there is a wire: a page reaches a guest
 * server through the sandbox origin, and a request to another host goes out
 * through the page's HTTP transport. A TLS connect to any other host fails
 * asynchronously, rather than pretending to connect and leaving Node's HTTPS
 * client waiting forever.
 */

import { lazyExport } from '../node-lib/lazy';
import { nodeLibInternalRequire } from '../node-lib/load';
import type { Socket } from '../node-lib/net-module';
import type { EventEmitter } from '../node-lib/events-module';

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

/** The names a loopback connect reaches, as the engine's tcp_wrap answers them. */
function loopback(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const name = bare.toLowerCase();
  return name === '' || name === 'localhost' || name === '::1' || name.startsWith('127.');
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

  constructor(_socket?: unknown, _options?: unknown) {
    super({ allowHalfOpen: false });
  }

  connect(...args: unknown[]): this {
    const options = args[0] as { port?: unknown; host?: unknown; hostname?: unknown; socket?: unknown } | undefined;
    const host = String(options?.host ?? options?.hostname ?? 'localhost');
    if (options && typeof options === 'object' && options.socket === undefined && loopback(host)) {
      // The peer is a listener of this engine, or nothing: a refused port
      // fails as a net connect does.
      this.once('connect', () => {
        this.authorized = true;
        this.emit('secureConnect');
      });
      return (NetSocket.prototype as unknown as { connect: (this: TLSSocket, options: object) => TLSSocket })
        .connect.call(this, { port: options.port, host }) as this;
    }
    this.connecting = true;
    // Never inherit a plain TCP connect while advertising an encrypted socket.
    // Agent assigns its socket on nextTick after connect returns, so failure
    // follows that assignment and reaches ClientRequest's error listener.
    queueMicrotask(() => queueMicrotask(() => this.destroy(Object.assign(
      new Error('TLS transport is unavailable in this runtime; HTTPS requires an admitted HTTP transport.'),
      { code: 'ERR_TLS_UNAVAILABLE' },
    ))));
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
