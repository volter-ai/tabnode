/**
 * tls shim - TLS/SSL is not available in browser
 * No TLS transport is installed. A connection must fail asynchronously rather
 * than pretending to connect and leaving Node's HTTPS client waiting forever.
 */

import { EventEmitter } from '../node-lib/events-module';
import { lazyExport } from '../node-lib/lazy';
import type { Socket } from '../node-lib/net-module';

/** A TLS server as Node's module exposes it: constructed with or without `new`. */
export interface TlsServer extends EventEmitter {
  listen(...args: unknown[]): this;
  close(callback?: (err?: Error) => void): this;
  address(): { port: number; family: string; address: string } | string | null;
  getTicketKeys(): Buffer;
  setTicketKeys(keys: Buffer): void;
  setSecureContext(options: unknown): void;
}
export interface TlsServerConstructor {
  new (options?: unknown, connectionListener?: (socket: Socket) => void): TlsServer;
  (options?: unknown, connectionListener?: (socket: Socket) => void): TlsServer;
  readonly prototype: TlsServer;
}

// Keep the ordinary stream lifecycle (error, close, destroy) from Node's own
// Socket. Resolve it lazily, like the other builtin classes, to avoid a loader
// cycle while the engine is being imported.
/** Native TLS refusal keeps the requesting graph's Socket identity. */
export function createTlsModule(require?: (name: string) => any) {
const NetSocket = require ? require('net').Socket as new (options?: object) => Socket
    : lazyExport<new (options?: object) => Socket>('net', 'Socket');
const Events = require ? require('events').EventEmitter as typeof EventEmitter : EventEmitter;

class TLSSocket extends NetSocket {
  authorized = false;
  encrypted = true;

  constructor(_socket?: unknown, _options?: unknown) {
    super({ allowHalfOpen: false });
  }

  connect(..._args: unknown[]): this {
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
// by calling `tls.Server` on the instance, which a class refuses.
const Server = function TLSServer(this: TlsServer, options?: unknown, connectionListener?: (socket: Socket) => void): TlsServer {
  if (!(this instanceof Server)) return new Server(options, connectionListener);
  (Events as unknown as (this: TlsServer) => void).call(this);
  return this;
} as unknown as TlsServerConstructor;
Object.setPrototypeOf(Server.prototype, Events.prototype);
Object.setPrototypeOf(Server, Events);

Object.assign(Server.prototype, {
  // No TLS transport terminates a connection here, so a server that said it
  // listened would take connections it can never read; it fails as a bound
  // port does, asynchronously, with the reason.
  listen(this: TlsServer, ..._args: unknown[]) {
    queueMicrotask(() => this.emit('error', Object.assign(
      new Error('TLS server is unavailable in this runtime: no TLS transport terminates connections in the tab, so an https or tls server cannot listen. Serve over http; the browser holds TLS.'),
      { code: 'ERR_TLS_UNAVAILABLE' },
    )));
    return this;
  },
  close(this: TlsServer, callback?: (err?: Error) => void) {
    if (callback) queueMicrotask(() => callback());
    return this;
  },
  address() {
    return null;
  },
  getTicketKeys() {
    return (require ? require('buffer').Buffer : Buffer).from('');
  },
  setTicketKeys(_keys: Buffer) {},
  setSecureContext(_options: unknown) {},
});

function createServer(options?: unknown, connectionListener?: (socket: Socket) => void): TlsServer {
  return new Server(options, connectionListener);
}

function connect(_options: unknown, _callback?: () => void): TLSSocket {
  const socket = new TLSSocket();
  if (_callback) socket.once('secureConnect', _callback);
  return socket.connect();
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
