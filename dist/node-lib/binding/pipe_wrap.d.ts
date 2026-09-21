/**
 * `internalBinding('pipe_wrap')`: the same loopback, named by a path.
 *
 * VS Code's extension host is started by its parent and connects back to it
 * over a unix-domain socket path: the parent runs `server.listen(path)` and
 * the child `net.connect(path)`. A path is a name in one registry here, as a
 * port is a number in the other; nothing on the path is `ENOENT`, which is
 * what Node answers, and a path a live server already holds is `EADDRINUSE`.
 *
 * The IPC flavour is the same stream with one extra: a write may carry a
 * handle, which is set on the peer before the peer's read, and that is how
 * `setupChannel` in `internal/child_process.js` receives a sent socket.
 */
import { LibuvStreamWrap, type WriteWrap } from './stream_wrap';
/** libuv's `uv_pipe_t` flavours, and the two chmod bits `listen` reads. */
export declare const constants: {
    SOCKET: number;
    SERVER: number;
    IPC: number;
    UV_READABLE: number;
    UV_WRITABLE: number;
};
/** Node's `PipeConnectWrap`: the request a pipe connect is answered through. */
export declare class PipeConnectWrap {
    oncomplete: ((status: number, handle: unknown, req: unknown, readable: boolean, writable: boolean) => void) | null;
    address: string;
}
/** The listening pipe a connect to this path reaches, if any. */
export declare function listenerOnPath(path: string): Pipe | undefined;
export declare class Pipe extends LibuvStreamWrap {
    readonly type: number;
    listening: boolean;
    onconnection: ((status: number, clientHandle: Pipe) => void) | null;
    private path;
    private ownFd;
    constructor(type?: number);
    bind(path: string): number;
    listen(_backlog: number): number;
    connect(req: PipeConnectWrap, path: string): number;
    /**
     * The descriptor of a handle the engine itself opened — a forked child's IPC
     * channel among them. There is nothing else to open: the engine has no
     * descriptors of its own beyond the ones it hands out. Opening one takes
     * over that end of its pairing, with whatever arrived on it before anyone
     * opened it, because a child's channel is written to before the child runs.
     */
    open(fd: number): number;
    /** The descriptor this handle can be reached at, for a child's stdio table. */
    toFd(): number;
    /** libuv's `dup()`: the same pairing, under the same flavour. */
    duplicate(): Pipe;
    /** There is no filesystem entry behind an engine pipe to change the mode of. */
    fchmod(_mode: number): number;
    /** Windows asks for more pipe instances; the engine has one realm and one. */
    setPendingInstances(_count: number): number;
    /**
     * An IPC write may carry a handle. The peer is given it before the bytes, so
     * `setupChannel`'s reader sees `channel.pendingHandle` when the message it
     * belongs to arrives, which is the order Node delivers them in.
     *
     * The handle becomes the receiving run's. Node's `send(message, socket)`
     * duplicates the sender's descriptor into the other process, and from then
     * on the socket is an active handle of that process's loop; here parent and
     * child are one realm and there is nothing to duplicate, so the move is the
     * run ownership the engine counts. Without it, openvscode-server's extension
     * host -- a program whose only handle is the socket its parent sent it --
     * read as idle and was settled with exit 0.
     */
    writeUtf8String(req: WriteWrap, text: string, handle?: unknown): number;
    protected onCloseHandle(): void;
}
declare const _default: {
    Pipe: typeof Pipe;
    PipeConnectWrap: typeof PipeConnectWrap;
    constants: {
        SOCKET: number;
        SERVER: number;
        IPC: number;
        UV_READABLE: number;
        UV_WRITABLE: number;
    };
};
export default _default;
//# sourceMappingURL=pipe_wrap.d.ts.map