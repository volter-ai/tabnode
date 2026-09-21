import { type OwnedHandle } from './handles';
/** The four slots libuv's `StreamBase` reports a read or a write through. */
export declare const kReadBytesOrError = 0;
export declare const kArrayBufferOffset = 1;
export declare const kBytesWritten = 2;
export declare const kLastWriteWasAsync = 3;
export declare const streamBaseState: Int32Array<ArrayBuffer>;
/** Node's `WriteWrap`: the request `writeGeneric` fills and hands to a write. */
export declare class WriteWrap {
    handle: LibuvStreamWrap | null;
    oncomplete: ((status: number) => void) | null;
    async: boolean;
    bytes: number;
    buffer: unknown;
    callback: unknown;
    error: unknown;
    _chunks: unknown;
}
/** Node's `ShutdownWrap`: the request a `_final` hands to `shutdown`. */
export declare class ShutdownWrap {
    handle: LibuvStreamWrap | null;
    oncomplete: ((status: number) => void) | null;
    callback: (() => void) | null;
}
/**
 * The bytes one direction of a pairing is carrying, oldest first, and the
 * handle a write of them carried. A descriptor crosses an IPC channel beside
 * the bytes of the message it belongs to and is read out of the receiver just
 * before those bytes reach it, which is the order `setupChannel` in Node's
 * `internal/child_process.js` reads them in.
 */
interface Inbound {
    bytes: Uint8Array;
    handle?: unknown;
}
/**
 * The base every `TCP` and `Pipe` extends, as `LibuvStreamWrap` is the base of
 * libuv's `uv_stream_t` wrappers.
 *
 * A pairing is two of these with `peer` pointing at each other. A write copies
 * its bytes and hands them to the peer on a microtask, because libuv never
 * delivers a read inside the write that caused it; the peer delivers them to
 * `onread` while it is reading and holds them while it is not, which is what
 * `readStart` and `readStop` mean.
 */
export declare class LibuvStreamWrap implements OwnedHandle {
    /** Set by `net.js` to `onStreamRead`; the only way bytes reach a stream. */
    onread: ((arrayBuffer: ArrayBuffer | null) => unknown) | null;
    /** `net.js` owns this flag; `readStart`/`readStop` follow it. */
    reading: boolean;
    bytesRead: number;
    bytesWritten: number;
    /** Nothing is ever queued: a write is taken whole by the peer. */
    writeQueueSize: number;
    /** The engine has no descriptors for a paired handle, as libuv reports -1 for one it has no fd for. */
    fd: number;
    /** The other end of the pairing, once there is one. */
    peer: LibuvStreamWrap | null;
    /** True once `close()` has been called; a closed handle carries nothing. */
    closed: boolean;
    /**
     * The handle the read now being delivered carried, which `setupChannel`
     * takes off the channel at the top of its `onread`. libuv keeps the same
     * thing in a pipe's pending-handle queue.
     */
    pendingHandle: unknown;
    protected inbound: Inbound[];
    protected inboundEof: boolean;
    protected inboundError: number | null;
    protected eofDelivered: boolean;
    protected userBuffer: Uint8Array | null;
    protected readonly asyncId: number;
    constructor();
    getAsyncId(): number;
    ref(): void;
    unref(): void;
    hasRef(): boolean;
    readStart(): number;
    readStop(): number;
    /** Node's `onread` option: reads land in the program's own buffer. */
    useUserBuffer(buffer: Uint8Array): void;
    /**
     * libuv's `uv_shutdown`: this end says it will write no more, and the peer
     * reads EOF. The request completes on its own turn, as libuv's does.
     */
    shutdown(req: ShutdownWrap): number;
    writeBuffer(req: WriteWrap, buffer: Uint8Array): number;
    writev(req: WriteWrap, chunks: unknown[], allBuffers: boolean): number;
    writeUtf8String(req: WriteWrap, text: string, handle?: unknown): number;
    writeAsciiString(req: WriteWrap, text: string): number;
    writeLatin1String(req: WriteWrap, text: string): number;
    writeUcs2String(req: WriteWrap, text: string): number;
    /**
     * libuv's `uv_close`. The peer reads EOF, as it does when the other end of a
     * socket goes; the callback runs on its own turn, because `net.js` emits
     * `close` from it and Node emits that after the turn that destroyed.
     */
    close(callback?: () => void): void;
    /** What a `TCP` or a `Pipe` gives up beyond the stream: a port, a path. */
    protected onCloseHandle(): void;
    /**
     * libuv's `dup()`: a second handle on the same connection.
     *
     * A descriptor sent over IPC arrives in the receiver as a NEW descriptor
     * referring to the same socket, which is what `SCM_RIGHTS` gives it, and
     * Node's own `child_process.js` counts on exactly that: on the receiver's
     * `NODE_HANDLE_ACK` the sender CLOSES the handle it sent. With one handle
     * for both, that close ended the connection the child had just been given
     * and its first write was `EBADF`.
     *
     * The duplicate takes over this end of the pairing and this end is left
     * peerless, so closing it announces nothing -- the sender has already given
     * the socket up (`handleConversion`'s `send` sets `socket._handle = null`
     * and silences its reads before the write).
     */
    duplicate(): LibuvStreamWrap;
    /** Two handles become each other's peer; what one writes the other reads. */
    static pair(a: LibuvStreamWrap, b: LibuvStreamWrap): void;
    /**
     * Take over another handle's end of a pairing, with everything that arrived
     * on it while nobody was holding it. This is what opening a descriptor is
     * here: a forked child's channel is opened by the child after its parent has
     * already written to it -- `fork(…)` and `send(…)` are one synchronous turn
     * in every program that does it -- and the bytes waiting at that descriptor
     * are the child's. A pairing whose bytes stayed behind left the child
     * waiting for a message its parent had already sent.
     */
    takeOverFrom(other: LibuvStreamWrap): void;
    /**
     * A write: the bytes are copied (the caller may reuse its buffer) and put in
     * the peer's queue at once, where anything the writer does afterwards lands
     * behind them. Delivery is still the peer's own turn, because libuv never
     * delivers a read inside the write that caused it. It completes
     * synchronously — `kBytesWritten` set, `kLastWriteWasAsync` 0 — because the
     * engine's writes are taken whole and there is no queue for a `drain` to
     * empty.
     *
     * Handing the bytes over on a microtask instead put them BEHIND an end
     * announced from the same turn: `stdin.write('hello'); stdin.end()` is one
     * synchronous block in every program that does it, the peer read EOF first
     * and the bytes were dropped after it, and `spawn('cat')` fed that way
     * produced nothing.
     */
    protected dispatchWrite(req: WriteWrap, buffer: Uint8Array, handle?: unknown): number;
    /**
     * The peer will write no more; this end reads EOF once it has read the rest.
     * Announced on a microtask of its own, so it lands behind the writes that
     * were handed over before it: `stdin.write('hello'); stdin.end()` is one
     * turn in every program, and an EOF announced from inside `end` reached the
     * reader first and the bytes never reached it at all.
     */
    protected sendEof(): void;
    /**
     * libuv's close-with-reset: the peer's next read is `ECONNRESET`, not EOF,
     * which is how `socket.resetAndDestroy()` differs from `socket.destroy()`.
     */
    protected sendReset(): void;
    /** An error arriving on the read side, delivered as libuv delivers one. */
    receiveError(code: number): void;
    /** Bytes arriving from the peer, and the handle their write carried. */
    receive(bytes: Uint8Array, handle?: unknown): void;
    /** The peer is done writing. */
    receiveEof(): void;
    /**
     * What arrived is recorded the moment it arrives and delivered on a turn of
     * its own, once, however many arrivals that turn holds. This is the order
     * libuv's loop reads in: everything a writer did in one turn is read in the
     * order it did it, and never from inside the call that did it.
     */
    private flushScheduled;
    protected scheduleFlush(): void;
    /**
     * Hand what has arrived to `onStreamRead`, in libuv's shape: the byte count
     * in `streamBaseState[kReadBytesOrError]`, the offset beside it, the
     * `ArrayBuffer` as the argument. A reader that pushes back calls `readStop`
     * from inside `onread`, so the loop re-reads `reading` every time.
     */
    protected flushInbound(): void;
}
declare const _default: {
    LibuvStreamWrap: typeof LibuvStreamWrap;
    WriteWrap: typeof WriteWrap;
    ShutdownWrap: typeof ShutdownWrap;
    streamBaseState: Int32Array<ArrayBuffer>;
    kReadBytesOrError: number;
    kArrayBufferOffset: number;
    kBytesWritten: number;
    kLastWriteWasAsync: number;
};
export default _default;
//# sourceMappingURL=stream_wrap.d.ts.map