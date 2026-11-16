/**
 * `internalBinding('tty_wrap')`: Node's TTYWrap (Node v24.21.0's `src/tty_wrap.cc`).
 *
 * Where the realm's process is `node` on libuv's loop (ADR-0018 §3, item 3), a TTY is libuv's `uv_tty_t` on its
 * descriptor, its stream `kernel_stream.ts`'s: the reopening of a pty's slave so its non-blocking mode is its own,
 * the window size (TIOCGWINSZ), the modes (`uv_tty_set_mode`, restored at exit by the program's ResetStdio) and
 * whether a descriptor is a terminal (`uv_guess_handle`) are libuv's.
 *
 * A realm with no libuv writes to a page or to a host's pipe, so a descriptor is a terminal only when the running
 * program's own `process.stdout.isTTY` says so -- which is what a held run gets, and what a program reads to decide
 * on colour. A run's terminal is its host's (`RunStreams.terminal`): its size the host's `TIOCGWINSZ`, and fd 0's mode
 * the host's termios (ADR-0010 §3); an engine pty is a pairing of two endpoints.
 */
import { queueBindingTask } from '../../guest-loop';
import { type WriteWrap } from './stream_wrap';
import { KernelStreamWrap, kKernelBacked, realmHasLibuv } from './kernel_stream';
import { guessHandleTypeOfFd, handleForFd, registerFd, releaseFd } from './fds';
import { uvConstant } from './uv';
import { wrapConstants } from '../../shims/constants';
import { currentOwner, forgetNodeHandle } from './handles';
import { __runFor } from '../../process-tokens';
import { collectUVExceptionInfo, nodeProgram, withRoom } from './program';

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
    const modes = ttyModes();
    terminal.setRawMode!(mode === modes.UV_TTY_MODE_NORMAL ? false : mode === modes.UV_TTY_MODE_IO ? 'io' : 'raw');
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


/** Node's TTYWrap: libuv's `uv_tty_t` where the realm has libuv, else the engine's terminal over its pairing. */
export class TTY extends KernelStreamWrap {
  get fdNumber(): number { return this.fd; }
  readonly descriptor: TTY;
  private endpoint?: TerminalEndpoint;
  get terminal(): TerminalState | undefined { return this.endpoint?.terminal; }
  get slave(): boolean { return this.endpoint?.slave === true; }

  /**
   * TTYWrap::New: uv_tty_init on `fd`, whose failure is told on `ctx` (`uv_tty_init`), so `tty.WriteStream` refuses
   * to wrap what is not a terminal. Without libuv, a run's stdout that was not given a TTY is a pipe: `isTTY` is false
   * and `hasColors` answers false, and `util.inspect` does not colorize a number on it.
   */
  constructor(fd: number, ctx?: { code?: string } | boolean) {
    super(realmHasLibuv());
    if (this[kKernelBacked]) {
      this.descriptor = this;
      // TTYWrap's constructor marks the wrap uninitialized where uv_tty_init fails (tty_wrap.cc:158-170).
      const handle = this.attachUv(nodeProgram().exports.tabnode_tty_new(), false);
      const err = nodeProgram().exports.tabnode_tty_init(handle.wrap, Number(fd) | 0);
      if (err === 0) handle.markAsInitialized();
      else collectUVExceptionInfo(ctx, err, 'uv_tty_init');
      return;
    }
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

  /**
   * TTYWrap::GetWindowSize: uv_tty_get_winsize. Without libuv, an engine pty's size, a run's terminal's (its host's
   * TIOCGWINSZ) for fd 0 to 2, else 80 by 24.
   */
  getWindowSize(out: number[]): number {
    if (this[kKernelBacked]) {
      const handle = this.liveUv();
      if (!handle) return uvConstant('UV_EBADF');
      return withRoom(8, (at) => nodeProgram().exports.tabnode_tty_get_winsize(handle.wrap, at), (view, err) => {
        if (err === 0) { out[0] = view.getInt32(0, true); out[1] = view.getInt32(4, true); }
      });
    }
    const terminal = this.terminal ?? (this.fd >= 0 && this.fd <= 2 ? runTerminalOf() : undefined);
    out[0] = terminal?.columns ?? 80;
    out[1] = terminal?.rows ?? 24;
    return 0;
  }

  /**
   * TTYWrap::SetRawMode: uv_tty_set_mode. Without libuv, fd 0's mode through the run's terminal (ADR-0010 §3);
   * ADR-0023: an engine pty endpoint has no termios, and a terminal whose host sets no mode claims no change.
   */
  setRawMode(mode: number): number {
    if (this[kKernelBacked]) {
      const handle = this.liveUv();
      if (!handle) return uvConstant('UV_EBADF');
      return nodeProgram().exports.tabnode_tty_set_mode(handle.wrap, Number(mode) | 0);
    }
    if (this.endpoint) return uvConstant('UV_ENOTSUP');
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
    if (this[kKernelBacked]) return super.readStart();
    if (this.descriptor.closed) return uvConstant('UV_EBADF');
    const result = super.readStart();
    this.endpoint?.pump();
    return result;
  }

  /** Delivered into Node's existing stream binding, preserving backpressure. */
  deliver(bytes: Uint8Array): void { this.receive(bytes); this.flushInbound(); }

  protected dispatchWrite(req: WriteWrap, bytes: Uint8Array, handle?: unknown): number {
    if (this[kKernelBacked] || !this.endpoint) return super.dispatchWrite(req, bytes, handle);
    if (this.closed || this.descriptor.closed) return uvConstant('UV_EBADF');
    if (!this.endpoint.peer?.descriptors.size) return uvConstant('UV_EIO');
    // Let the base binding set Node's synchronous-write accounting, while
    // the shared endpoint, rather than a replaceable handle, owns the bytes.
    const status = super.dispatchWrite(req, bytes);
    if (bytes.byteLength) this.endpoint.peer.input.push(bytes.slice());
    this.endpoint.peer.pump();
    return status;
  }

  protected onCloseHandle(): void {
    if (this[kKernelBacked]) return;
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


/** TTYWrap::IsTTY: libuv's `uv_guess_handle(fd) === UV_TTY`, as the running program sees it. */
export function isTTY(fd: number): boolean {
  if (realmHasLibuv()) return nodeProgram().exports.tabnode_guess_handle(Number(fd) | 0) === 1;
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

/** uv.h's uv_tty_mode_t as tty_wrap names it, for a realm with no program; endpoint mode refusals remain ADR-0023. */
const engineModes = { UV_TTY_MODE_NORMAL: 0, UV_TTY_MODE_IO: 2, UV_TTY_MODE_RAW_VT: 3 };

/** TTYWrap::Initialize's constants (tty_wrap.cc:71-73), the program's compiled ones where the realm has it. */
function ttyModes(): typeof engineModes { return wrapConstants('tty_wrap', engineModes); }

export default {
  TTY, isTTY, openPty, resizePty,
  get UV_TTY_MODE_NORMAL() { return ttyModes().UV_TTY_MODE_NORMAL; },
  get UV_TTY_MODE_IO() { return ttyModes().UV_TTY_MODE_IO; },
  get UV_TTY_MODE_RAW_VT() { return ttyModes().UV_TTY_MODE_RAW_VT; },
};
