/**
 * `internalBinding('tcp_wrap')`: the engine's loopback, in libuv's shape.
 *
 * One engine is one host. A `bind` reserves a port, a `listen` starts
 * answering on it, and a `connect` to a loopback address on a port something
 * is listening on pairs two handles whose writes are each other's reads —
 * which is what the engine has always done for a `net` connect, moved here so
 * that Node's own `net.js` runs on it. A connect to anything that is not this
 * host is `ECONNREFUSED`, because there is nothing else to reach: a page's
 * request to the outside goes through `fetch`, not through a socket.
 *
 * A wildcard bind holds the port for both families, as a dual-stack `::` bind
 * does on Linux, so `connect('127.0.0.1')` reaches a server that bound `::`.
 */
import { LibuvStreamWrap } from './stream_wrap';
/** libuv's `uv_tcp_t` flavours, and the two flags `getFlags` builds. */
export declare const constants: {
    SOCKET: number;
    SERVER: number;
    UV_TCP_IPV6ONLY: number;
    UV_TCP_REUSEPORT: number;
};
/** What `getsockname`/`getpeername` fill in. */
export interface SockName {
    address: string;
    family: string;
    port: number;
}
/** Node's `TCPConnectWrap`: the request a connect fills and is answered through. */
export declare class TCPConnectWrap {
    oncomplete: ((status: number, handle: unknown, req: unknown, readable: boolean, writable: boolean) => void) | null;
    address: string;
    port: number;
    localAddress: string | undefined;
    localPort: number | undefined;
    addressType: number | undefined;
}
/**
 * What the page bridge is told when a guest starts or stops listening. The
 * bridge used to learn this from the engine's own `http.Server`; `http` is
 * Node's own file now and knows nothing of a page, so the news comes from
 * where a port is actually taken.
 */
type ListenWatcher = (port: number, address: string) => void;
export declare function setPortWatchers(onListen: ListenWatcher | null, onClose: ((port: number) => void) | null): void;
/** The listening handle a connect to this port reaches, if any. */
export declare function listenerOnPort(port: number): TCP | undefined;
export declare class TCP extends LibuvStreamWrap {
    /** `constants.SOCKET` or `constants.SERVER`. */
    readonly type: number;
    listening: boolean;
    /** Set by `net.js` on a server handle; how an accepted pairing is announced. */
    onconnection: ((status: number, clientHandle: TCP) => void) | null;
    private local;
    private remote;
    private ephemeral;
    constructor(type?: number);
    bind(address: string, port: number, _flags?: number): number;
    bind6(address: string, port: number, _flags?: number): number;
    private bindTo;
    listen(_backlog: number): number;
    connect(req: TCPConnectWrap, address: string, port: number): number;
    connect6(req: TCPConnectWrap, address: string, port: number): number;
    private connectTo;
    /**
     * Name both ends of a pairing the engine made without a connect. The page
     * bridge's end of an upgraded connection is one: there was no `connect`, and
     * the socket an `upgrade` listener is handed still has to answer
     * `remoteAddress` and `localPort` as a connection's socket does.
     */
    adoptNames(local: SockName, remote: SockName): void;
    /** libuv's `dup()`: the same connection, under both its names. */
    duplicate(): TCP;
    getsockname(out: Partial<SockName>): number;
    getpeername(out: Partial<SockName>): number;
    /** Nothing is buffered between two handles in one realm, so there is nothing to delay. */
    setNoDelay(_enable: boolean): number;
    /** There is no idle connection to probe: a pairing is alive while both ends are. */
    setKeepAlive(_enable: boolean, _delay: number): number;
    setSimultaneousAccepts(_enable: boolean): number;
    /** An engine handle carries no descriptor a program can hand it. */
    open(_fd: number): number;
    /** libuv's `uv_tcp_close_reset`: the peer reads ECONNRESET rather than EOF. */
    reset(callback?: () => void): number;
    protected onCloseHandle(): void;
}
declare const _default: {
    TCP: typeof TCP;
    TCPConnectWrap: typeof TCPConnectWrap;
    constants: {
        SOCKET: number;
        SERVER: number;
        UV_TCP_IPV6ONLY: number;
        UV_TCP_REUSEPORT: number;
    };
};
export default _default;
//# sourceMappingURL=tcp_wrap.d.ts.map