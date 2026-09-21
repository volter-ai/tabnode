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
import { guessHandleTypeOfFd } from './fds';

/** libuv's `uv_tty_t`, over the same stream the rest of the binding is. */
export class TTY extends LibuvStreamWrap {
  readonly fdNumber: number;

  /**
   * Node's `new TTY(fd, ctx)` writes an errno onto `ctx` when the fd is not
   * a terminal, so `tty.WriteStream` refuses to wrap a pipe. A run's stdout
   * that was not given a TTY is a pipe: `isTTY` is false and `hasColors`
   * answers false, and `util.inspect` does not colorize a number on it.
   */
  constructor(fd: number, ctx?: { code?: string } | boolean) {
    super();
    this.fdNumber = fd;
    this.fd = fd;
    if (ctx && typeof ctx === 'object' && !isTTY(fd)) {
      ctx.code = 'ENOTTY';
    }
  }

  /** A terminal the engine does not own has one size and no mode to set. */
  getWindowSize(out: number[]): number {
    out[0] = 80;
    out[1] = 24;
    return 0;
  }

  setRawMode(_raw: number): number {
    return 0;
  }
}

/** libuv's `uv_guess_handle(fd) === UV_TTY`, as the running program sees it. */
export function isTTY(fd: number): boolean {
  if (fd !== 0 && fd !== 1 && fd !== 2) return guessHandleTypeOfFd(fd) === 'TTY';
  const realm = (globalThis as unknown as {
    process?: { stdin?: { isTTY?: boolean }; stdout?: { isTTY?: boolean }; stderr?: { isTTY?: boolean } };
  }).process;
  const stream = fd === 0 ? realm?.stdin : fd === 1 ? realm?.stdout : realm?.stderr;
  return stream?.isTTY === true;
}

export default { TTY, isTTY };
