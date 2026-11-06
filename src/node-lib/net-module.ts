/**
 * `net`, as Node's own `lib/net.js`.
 *
 * What died: the engine's `net` was hand-written, and between fork .36 and
 * .44 it took correction after correction -- unix-socket paths, sockets
 * holding a run alive, `bufferSize`, an `upgrade` listener's socket -- each
 * one gap of Node's behaviour that an application met in the tab, and the
 * application at the end of that run still did not work. A hand-written
 * module carries only the slice of Node that one program exercised. Node's
 * own `test-net-*`: 63 of 151 passed.
 *
 * What this is: Node's `lib/net.js` v22.18.0, vendored unmodified in
 * `./net.js`, loaded by `./load.ts` on the binding in `./binding/` -- the
 * libuv surface and nothing above it. `Socket`, `Server`, `connect`,
 * `BlockList` and the rest are Node's own code running on the process's
 * kernel sockets (ADR-0009).
 *
 * The rule for this file: it binds, it does not implement. A `net` bug is
 * fixed in the binding or by moving the vendored file to a newer Node, never
 * by editing either.
 *
 * Beside the module are the three names the engine's own parts read of it:
 * how many handles a run holds, how to let them go, and how to move one to
 * another run when it is sent over IPC.
 */
import { loadNodeLib } from './load';
import type { DuplexLike } from './stream-module';
import type { EventEmitter } from './events-module';
import type { ProcessToken } from '../process-tokens';
import { __adoptHandle, __ownedHandleCount, __ownedHandleKinds, __releaseOwnedHandles } from './binding/handles';
import type { LibuvStreamWrap } from './binding/stream_wrap';

export type { ProcessToken };

/** Node's `server.address()` / `socket.address()` for a TCP endpoint. */
export interface AddressInfo {
  address: string;
  family: string;
  port: number;
}

/** What a program hands `new net.Socket(...)`. */
export interface SocketOptions {
  fd?: number;
  handle?: unknown;
  allowHalfOpen?: boolean;
  readable?: boolean;
  writable?: boolean;
  signal?: AbortSignal;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  onread?: { buffer: Uint8Array | (() => Uint8Array); callback: (bytes: number, buffer: Uint8Array) => boolean };
}

/** What a program hands `net.connect(...)`. */
export interface ConnectOptions {
  port?: number;
  host?: string;
  path?: string;
  localAddress?: string;
  localPort?: number;
  family?: number;
  timeout?: number;
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  signal?: AbortSignal;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
}

/** What a program hands `server.listen(...)`. */
export interface ListenOptions {
  port?: number;
  host?: string;
  path?: string;
  backlog?: number;
  exclusive?: boolean;
  readableAll?: boolean;
  writableAll?: boolean;
  ipv6Only?: boolean;
  reusePort?: boolean;
  signal?: AbortSignal;
}

/** Node's `net.Socket`, as the engine's own parts read it. */
export interface Socket extends DuplexLike {
  connecting: boolean;
  pending: boolean;
  readyState: string;
  bufferSize: number | undefined;
  bytesRead: number;
  bytesWritten: number | undefined;
  localAddress: string | undefined;
  localPort: number | undefined;
  localFamily: string | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
  remoteFamily: string | undefined;
  timeout?: number;
  server: Server | null;
  _server: Server | null;
  /** The libuv handle this socket is a stream over; null once it is destroyed. */
  _handle: LibuvStreamWrap | null;
  address(): AddressInfo | Record<string, never>;
  connect(options: ConnectOptions | number | string, host?: string | (() => void), connectListener?: () => void): this;
  setTimeout(timeout: number, callback?: () => void): this;
  setNoDelay(enable?: boolean): this;
  setKeepAlive(enable?: boolean, initialDelay?: number): this;
  resetAndDestroy(): this;
  destroySoon(): void;
  ref(): this;
  unref(): this;
  cork(): void;
  uncork(): void;
}

/** Node's `net.Server`. */
export interface Server extends EventEmitter {
  listening: boolean;
  maxConnections?: number;
  allowHalfOpen: boolean;
  pauseOnConnect: boolean;
  /** The libuv handle the server listens on; null once it is closed. */
  _handle: LibuvStreamWrap | null;
  address(): AddressInfo | string | null;
  listen(...args: unknown[]): this;
  close(callback?: (error?: Error) => void): this;
  getConnections(callback: (error: Error | null, count: number) => void): this;
  ref(): this;
  unref(): this;
}

/** The whole of Node's `net` module object. */
export interface NetModule {
  Socket: new (options?: SocketOptions | number) => Socket;
  Server: new (options?: unknown, connectionListener?: (socket: Socket) => void) => Server;
  Stream: new (options?: SocketOptions | number) => Socket;
  createServer(options?: unknown, connectionListener?: (socket: Socket) => void): Server;
  createConnection(...args: unknown[]): Socket;
  connect(...args: unknown[]): Socket;
  isIP(input: string): number;
  isIPv4(input: string): boolean;
  isIPv6(input: string): boolean;
  BlockList: new () => unknown;
  SocketAddress: new (options?: unknown) => unknown;
  getDefaultAutoSelectFamily(): boolean;
  setDefaultAutoSelectFamily(value: boolean): void;
  getDefaultAutoSelectFamilyAttemptTimeout(): number;
  setDefaultAutoSelectFamilyAttemptTimeout(value: number): void;
  _normalizeArgs(args: unknown[]): unknown[];
  _createServerHandle(...args: unknown[]): unknown;
  _setSimultaneousAccepts(handle?: unknown): void;
}

/** The loaded module: Node's own `net.js`, evaluated once. */
export const netModule = loadNodeLib('net') as unknown as NetModule;

export const Socket = netModule.Socket;
export const Server = netModule.Server;
export const createServer = netModule.createServer;
export const createConnection = netModule.createConnection;
export const connect = netModule.connect;
export const isIP = netModule.isIP;
export const isIPv4 = netModule.isIPv4;
export const isIPv6 = netModule.isIPv6;

/** How many ref'd handles the named run holds, as Node's loop counts them. */
export { __ownedHandleCount, __ownedHandleKinds, __releaseOwnedHandles };

/** The ports a run is listening on, and the release of them when it ends. */
export { __ownedServerPorts, __releaseOwnedServers, __endOwnedProcess } from './binding/handles';

/**
 * A socket another run received over IPC is that run's: its handle moves, so
 * the run whose end closes it is the run that holds it. A socket with no
 * handle -- one already destroyed -- is nothing to move.
 */
export function __adoptSocket(socket: Socket, token: ProcessToken | null): void {
  __adoptHandle(socket._handle, token);
}

/** The same for a listening server a run received. */
export function __adoptServerHandle(server: Server, token: ProcessToken | null): void {
  __adoptHandle(server._handle, token);
}
