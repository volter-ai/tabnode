/**
 * tls, as Node's `lib/internal/tls/wrap.js` arranges it: a TLSSocket is a `net.Socket` whose handle is a TLSWrap over
 * the TCP handle of a kernel connection (one the socket makes with Node's own `net`, one a TLS server accepted, or the
 * socket it was given), and the TLS on that connection is the process's host's (`TREE_TLS`, host-tls.ts; ADR-0009 §3).
 * Node's TLSWrap is C++ over OpenSSL; this one is the same stream contract over the host's TLS: the connection's bytes
 * go to the session, the session's records go to the connection, and the decrypted bytes are this handle's reads.
 *
 * A client's roots are the CA file the process's root holds (`/etc/ssl/certs/ca-certificates.crt`) and the file
 * `NODE_EXTRA_CA_CERTS` names, read through the process's own files; a `ca` the program passes replaces them, as in
 * Node. A server answers with the program's own `key` and `cert`. A tree that offers no TLS is a Node without TLS: a
 * handshake fails `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
 */

import { lazyExport } from '../node-lib/lazy';
import { nodeLibBindingFor, nodeLibInternalRequire, nodeLibProcessOf } from '../node-lib/load';
import type { Socket } from '../node-lib/net-module';
import type { EventEmitter } from '../node-lib/events-module';
import { internalAsyncHooks } from '../node-lib/internals/runtime';
import {
  LibuvStreamWrap, ShutdownWrap, WriteWrap, streamBaseState, kArrayBufferOffset, kBytesWritten, kLastWriteWasAsync,
  kReadBytesOrError,
} from '../node-lib/binding/stream_wrap';
import { DuplexStreamHandle } from '../node-lib/binding/duplex_stream';
import { forgetNodeHandle, invokeOwned, unrefHandle } from '../node-lib/binding/handles';
import { UV_EBADF, UV_EOF } from '../node-lib/binding/uv';
import { kRunFilesystem } from '../node-lib/binding/fs';
import { namedTree } from '../node-lib/binding/named-tree';
import { callingSockets, type TreeSockets } from '../host-sockets';
import { queueBindingTask, withGuestCallback } from '../guest-loop';
import { treeTlsOf, type TlsClientSession, type TlsSecureConnection, type TlsServerSecureConnection, type TlsServerSession, type TlsTransport } from '../host-tls';

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

/** The handle a TLSWrap runs over: a TCP or Pipe handle, or a JS stream's (libuv's stream contract). */
type StreamHandle = LibuvStreamWrap & Record<string, unknown> & { reading: boolean };
type WrappedSocket = Socket & { _handle: StreamHandle | null; connecting: boolean; allowHalfOpen: boolean; _host?: string };
type Options = Record<string, any>;

const owner_symbol = internalAsyncHooks.symbols.owner_symbol;
const SYSTEM_CA_FILE = '/etc/ssl/certs/ca-certificates.crt';
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

/** Node's `tls.convertALPNProtocols` read the other way: the protocols, from an array of names or the wire format. */
function alpnProtocols(value: unknown): string[] | undefined {
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  if (Array.isArray(value)) return value.map(entry => typeof entry === 'string' ? entry : decode(entry as Uint8Array));
  if (!ArrayBuffer.isView(value)) return undefined;
  const wire = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const out: string[] = [];
  for (let at = 0; at < wire.byteLength; at += 1 + wire[at]!) out.push(decode(wire.subarray(at + 1, at + 1 + wire[at]!)));
  return out;
}

/**
 * The ports a TLS server listens on, by the socket calls of the process whose handle listens: what the engine's own
 * TLS servers said as they began listening, as `tcp_wrap` tells a page bridge a port (`watchListens`). A bridge that
 * reaches a port its tree's process listens on with TLS reaches it as a TLS client.
 */
const tlsListeners = new WeakMap<TreeSockets, Map<number, number>>();
export function listensWithTls(sockets: TreeSockets, port: number): boolean {
  return (tlsListeners.get(sockets)?.get(port) ?? 0) > 0;
}
function announceTlsListener(sockets: TreeSockets, port: number, change: 1 | -1): void {
  let ports = tlsListeners.get(sockets);
  if (!ports) tlsListeners.set(sockets, ports = new Map());
  const count = (ports.get(port) ?? 0) + change;
  if (count > 0) ports.set(port, count); else ports.delete(port);
}

/** The handlers a TLSWrap reports its session to: its socket's. */
interface SessionOwner {
  secure(): void;
  error(error: Error): void;
}
/** A client's handshake outcome, or a server's. */
type Secured = TlsSecureConnection | TlsServerSecureConnection;

/**
 * Node's TLSWrap: a stream over its parent stream's bytes. A TLSWrap is not a handle of the loop: its parent holds
 * the loop, and `ref`, `unref` and the socket calls are the parent's.
 */
class TLSWrap extends LibuvStreamWrap {
  #session: TlsClientSession | TlsServerSession | null = null;
  #owner: SessionOwner | null = null;
  /** What the process wrote before the handshake began, and what the parent's socket held before it was wrapped. */
  #clear: Uint8Array[] = [];
  #encrypted: Uint8Array[] = [];
  /** The handshake's outcome, once it is done. */
  secured: Secured | null = null;

  constructor(readonly _parent: StreamHandle, readonly _parentWrap: WrappedSocket | null) {
    super();
    unrefHandle(this);
    forgetNodeHandle(this);
  }

  /** Begins the handshake over the parent's bytes: a client's (`TreeTls.connect`) or a server's (`TreeTls.serve`). */
  start(open: (transport: TlsTransport) => TlsClientSession | TlsServerSession, owner: SessionOwner): void {
    if (this.closed || this.#session) return;
    const parent = this._parent;
    this.#owner = owner;
    const session = open({
      write: bytes => this.#send(bytes),
      end: () => this.#shutdownParent(),
      close: () => {},
    });
    this.#session = session;
    session.plain.onData(bytes => this.receive(bytes));
    session.plain.onEnd(() => this.receiveEof());
    session.plain.onError(error => { if (!this.closed) owner.error(error); });
    (session.secure as Promise<Secured>).then(connection => {
      if (this.closed) return;
      this.secured = connection;
      owner.secure();
    }, () => {});
    parent.onread = (buffer: ArrayBuffer | null) => this.#parentRead(buffer);
    for (const bytes of this.#encrypted.splice(0)) session.receive(bytes);
    for (const bytes of this.#clear.splice(0)) session.plain.write(bytes);
    const status = parent.readStart();
    if (status < 0) owner.error(this.#errno(status, 'read'));
  }

  /** Bytes the wrapped socket had read before it was wrapped: the server's, for the session. */
  receiveEncrypted(bytes: Uint8Array): void {
    if (this.#session) this.#session.receive(bytes);
    else this.#encrypted.push(bytes);
  }

  #errno(status: number, syscall: string): Error {
    const { ErrnoException } = nodeLibInternalRequire('internal/errors') as { ErrnoException: new (status: number, syscall: string) => Error };
    return new ErrnoException(status, syscall);
  }

  #parentRead(buffer: ArrayBuffer | null): void {
    const session = this.#session;
    const nread = streamBaseState[kReadBytesOrError]!;
    if (!session || this.closed) return;
    if (nread > 0) session.receive(new Uint8Array(buffer!, streamBaseState[kArrayBufferOffset]!, nread).slice());
    else if (nread === UV_EOF) session.receiveEnd();
    else if (nread < 0) {
      session.receiveClose();
      this.receiveError(nread);
    }
  }

  /** A record the client wrote, onto the parent's connection. */
  #send(bytes: Uint8Array): void {
    if (this.closed) return;
    const request = new WriteWrap();
    request.handle = this._parent;
    request.oncomplete = (status: number) => { if (status < 0 && !this.closed) this.#owner?.error(this.#errno(status, 'write')); };
    const status = this._parent.writeBuffer(request, bytes);
    if (status < 0) this.#owner?.error(this.#errno(status, 'write'));
  }

  #shutdownParent(): void {
    if (this.closed) return;
    const request = new ShutdownWrap();
    request.handle = this._parent;
    request.oncomplete = () => {};
    this._parent.shutdown(request);
  }

  override readStart(): number {
    const status = super.readStart();
    if (status === 0 && this.#session) this._parent.readStart();
    return status;
  }

  /** The handshake reads the parent whatever the socket's reader wants; after it, the reader's pause is the parent's. */
  override readStop(): number {
    super.readStop();
    if (this.secured) this._parent.readStop();
    return 0;
  }

  /** The process's bytes, taken whole by the client, which holds them until the handshake is done. */
  protected override dispatchWrite(_req: WriteWrap, buffer: Uint8Array): number {
    streamBaseState[kBytesWritten] = buffer.byteLength;
    streamBaseState[kLastWriteWasAsync] = 0;
    if (this.closed) return UV_EBADF;
    const bytes = buffer.slice();
    if (this.#session) this.#session.plain.write(bytes);
    else this.#clear.push(bytes);
    this.bytesWritten += bytes.byteLength;
    return 0;
  }

  /** close_notify, then the parent's write side. */
  override shutdown(req: ShutdownWrap): number {
    if (this.closed) return UV_EBADF;
    if (this.#session) this.#session.plain.end();
    else this.#shutdownParent();
    queueBindingTask(() => { invokeOwned(req, 'oncomplete', 0); });
    return 0;
  }

  /** Closing the wrap closes what it runs over: the wrapped socket, or the parent handle. */
  override close(callback?: () => void): void {
    if (this.closed) return;
    super.close();
    this.#session?.receiveClose();
    const wrapped = this._parentWrap;
    if (wrapped && wrapped._handle === null) {
      if (callback) queueBindingTask(() => withGuestCallback(callback));
      return;
    }
    if (wrapped && wrapped._handle === this._parent) {
      if (callback) wrapped.once('close', callback);
      wrapped.destroy();
      return;
    }
    (this._parent.close as (callback?: () => void) => void)(callback);
  }

  override ref(): void { (this._parent.ref as () => void)(); }
  override unref(): void { (this._parent.unref as () => void)(); }
  override hasRef(): boolean { return (this._parent.hasRef as () => boolean)(); }
}

// Node's TLSWrap proxies its parent's handle and socket calls (`proxiedMethods`).
for (const name of ['open', 'bind', 'listen', 'connect', 'bind6', 'connect6', 'getsockname', 'getpeername', 'setNoDelay',
  'setKeepAlive', 'setSimultaneousAccepts', 'setBlocking']) {
  Object.defineProperty(TLSWrap.prototype, name, {
    value: function methodProxy(this: TLSWrap, ...args: unknown[]) {
      const method = this._parent[name];
      if (typeof method === 'function') return Reflect.apply(method, this._parent, args);
      return undefined;
    },
    writable: true, configurable: true,
  });
}

/** Each graph's TLS keeps that graph's Socket and Server identity. */
export function createTlsModule(require?: (name: string) => any) {
const need = (name: string): any => require ? require(name) : nodeLibInternalRequire(name);
const NetSocket = require ? require('net').Socket as new (options?: object) => Socket
    : lazyExport<new (options?: object) => Socket>('net', 'Socket');
const netServer = (): any => need('net').Server;
/** The process this graph is: its environment, its files and its tree. */
const processOf = (): Record<string | symbol, any> => require ? require('process') : nodeLibProcessOf();
const errors = (): any => need('internal/errors');

/** The roots a connect verifies against where the program names none: the image's CA file and NODE_EXTRA_CA_CERTS. */
let rootsRead: { system: string; extra: string } | undefined;
const defaultRoots = (): { system: string; extra: string } => {
  if (rootsRead) return rootsRead;
  const fs = need('fs');
  const process = processOf();
  let system = '';
  try { system = String(fs.readFileSync(SYSTEM_CA_FILE, 'latin1')); } catch { /* an image with no CA file has no roots */ }
  let extra = '';
  const file = process.env?.NODE_EXTRA_CA_CERTS;
  if (file) {
    try { extra = String(fs.readFileSync(file, 'latin1')); }
    catch (error) { process.emitWarning?.(`Ignoring extra certs from \`${file}\`, load failed: ${(error as Error).message}`); }
  }
  return rootsRead = { system, extra };
};
const certificatesIn = (pem: string): string[] => (pem.match(PEM_CERTIFICATE) ?? []).map(entry => `${entry}\n`);
/**
 * Node's `SecureContext`: what `tls.createSecureContext(options)` holds, `ca`, `key` and `cert`, for a connect or a
 * server to use in place of its own options (`secureContext`).
 */
const contexts = new WeakMap<object, Options>();
class SecureContext {
  context = {};
  constructor(options: Options) { contexts.set(this, { ca: options.ca, key: options.key, cert: options.cert }); }
}
const secureContextOf = (options: Options): Options => (options.secureContext && contexts.get(options.secureContext)) || options;
const pemOf = (ca: unknown): string => (Array.isArray(ca) ? ca : [ca]).map(entry => typeof entry === 'string' ? entry
  : new TextDecoder('latin1').decode(entry as Uint8Array)).join('\n');

/** Node's `getAllowUnauthorized`: NODE_TLS_REJECT_UNAUTHORIZED=0 turns verification off, with a warning, once. */
let warnedUnauthorized = false;
const allowUnauthorized = (): boolean => {
  const process = processOf();
  const allow = process.env?.NODE_TLS_REJECT_UNAUTHORIZED === '0';
  if (allow && !warnedUnauthorized) {
    warnedUnauthorized = true;
    process.emitWarning?.("Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections "
      + 'and HTTPS requests insecure by disabling certificate verification.');
  }
  return allow;
};

/** What `tls.connect` was asked (Node's `kConnectOptions`), and the name `setServername` gave, per socket. */
const connectOptions = new WeakMap<object, Options>();
const servernames = new WeakMap<object, string>();
/** Node's `getSessionServerIdentity`: the name the server's certificate must carry. */
const serverIdentity = (options: Options): string => options.servername || options.host || options.socket?._host || 'localhost';

let reinitializeInstalled = false;

class TLSSocket extends NetSocket {
  _tlsOptions: Options;
  _secureEstablished = false;
  _hadError = false;
  secureConnecting = true;
  servername: string | null = null;
  alpnProtocol: string | false | null = null;
  authorized = false;
  authorizationError: string | null = null;
  encrypted = true;
  ssl: TLSWrap | null;
  /** The tree whose TLS this socket's session is: the one named for the call that made it, else its process's. */
  _tree: unknown;

  constructor(socket?: unknown, options?: Options) {
    const tlsOptions: Options = { ...options };
    let wrapped: WrappedSocket | null = null;
    let parent: StreamHandle;
    let created = false;
    if (socket) {
      if (socket instanceof NetSocket && (socket as WrappedSocket)._handle) {
        wrapped = socket as WrappedSocket;
        parent = wrapped._handle!;
      } else {
        // A stream with no handle of its own (an unconnected socket, a JS Duplex) runs as a stream handle, as Node's
        // JSStreamSocket makes one.
        parent = new DuplexStreamHandle(socket as ConstructorParameters<typeof DuplexStreamHandle>[0]) as unknown as StreamHandle;
      }
    } else {
      const { TCP, constants } = nodeLibBindingFor(processOf(), 'tcp_wrap') as { TCP: new (type: number) => StreamHandle; constants: { SOCKET: number } };
      parent = new TCP(constants.SOCKET);
      created = true;
    }
    const wrap = new TLSWrap(parent, wrapped);
    super({
      handle: wrap,
      allowHalfOpen: socket ? (socket as WrappedSocket).allowHalfOpen : tlsOptions.allowHalfOpen,
      pauseOnCreate: tlsOptions.pauseOnConnect,
      manualStart: true,
      highWaterMark: tlsOptions.highWaterMark,
      onread: socket ? null : tlsOptions.onread,
      signal: tlsOptions.signal,
      noDelay: tlsOptions.noDelay,
      keepAlive: tlsOptions.keepAlive,
      keepAliveInitialDelay: tlsOptions.keepAliveInitialDelay,
    });
    installReinitialize();
    if (created) (parent as unknown as Record<symbol, unknown>)[owner_symbol] = this;
    this._tlsOptions = tlsOptions;
    this.ssl = wrap;
    this._tree = namedTree() ?? processOf()[kRunFilesystem];
    if (socket instanceof NetSocket) {
      const net = socket as WrappedSocket;
      this.connecting = net.connecting || !net._handle;
      net.once('connect', () => { this.connecting = false; this.emit('connect'); });
    }
    if (socket) {
      (socket as Socket).on('close', () => this.destroy());
      (socket as Socket).on('error', (error: Error) => {
        // Before a server's handshake is done its socket's failure is the server's `tlsClientError` (Node's
        // `_tlsError` holds it while control is not released).
        if (!tlsOptions.isServer || this._secureEstablished) { this.emit('error', error); return; }
        if (this._hadError) return;
        this._hadError = true;
        (tlsOptions.server as EventEmitter).emit('tlsClientError', error, this);
        this.destroy();
      });
    } else this.connecting = true;
    // Read on the next tick, so the caller has a chance to set up its listeners; what the wrapped socket already read
    // is the server's.
    const initRead = (): void => {
      if (!this._handle) return;
      if (tlsOptions.isServer) this._start();
      if (wrapped && (wrapped as unknown as { readableLength: number }).readableLength) {
        let chunk: Uint8Array | null;
        while ((chunk = (wrapped as unknown as { read(): Uint8Array | null }).read()) !== null) wrap.receiveEncrypted(chunk);
      }
      (this as unknown as { read(size: number): unknown }).read(0);
    };
    processOf().nextTick(initRead);
  }

  /** Begins the handshake once the connection is made: the client's hello, or a server's wait for one. */
  _start(): void {
    if (this.connecting) { this.once('connect', () => this._start()); return; }
    const wrap = (this as unknown as { _handle: TLSWrap | null })._handle;
    if (!wrap) return;
    const tls = treeTlsOf(this._tree);
    if (!tls) { this.destroy(new (errors().codes.ERR_FEATURE_UNAVAILABLE_ON_PLATFORM)('TLS')); return; }
    const options = connectOptions.get(this) ?? this._tlsOptions;
    const protocols = alpnProtocols(options.ALPNProtocols);
    if (this._tlsOptions.isServer) {
      const server = this._tlsOptions.server as EventEmitter;
      const context = secureContextOf(options);
      const pem = (value: unknown): Uint8Array => new TextEncoder().encode(value === undefined || value === null ? '' : pemOf(value));
      wrap.start(transport => tls.serve(transport, { key: pem(context.key), cert: pem(context.cert), ...(protocols ? { protocols } : {}) }), {
        secure: () => this._finishInit(),
        error: (error) => {
          if (this._hadError) return;
          this._hadError = true;
          // Node's `onSocketTLSError`: a handshake that fails is the server's `tlsClientError`, and the socket goes.
          if (!this._secureEstablished) server.emit('tlsClientError', error, this);
          this.destroy(this._secureEstablished ? error : undefined);
        },
      });
      return;
    }
    const roots = secureContextOf(options).ca;
    const ca = roots !== undefined && roots !== null ? pemOf(roots) : `${defaultRoots().system}\n${defaultRoots().extra}`;
    const host = String(serverIdentity({ ...options, servername: servernames.get(this) ?? options.servername })).replace(/^\[|\]$/gu, '');
    // A program's own `checkServerIdentity` is asked about a chain that verified, as Node asks it; without one the
    // client applies Node's.
    const ownCheck = typeof options.checkServerIdentity === 'function';
    wrap.start(transport => tls.connect(transport, {
      servername: host,
      ca: new TextEncoder().encode(ca),
      rejectUnauthorized: ownCheck ? false : options.rejectUnauthorized !== false,
      ...(protocols ? { protocols } : {}),
    }), {
      secure: () => this._finishInit(),
      error: (error) => {
        if (this._hadError) return;
        this._hadError = true;
        this.destroy(error);
      },
    });
  }

  _finishInit(): void {
    const secured = this.ssl?.secured;
    if (!secured) return;
    this.alpnProtocol = secured.alpnProtocol;
    if (this.servername === null) this.servername = 'servername' in secured ? secured.servername || null : servernames.get(this) ?? null;
    this._secureEstablished = true;
    this.emit('secure');
  }

  /** The peer's certificate, as the session describes it, in Node's shape; with `detailed`, its issuers linked. */
  getPeerCertificate(detailed?: boolean): object | null {
    if (!this.ssl) return null;
    const secured = this.ssl.secured;
    const certificates = secured && 'certificates' in secured ? secured.certificates : [];
    if (certificates.length === 0) return {};
    const Buffer = need('buffer').Buffer;
    const names = (name: Readonly<Record<string, string | readonly string[]>>): object => Object.assign(Object.create(null), name);
    const chain: Record<string, unknown>[] = (detailed ? certificates : certificates.slice(0, 1)).map(certificate => ({
      ...certificate, subject: names(certificate.subject), issuer: names(certificate.issuer), raw: Buffer.from(certificate.raw),
    }));
    for (let index = 0; index + 1 < chain.length; index += 1) chain[index]!.issuerCertificate = chain[index + 1];
    return chain[0]!;
  }

  getCipher(): { name: string; standardName: string; version: string } | null {
    const secured = this.ssl?.secured;
    return secured ? { name: secured.cipher, standardName: secured.cipher, version: secured.version } : null;
  }

  getProtocol(): string | null {
    return this.ssl?.secured?.version ?? null;
  }

  isSessionReused(): boolean {
    return false;
  }

  setServername(name: string): void {
    if (typeof name !== 'string') throw new (errors().codes.ERR_INVALID_ARG_TYPE)('name', 'string', name);
    servernames.set(this, name);
  }

  renegotiate(_options: unknown, _callback: (err: Error | null) => void): boolean {
    return false;
  }
}

/**
 * A connect to a name that resolves to several addresses tries each on a TCP handle of its own (`net.js`
 * internalConnectMultiple); each is wrapped as the first was (`TLSSocket.prototype[kReinitializeHandle]`).
 */
function installReinitialize(): void {
  if (reinitializeInstalled) return;
  reinitializeInstalled = true;
  const { kReinitializeHandle } = need('internal/net') as { kReinitializeHandle: symbol };
  const reinitialize = (NetSocket.prototype as unknown as Record<symbol, (handle: unknown) => void>)[kReinitializeHandle]!;
  Object.defineProperty(TLSSocket.prototype, kReinitializeHandle, {
    value: function reinitializeHandle(this: TLSSocket, handle: StreamHandle) {
      handle[owner_symbol as unknown as string] = this;
      const wrap = new TLSWrap(handle, null);
      this.ssl = wrap;
      reinitialize.call(this, wrap);
    },
    writable: true, configurable: true,
  });
}

/** Node's `onConnectSecure`: the verification's outcome, then `secureConnect`. */
function onConnectSecure(this: TLSSocket): void {
  const options = connectOptions.get(this)!;
  const secured = this.ssl!.secured as TlsSecureConnection;
  let verifyError: (Error & { code?: string }) | null | undefined = secured.authorizationError ?? null;
  if (typeof options.checkServerIdentity === 'function' && (!verifyError || verifyError.code === 'ERR_TLS_CERT_ALTNAME_INVALID')) {
    verifyError = options.checkServerIdentity(serverIdentity(options), this.getPeerCertificate(true));
  }
  if (verifyError) {
    this.authorized = false;
    this.authorizationError = verifyError.code || verifyError.message;
    if (options.rejectUnauthorized !== false) { this.destroy(verifyError); return; }
  } else this.authorized = true;
  this.secureConnecting = false;
  this.emit('secureConnect');
  (this as unknown as EventEmitter).removeListener('end', onConnectEnd);
}

/** Node's `onConnectEnd`: the server went before the handshake was done. */
function onConnectEnd(this: TLSSocket): void {
  if (this._hadError) return;
  const options = connectOptions.get(this)!;
  this._hadError = true;
  const error = new (errors().ConnResetException)('Client network socket disconnected before secure TLS connection was established');
  Object.assign(error, { path: options.path, host: options.host, port: options.port, localAddress: options.localAddress });
  this.destroy(error);
}

/** What a server's `setSecureContext` was given: the key, chain and roots its connections answer with. */
const serverContexts = new WeakMap<object, Options>();

// A function constructor, as Node's: its own `https.js` builds an https.Server by calling `tls.Server` on the
// instance, which a class refuses. It is a net server whose connections are TLS sockets (Node's
// `tlsConnectionListener`), chained to the graph's `net.Server` when the first one is built.
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
  const given = (options ?? {}) as Options;
  NetServer.call(this, given, tlsConnectionListener);
  this.setSecureContext(given);
  if (secureConnectionListener) this.on('secureConnection', secureConnectionListener);
  return this;
} as unknown as TlsServerConstructor;

/** Node's `tlsConnectionListener`: each accepted connection is a server-side TLS socket over it. */
function tlsConnectionListener(this: TlsServer, raw: Socket): void {
  const context = serverContexts.get(this) ?? {};
  const socket = new TLSSocket(raw, { ...context, isServer: true, server: this, pauseOnConnect: (this as unknown as { pauseOnConnect?: boolean }).pauseOnConnect });
  (socket as unknown as EventEmitter).on('secure', onServerSocketSecure);
}

/** Node's `onServerSocketSecure`: a handshake done is the server's `secureConnection`. */
function onServerSocketSecure(this: TLSSocket): void {
  if ((this as unknown as { destroyed: boolean }).destroyed) return;
  this.secureConnecting = false;
  (this._tlsOptions.server as EventEmitter).emit('secureConnection', this);
}

Object.assign(Server.prototype, {
  /** Node's `listen`, which also says, once listening, that the port answers TLS. */
  listen(this: TlsServer, ...args: unknown[]) {
    const sockets = callingSockets();
    if (sockets) {
      this.once('listening', () => {
        const address = this.address();
        if (address === null || typeof address !== 'object') return;
        announceTlsListener(sockets, address.port, 1);
        this.once('close', () => announceTlsListener(sockets, address.port, -1));
      });
    }
    return netServer().prototype.listen.apply(this, args);
  },
  addContext(_hostname: string, _context: unknown) {},
  getTicketKeys() {
    return need('buffer').Buffer.from('');
  },
  setTicketKeys(_keys: Buffer) {},
  setSecureContext(this: TlsServer, options: Options) {
    const context = secureContextOf(options ?? {});
    serverContexts.set(this, { key: context.key, cert: context.cert, ca: context.ca, ALPNProtocols: options?.ALPNProtocols });
  },
});

function createServer(options?: unknown, secureConnectionListener?: (socket: Socket) => void): TlsServer {
  return new Server(options, secureConnectionListener);
}

/** Node's `normalizeConnectArgs`: `[port,] [host,] [options,] [cb]`, the TLS options merged over net's. */
function normalizeConnectArgs(listArgs: unknown[]): [Options, (() => void)?] {
  const args = need('net')._normalizeArgs(listArgs) as [Options, (() => void)?];
  const options = args[0];
  const extra = listArgs[1] !== null && typeof listArgs[1] === 'object' ? listArgs[1] : listArgs[2];
  Object.assign(options, extra);
  return args;
}

// tls.connect(options[, callback]) and tls.connect(port[, host][, options][, callback]), as Node's.
function connect(...args: unknown[]): TLSSocket {
  const [given, callback] = normalizeConnectArgs(args);
  const options: Options = { rejectUnauthorized: !allowUnauthorized(), ...given };
  options.rejectUnauthorized = options.rejectUnauthorized !== false;
  const socket = new TLSSocket(options.socket, {
    allowHalfOpen: options.allowHalfOpen,
    rejectUnauthorized: options.rejectUnauthorized,
    ALPNProtocols: options.ALPNProtocols,
    highWaterMark: options.highWaterMark,
    onread: options.onread,
    signal: options.signal,
    noDelay: options.noDelay,
    keepAlive: options.keepAlive,
    keepAliveInitialDelay: options.keepAliveInitialDelay,
  });
  connectOptions.set(socket, options);
  if (callback) socket.once('secureConnect', callback);
  if (!options.socket) {
    if (options.timeout) (socket as unknown as { setTimeout(ms: number): void }).setTimeout(options.timeout);
    (socket as unknown as { connect(options: Options, listener: () => void): void }).connect(options, () => socket._start());
  }
  if (options.servername) socket.setServername(options.servername);
  if (options.socket) socket._start();
  socket.on('secure', onConnectSecure);
  (socket as unknown as EventEmitter).prependListener('end', onConnectEnd);
  return socket;
}

const createSecureContext = (options: Options = {}): SecureContext => new SecureContext(options);

const getCiphers = () => ['TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256'];

const DEFAULT_ECDH_CURVE = 'auto';
const DEFAULT_MAX_VERSION = 'TLSv1.3';
const DEFAULT_MIN_VERSION = 'TLSv1.2';

/** The roots compiled into Node; the engine has none compiled in, and its roots are the image's CA file. */
const rootCertificates: string[] = [];

// Node's certificate-store door, read by callers that build their own agents (VS Code's proxy agent, on every fetch
// it patches): the image's CA file is the system store, NODE_EXTRA_CA_CERTS's the extra, and both are the default.
const getCACertificates = (type: string = 'default'): string[] => {
  if (!['default', 'system', 'bundled', 'extra'].includes(type)) {
    throw Object.assign(new TypeError(`The argument 'type' must be one of: 'default', 'system', 'bundled', 'extra'. Received '${String(type)}'`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  if (type === 'bundled') return [...rootCertificates];
  const { system, extra } = defaultRoots();
  return certificatesIn(type === 'system' ? system : type === 'extra' ? extra : `${system}\n${extra}`);
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
