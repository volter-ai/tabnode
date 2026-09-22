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
import { LibuvStreamWrap, type WriteWrap } from './stream_wrap';
import { guessHandleTypeOfFd, handleForFd, registerFd, releaseFd } from './fds';
import { UV_EBADF, UV_EIO, UV_ENOTSUP } from './uv';

export interface TerminalState {
  columns: number;
  rows: number;
  onResize(listener: (columns: number, rows: number) => void): () => void;
  resize(columns: number, rows: number): void;
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
    queueMicrotask(() => {
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
    }
  }

  /** A terminal the engine does not own has one size and no mode to set. */
  getWindowSize(out: number[]): number {
    out[0] = this.terminal?.columns ?? 80;
    out[1] = this.terminal?.rows ?? 24;
    return 0;
  }

  setRawMode(_raw: number): number {
    // ADR-0023: this host has no termios. Do not claim a mode change.
    return this.endpoint ? UV_ENOTSUP : 0;
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
  const realm = (globalThis as unknown as {
    process?: { stdin?: { isTTY?: boolean }; stdout?: { isTTY?: boolean }; stderr?: { isTTY?: boolean } };
  }).process;
  const stream = fd === 0 ? realm?.stdin : fd === 1 ? realm?.stdout : realm?.stderr;
  return stream?.isTTY === true;
}

export default { TTY, isTTY, openPty, resizePty };
