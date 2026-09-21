import type { DuplexLike } from './stream-module';
import type { EventEmitter } from './events-module';
import type { ProcessToken } from '../process-tokens';
import { __ownedHandleCount, __releaseOwnedHandles } from './binding/handles';
import { LibuvStreamWrap } from './binding/stream_wrap';
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
    onread?: {
        buffer: Uint8Array | (() => Uint8Array);
        callback: (bytes: number, buffer: Uint8Array) => boolean;
    };
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
export declare const netModule: NetModule;
export declare const Socket: new (options?: SocketOptions | number) => Socket;
export declare const Server: new (options?: unknown, connectionListener?: (socket: Socket) => void) => Server;
export declare const createServer: (options?: unknown, connectionListener?: (socket: Socket) => void) => Server;
export declare const createConnection: (...args: unknown[]) => Socket;
export declare const connect: (...args: unknown[]) => Socket;
export declare const isIP: (input: string) => number;
export declare const isIPv4: (input: string) => boolean;
export declare const isIPv6: (input: string) => boolean;
/** How many ref'd handles the named run holds, as Node's loop counts them. */
export { __ownedHandleCount, __releaseOwnedHandles };
/** The ports a run is listening on, and the release of them when it ends. */
export { __ownedServerPorts, __releaseOwnedServers } from './binding/handles';
/** Who is told when a guest starts or stops listening on a port. */
export { setPortWatchers, listenerOnPort } from './binding/tcp_wrap';
/**
 * A socket another run received over IPC is that run's: its handle moves, so
 * the run whose end closes it is the run that holds it. A socket with no
 * handle -- one already destroyed -- is nothing to move.
 */
export declare function __adoptSocket(socket: Socket, token: ProcessToken | null): void;
/** The same for a listening server a run received. */
export declare function __adoptServerHandle(server: Server, token: ProcessToken | null): void;
/** The bridge's end of a connection whose other end is a `net.Socket`. */
export interface BridgeEnd {
    /** Bytes the socket's owner wrote, as the engine hands them over. */
    onData(listener: (bytes: Uint8Array) => void): void;
    /** Bytes arriving from the far side, read by the socket as its own. */
    push(bytes: Uint8Array): void;
    /** The far side will write no more; the socket reads EOF. */
    end(): void;
    /** Close the pairing from this end. */
    destroy(): void;
    readonly destroyed: boolean;
}
/**
 * A connection with a `net.Socket` on one end and the page bridge on the
 * other.
 *
 * An `upgrade` listener is handed the connection's own `net.Socket` by Node,
 * and a program does everything a socket can with it: pause, resume, pipe,
 * `setEncoding`, `bufferSize`, and being sent to a child over IPC. The engine
 * used to hand it an object with `write` and `emit('data')` overridden, which
 * was no socket at all -- VS Code's `NodeSocket.drain` waits on
 * `bufferSize === 0` and a `drain` event, and waited forever. So the bridge
 * is a handle now, the far end of a real pairing, and what it holds is the
 * two calls a bridge needs and nothing of the socket's.
 *
 * The bridge's own handle is unref'd: a page's connection is not a guest's
 * work, and the socket the guest holds is what keeps the guest's run alive.
 */
export declare function __bridgeConnection(local: AddressInfo, remote: AddressInfo): {
    socket: Socket;
    bridge: BridgeEnd;
};
//# sourceMappingURL=net-module.d.ts.map