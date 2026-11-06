/**
 * `internalBinding('tty_wrap')`: the engine's standard streams, where a host
 * reports one of them as a terminal.
 *
 * `internal/child_process.js` reads two things from it: whether a descriptor
 * is a terminal, which decides whether an `inherit` entry is a TTY, and the
 * `TTY` class, which `getHandleWrapType` asks an `instanceof` of. The engine
 * writes to a page or to a host's pipe, so a descriptor is a terminal only
 * when the running program's own `process.stdout.isTTY` says so -- which is
 * what a held run gets, and what a program reads to decide on colour. A
 * run's terminal is its host's (`RunStreams.terminal`): its size the host's
 * `TIOCGWINSZ`, and fd 0's mode the host's termios (ADR-0010 §3).
 */
import { queueBindingTask } from '../../guest-loop';
import { LibuvStreamWrap, type WriteWrap } from './stream_wrap';
import { guessHandleTypeOfFd, handleForFd, registerFd, releaseFd } from './fds';
import { UV_EBADF, UV_EIO, UV_ENOTSUP } from './uv';
import { currentOwner, forgetNodeHandle } from './handles';
import { __runFor } from '../../process-tokens';

export interface TerminalState {
  columns: number;
  rows: number;
  onResize(listener: (columns: number, rows: number) => void): () => void;
  resize(columns: number, rows: number): void;
}

/**
 * What a host gives a run whose fd 0, 1 or 2 is a terminal (`RunStreams.terminal`), kept on the run's process: its
 * size, which the host keeps current, and fd 0's mode where the host can set it.
 */
export interface RunTerminal {
  readonly columns: number;
  readonly rows: number;
  /**
   * fd 0's termios as `uv_tty_set_mode` sets it: `'raw'` libuv's raw mode, `'io'` `cfmakeraw`, false the termios
   * before the first change. Throws an error whose `errno` is the call's negative errno where it cannot.
   */
  setRawMode?(mode: false | 'raw' | 'io'): void;
}

/** The key a run's process keeps its `RunTerminal` under. */
export const kRunTerminal = Symbol.for('tabnode.run.terminal');

/** The asking run's terminal, as its host gave it; none where it was given none. */
function runTerminalOf(): RunTerminal | undefined {
  const token = currentOwner();
  const own = token === null ? undefined : __runFor(token)?.process as unknown as Record<symbol, unknown> | undefined;
  const proc = own ?? (globalThis as unknown as { process?: Record<symbol, unknown> }).process;
  return proc?.[kRunTerminal] as RunTerminal | undefined;
}

/**
 * The binding's mode operation for a run's fd 0 (ADR-0010 §3): `uv_tty_set_mode` through the run's terminal,
 * `UV_TTY_MODE_NORMAL` false, `UV_TTY_MODE_IO` io, `UV_TTY_MODE_RAW_VT` (and libuv's `UV_TTY_MODE_RAW`) raw; 0, or the
 * call's negative errno.
 */
function setRunTerminalMode(terminal: RunTerminal, mode: number): number {
  try {
    terminal.setRawMode!(mode === UV_TTY_MODE_NORMAL ? false : mode === UV_TTY_MODE_IO ? 'io' : 'raw');
    return 0;
  } catch (cause) {
    const errno = (cause as { errno?: unknown } | null)?.errno;
    if (typeof errno !== 'number' || errno >= 0) throw cause;
    return errno;
  }
}

/**
 * The handle Node's own `tty.ReadStream.prototype.setRawMode` drives for a run's `process.stdin` whose terminal's mode
 * the host sets: that function's `this._handle.setRawMode(UV_TTY_MODE_*)`, answered by the binding's mode operation.
 */
export function runTerminalModeHandle(terminal: RunTerminal): { setRawMode(mode: number): number } {
  return { setRawMode: mode => setRunTerminalMode(terminal, mode) };
}

/** One terminal endpoint, shared by independently owned descriptors. */
class TerminalEndpoint {
  readonly descriptors = new Set<TTY>();
  readonly readers = new Set<TTY>();
  readonly input: Uint8Array[] = [];
  peer?: TerminalEndpoint;
  eof = false;
  scheduled = false;
  constructor(readonly terminal: TerminalState, readonly slave: boolean) {}
  pump(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueBindingTask(() => {
      this.scheduled = false;
      while (this.input.length) {
        const reader = [...this.readers].find(handle => handle.reading && !handle.closed && !handle.descriptor.closed);
        if (!reader) return;
        reader.deliver(this.input.shift()!);
      }
      if (this.eof) for (const reader of this.readers) reader.receiveEof();
    });
  }
  release(descriptor: TTY): void {
    this.descriptors.delete(descriptor);
    if (this.descriptors.size || !this.peer) return;
    this.peer.eof = true;
    this.peer.pump();
    this.input.length = 0;
  }
}


/** libuv's `uv_tty_t`, over the same stream the rest of the binding is. */
export class TTY extends LibuvStreamWrap {
  get fdNumber(): number { return this.fd; }
  readonly descriptor: TTY;
  private endpoint?: TerminalEndpoint;
  get terminal(): TerminalState | undefined { return this.endpoint?.terminal; }
  get slave(): boolean { return this.endpoint?.slave === true; }

  /**
   * Node's `new TTY(fd, ctx)` writes an errno onto `ctx` when the fd is not
   * a terminal, so `tty.WriteStream` refuses to wrap a pipe. A run's stdout
   * that was not given a TTY is a pipe: `isTTY` is false and `hasColors`
   * answers false, and `util.inspect` does not colorize a number on it.
   */
  constructor(fd: number, ctx?: { code?: string } | boolean) {
    super();
    this.fd = fd;
    const held = handleForFd(fd);
    this.descriptor = held instanceof TTY ? held.descriptor : this;
    this.endpoint = held instanceof TTY ? held.endpoint : undefined;
    this.endpoint?.readers.add(this);
    if (ctx && typeof ctx === 'object' && !isTTY(fd)) {
      ctx.code = 'ENOTTY';
      forgetNodeHandle(this);
    }
  }

  /** uv_tty_get_winsize: an engine pty's size, a run's terminal's (its host's TIOCGWINSZ) for fd 0 to 2, else 80 by 24. */
  getWindowSize(out: number[]): number {
    const terminal = this.terminal ?? (this.fd >= 0 && this.fd <= 2 ? runTerminalOf() : undefined);
    out[0] = terminal?.columns ?? 80;
    out[1] = terminal?.rows ?? 24;
    return 0;
  }

  /**
   * uv_tty_set_mode: fd 0's mode through the run's terminal (ADR-0010 §3). ADR-0023: an engine pty endpoint has no
   * termios, and a terminal whose host sets no mode claims no change.
   */
  setRawMode(mode: number): number {
    if (this.endpoint) return UV_ENOTSUP;
    const terminal = this.fd === 0 ? runTerminalOf() : undefined;
    if (!terminal?.setRawMode) return 0;
    return setRunTerminalMode(terminal, mode);
  }

  static allocate(endpoint: TerminalEndpoint): TTY {
    const handle = new TTY(-1);
    handle.endpoint = endpoint;
    handle.fd = registerFd('TTY', handle);
    endpoint.descriptors.add(handle);
    endpoint.readers.add(handle);
    return handle;
  }

  /** Inheritance duplicates the fd; neither process owns the other's ref. */
  duplicate(): TTY {
    if (!this.endpoint || this.closed || this.descriptor.closed) throw Object.assign(new Error('Bad terminal descriptor'), { code: 'EBADF' });
    return TTY.allocate(this.endpoint);
  }

  readStart(): number {
    if (this.descriptor.closed) return UV_EBADF;
    const result = super.readStart();
    this.endpoint?.pump();
    return result;
  }

  /** Delivered into Node's existing stream binding, preserving backpressure. */
  deliver(bytes: Uint8Array): void { this.receive(bytes); this.flushInbound(); }

  protected dispatchWrite(req: WriteWrap, bytes: Uint8Array): number {
    if (!this.endpoint) return super.dispatchWrite(req, bytes);
    if (this.closed || this.descriptor.closed) return UV_EBADF;
    if (!this.endpoint.peer?.descriptors.size) return UV_EIO;
    // Let the base binding set Node's synchronous-write accounting, while
    // the shared endpoint, rather than a replaceable handle, owns the bytes.
    const status = super.dispatchWrite(req, bytes);
    if (bytes.byteLength) this.endpoint.peer.input.push(bytes.slice());
    this.endpoint.peer.pump();
    return status;
  }

  protected onCloseHandle(): void {
    this.endpoint?.readers.delete(this);
    if (this.descriptor !== this) { this.descriptor.close(); return; }
    releaseFd(this.fd);
    this.endpoint?.release(this);
    for (const reader of this.endpoint?.readers ?? []) {
      if (reader.descriptor === this) reader.close();
    }
  }
}

/** Host OS adapter door. The process host retains terminal behavior. */
export function openPty(columns: number, rows: number): { master: number; slave: number; pty: string } {
  validSize(columns, rows);
  const listeners = new Set<(columns: number, rows: number) => void>();
  const terminal: TerminalState = {
    columns, rows,
    onResize(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    resize(columns, rows) {
      validSize(columns, rows);
      this.columns = columns; this.rows = rows;
      for (const listener of listeners) listener(columns, rows);
    },
  };
  const master = new TerminalEndpoint(terminal, false);
  const slave = new TerminalEndpoint(terminal, true);
  master.peer = slave; slave.peer = master;
  const masterFd = TTY.allocate(master).fd;
  const slaveFd = TTY.allocate(slave).fd;
  return { master: masterFd, slave: slaveFd, pty: `/dev/pts/${slaveFd}` };
}

function validSize(columns: number, rows: number): void {
  if (![columns, rows].every(value => Number.isInteger(value) && value > 0)) throw Object.assign(new Error('Invalid terminal size'), { code: 'EINVAL' });
}

export function resizePty(fd: number, columns: number, rows: number): void {
  const terminal = handleForFd(fd);
  if (!(terminal instanceof TTY) || terminal.closed) throw Object.assign(new Error('Bad terminal descriptor'), { code: 'EBADF' });
  terminal.terminal?.resize(columns, rows);
}


/** libuv's `uv_guess_handle(fd) === UV_TTY`, as the running program sees it. */
export function isTTY(fd: number): boolean {
  if (fd !== 0 && fd !== 1 && fd !== 2) return guessHandleTypeOfFd(fd) === 'TTY';
  // The asking run's own streams, which carry its per-fd terminals: in a
  // realm several guests share, the global `process` is whichever ran last.
  type Streams = { stdin?: { isTTY?: boolean }; stdout?: { isTTY?: boolean }; stderr?: { isTTY?: boolean } };
  const token = currentOwner();
  const own = token === null ? undefined : __runFor(token)?.process as unknown as Streams | undefined;
  const proc = own ?? (globalThis as unknown as { process?: Streams }).process;
  const stream = fd === 0 ? proc?.stdin : fd === 1 ? proc?.stdout : proc?.stderr;
  return stream?.isTTY === true;
}

/**
 * What the asking run's fd 0, 1 or 2 is, as the run said (`stdioKind`, kept on
 * its process), else a terminal or a pipe by its stream's `isTTY`.
 */
export function stdioKindOf(fd: 0 | 1 | 2): 'tty' | 'pipe' | 'file' | 'char' {
  const token = currentOwner();
  const own = token === null ? undefined : __runFor(token)?.process as unknown as Record<symbol, unknown> | undefined;
  const proc = own ?? (globalThis as unknown as { process?: Record<symbol, unknown> }).process;
  const kinds = proc?.[Symbol.for('tabnode.run.stdioKinds')] as readonly ('tty' | 'pipe' | 'file' | 'char')[] | undefined;
  return kinds?.[fd] ?? (isTTY(fd) ? 'tty' : 'pipe');
}

// Node24.21/libuv uv_tty_mode_t; endpoint mode refusals remain ADR-0023.
export const UV_TTY_MODE_NORMAL = 0;
export const UV_TTY_MODE_IO = 2;
export const UV_TTY_MODE_RAW_VT = 3;
export default { TTY, isTTY, openPty, resizePty, UV_TTY_MODE_NORMAL, UV_TTY_MODE_IO, UV_TTY_MODE_RAW_VT };
