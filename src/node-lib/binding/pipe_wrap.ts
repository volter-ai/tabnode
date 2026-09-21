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
import { UV_EADDRINUSE, UV_ENOENT, UV_EBADF } from './uv';
import { handleForFd, registerFd, releaseFd } from './fds';
import { __adoptHandle, ownerOf } from './handles';

/** libuv's `uv_pipe_t` flavours, and the two chmod bits `listen` reads. */
export const constants = {
  SOCKET: 0,
  SERVER: 1,
  IPC: 1 << 1,
  UV_READABLE: 1,
  UV_WRITABLE: 2,
};

/** Node's `PipeConnectWrap`: the request a pipe connect is answered through. */
export class PipeConnectWrap {
  oncomplete: ((status: number, handle: unknown, req: unknown, readable: boolean, writable: boolean) => void) | null = null;
  address = '';
}

/** Every path this engine holds, bound or listening. */
const boundPaths = new Map<string, Pipe>();

/** The listening pipe a connect to this path reaches, if any. */
export function listenerOnPath(path: string): Pipe | undefined {
  const bound = boundPaths.get(path);
  return bound && bound.listening ? bound : undefined;
}

export class Pipe extends LibuvStreamWrap {
  readonly type: number;
  listening = false;
  onconnection: ((status: number, clientHandle: Pipe) => void) | null = null;

  private path: string | null = null;
  private ownFd: number | null = null;

  constructor(type: number = constants.SOCKET) {
    super();
    this.type = type;
  }

  bind(path: string): number {
    const held = boundPaths.get(path);
    if (held && held !== this) return UV_EADDRINUSE;
    this.path = path;
    boundPaths.set(path, this);
    return 0;
  }

  listen(_backlog: number): number {
    if (this.path === null) return UV_EBADF;
    this.listening = true;
    return 0;
  }

  connect(req: PipeConnectWrap, path: string): number {
    // libuv answers a connect through the request, never from the call.
    queueMicrotask(() => {
      if (this.closed) return;
      const server = listenerOnPath(path);
      if (!server) {
        req.oncomplete?.(UV_ENOENT, this, req, true, true);
        return;
      }
      const accepted = new Pipe(server.type === constants.IPC ? constants.IPC : constants.SOCKET);
      accepted.path = path;
      // The serving run owns what it accepted, not the connecting one.
      __adoptHandle(accepted, ownerOf(server));
      LibuvStreamWrap.pair(this, accepted);
      server.onconnection?.(0, accepted);
      req.oncomplete?.(0, this, req, true, true);
    });
    return 0;
  }

  /**
   * The descriptor of a handle the engine itself opened — a forked child's IPC
   * channel among them. There is nothing else to open: the engine has no
   * descriptors of its own beyond the ones it hands out. Opening one takes
   * over that end of its pairing, with whatever arrived on it before anyone
   * opened it, because a child's channel is written to before the child runs.
   */
  open(fd: number): number {
    const held = handleForFd(fd) as LibuvStreamWrap | undefined;
    if (!held) return UV_EBADF;
    this.takeOverFrom(held);
    this.ownFd = fd;
    this.fd = fd;
    return 0;
  }

  /** The descriptor this handle can be reached at, for a child's stdio table. */
  toFd(): number {
    if (this.ownFd === null) { this.ownFd = registerFd('PIPE', this); this.fd = this.ownFd; }
    return this.ownFd;
  }

  /** libuv's `dup()`: the same pairing, under the same flavour. */
  override duplicate(): Pipe {
    const copy = new Pipe(this.type);
    copy.takeOverFrom(this);
    return copy;
  }

  /** There is no filesystem entry behind an engine pipe to change the mode of. */
  fchmod(_mode: number): number {
    return 0;
  }

  /** Windows asks for more pipe instances; the engine has one realm and one. */
  setPendingInstances(_count: number): number {
    return 0;
  }

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
  override writeUtf8String(req: WriteWrap, text: string, handle?: unknown): number {
    if (handle === undefined || handle === null) return super.writeUtf8String(req, text);
    // A descriptor crosses as a duplicate, as `SCM_RIGHTS` hands one over: the
    // receiver gets its own handle on the same connection, so the sender's
    // close on `NODE_HANDLE_ACK` -- which Node's `child_process.js` does the
    // moment the receiver confirms -- ends nothing. A handle with no pairing,
    // a listening server's, has nothing to duplicate and crosses as it is.
    const sent = handle as LibuvStreamWrap;
    const given = sent.peer !== null ? sent.duplicate() : sent;
    // The receiving run owns it from here: parent and child are one realm and
    // there is no descriptor table to move it in, so the move is the count the
    // engine keeps of what holds a run open.
    __adoptHandle(given, ownerOf(this.peer ?? this));
    return super.writeUtf8String(req, text, given);
  }

  protected override onCloseHandle(): void {
    this.listening = false;
    this.onconnection = null;
    if (this.path !== null && boundPaths.get(this.path) === this) boundPaths.delete(this.path);
    if (this.ownFd !== null) { releaseFd(this.ownFd); this.ownFd = null; }
  }
}

export default { Pipe, PipeConnectWrap, constants };
