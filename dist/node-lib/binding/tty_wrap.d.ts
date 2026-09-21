/**
 * `internalBinding('tty_wrap')`: the engine's standard streams, where a host
 * reports one of them as a terminal.
 *
 * `internal/child_process.js` reads two things from it: whether a descriptor
 * is a terminal, which decides whether an `inherit` entry is a TTY, and the
 * `TTY` class, which `getHandleWrapType` asks an `instanceof` of. The engine
 * writes to a page or to a host's pipe, so a descriptor is a terminal only
 * when the running program's own `process.stdout.isTTY` says so -- which is
 * what a held run gets, and what a program reads to decide on colour.
 */
import { LibuvStreamWrap } from './stream_wrap';
/** libuv's `uv_tty_t`, over the same stream the rest of the binding is. */
export declare class TTY extends LibuvStreamWrap {
    readonly fdNumber: number;
    /**
     * Node's `new TTY(fd, ctx)` writes an errno onto `ctx` when the fd is not
     * a terminal, so `tty.WriteStream` refuses to wrap a pipe. A run's stdout
     * that was not given a TTY is a pipe: `isTTY` is false and `hasColors`
     * answers false, and `util.inspect` does not colorize a number on it.
     */
    constructor(fd: number, ctx?: {
        code?: string;
    } | boolean);
    /** A terminal the engine does not own has one size and no mode to set. */
    getWindowSize(out: number[]): number;
    setRawMode(_raw: number): number;
}
/** libuv's `uv_guess_handle(fd) === UV_TTY`, as the running program sees it. */
export declare function isTTY(fd: number): boolean;
declare const _default: {
    TTY: typeof TTY;
    isTTY: typeof isTTY;
};
export default _default;
//# sourceMappingURL=tty_wrap.d.ts.map