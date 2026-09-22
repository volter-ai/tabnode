/**
 * tls shim - TLS/SSL is not available in browser
 * No TLS transport is installed. A connection must fail asynchronously rather
 * than pretending to connect and leaving Node's HTTPS client waiting forever.
 */

import { EventEmitter } from '../node-lib/events-module';
import { lazyExport } from '../node-lib/lazy';
import type { Socket } from '../node-lib/net-module';

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

class Server extends Events {
  constructor(_options?: unknown, _connectionListener?: (socket: TLSSocket) => void) {
    super();
  }

  listen(..._args: unknown[]): this {
    return this;
  }

  close(_callback?: (err?: Error) => void): this {
    return this;
  }

  address(): { port: number; family: string; address: string } | string | null {
    return null;
  }

  getTicketKeys(): Buffer {
    return (require ? require('buffer').Buffer : Buffer).from('');
  }

  setTicketKeys(_keys: Buffer): void {}

  setSecureContext(_options: unknown): void {}
}

function createServer(_options?: unknown, _connectionListener?: (socket: TLSSocket) => void): Server {
  return new Server(_options, _connectionListener);
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

return {
  TLSSocket,
  Server,
  createServer,
  connect,
  createSecureContext,
  getCiphers,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  rootCertificates,
};

}
const tls = createTlsModule();
export const { TLSSocket, Server, createServer, connect, createSecureContext, getCiphers,
  DEFAULT_ECDH_CURVE, DEFAULT_MAX_VERSION, DEFAULT_MIN_VERSION, rootCertificates } = tls;
export type TLSSocket = InstanceType<typeof TLSSocket>;
export type Server = InstanceType<typeof Server>;
export default tls;
