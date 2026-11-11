/**
 * `internalBinding('pipe_wrap')`: libuv's `uv_pipe_t`.
 *
 * A pipe that is a socket is a kernel AF_UNIX socket of its process, as libuv's is: a server binds and listens on a
 * path (`sockaddr_un`, or an abstract name with a leading NUL), a client connects to one, and the kernel makes the
 * socket's node, refuses (`ENOENT`, `ECONNREFUSED`, `EADDRINUSE`) and accepts. A child's stdio pipe and its IPC
 * channel are each one end of a `socketpair` its parent made (`child_stdio.ts`, ADR-0010 §1), and a handle crosses a
 * channel as `SCM_RIGHTS` into the receiver's own table (`kernel_stream.ts`, ADR-0009 §4). A pipe of a process whose
 * tree offers no socket calls has no AF_UNIX: a bind or connect is `EAFNOSUPPORT`, and its stdio pipes and IPC
 * channels are the engine's pairing, on which an IPC write may carry another pairing, set on the peer before the
 * peer's read, where `setupChannel` in `internal/child_process.js` takes a sent handle.
 */
import { queueBindingTask } from '../../guest-loop';
import { LibuvStreamWrap, type WriteWrap } from './stream_wrap';
import { KernelStreamWrap, kHandleFd, registerKernelHandle } from './kernel_stream';
import { callingSockets, callingTree, linux } from '../../host-sockets';
import uv, { UV_EACCES, UV_EAFNOSUPPORT, UV_EBADF, UV_ECANCELED, UV_EINVAL, UV_EIO, UV_ENOENT } from './uv';
import { handleForFd, kernelSocketType, registerFd, releaseFd } from './fds';
import { __adoptHandle, holdRequest, ownerOf, invokeOwned, observeNodeRequest, forgetNodeRequest, startHandle } from './handles';
import { detachNativeStream, nativeInheritedFdType, nativeStreamFor, registerNativeStreamConstructor } from '../../native-stream-binding';

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

/** `sizeof(sun_path)`. */
const SUN_PATH = 108;

/**
 * A `sockaddr_un` for a pipe's name, as uv_pipe_bind2 and uv_pipe_connect2 make it with `UV_PIPE_NO_TRUNCATE` (Node's
 * flag): a path NUL-terminated, an abstract name (a leading NUL) its bytes alone; an empty name, or one longer than
 * `sun_path` holds, is `EINVAL`.
 */
function unixAddress(name: string): Uint8Array | number {
  const bytes = new TextEncoder().encode(name);
  const abstract = bytes.length > 0 && bytes[0] === 0;
  if (bytes.length === 0 || (abstract ? bytes.length > SUN_PATH : bytes.length >= SUN_PATH)) return UV_EINVAL;
  const out = new Uint8Array(2 + bytes.length + (abstract ? 0 : 1));
  out[0] = linux.AF_UNIX & 255;
  out[1] = linux.AF_UNIX >> 8;
  out.set(bytes, 2);
  return out;
}

/** What a bound pipe asks of its binder's tree: its path's mode (uv_pipe_chmod) and its unlink at close (uv__pipe_close). */
interface BoundTree {
  statSync(path: string): { mode: number };
  chmodSync(path: string, mode: number): void;
  unlinkSync(path: string): void;
}

/** Set while a pipe is made for a kernel descriptor it is handed (an accepted connection, a received socket). */
let kernelEnd = false;

export class Pipe extends KernelStreamWrap {
  readonly type: number;
  listening = false;
  onconnection: ((status: number, clientHandle: Pipe) => void) | null = null;

  private ownFd: number | null = null;
  /** The path this handle bound, and the tree it is unlinked through when the handle closes, as libuv's is. */
  private bound: { path: string; tree: BoundTree | undefined } | null = null;

  constructor(type: number = constants.SOCKET) {
    // A server or IPC pipe is a socket from its start; a plain one only once it connects or is opened on a socket.
    super(kernelEnd || ((type === constants.SERVER || type === constants.IPC) && callingSockets() !== undefined));
    this.type = type;
    if (!this.kernelBacked) this.attachNative('pipe', type);
  }

  /** A pipe for a kernel descriptor it is handed: a kernel stream, opened on it by its caller. */
  static forDescriptor(): Pipe {
    kernelEnd = true;
    try { return new Pipe(constants.SOCKET); } finally { kernelEnd = false; }
  }

  /** This pipe as a kernel AF_UNIX socket of the calling process, `EAFNOSUPPORT` where the process has none. */
  private kernelSocket(): number {
    if (!this.kernelBacked) {
      if (!callingSockets()) return UV_EAFNOSUPPORT;
      detachNativeStream(this);
      this.becomeKernel();
    }
    if (this.descriptor >= 0) return 0;
    const sockets = this.sockets!;
    const fd = sockets.socket(linux.AF_UNIX, linux.SOCK_STREAM | linux.SOCK_NONBLOCK | linux.SOCK_CLOEXEC, 0);
    if (fd < 0) return fd;
    this.setDescriptor(fd);
    return 0;
  }

  /**
   * uv_pipe_bind2: a new socket bound to the name, the kernel making a path's node; a name the kernel cannot find a
   * directory for is EACCES, as libuv answers. A refused bind leaves no socket.
   */
  bind(name: string): number {
    if (this.kernelBacked && this.descriptor >= 0) return UV_EINVAL;
    const address = unixAddress(String(name));
    if (typeof address === 'number') return address;
    const status = this.kernelSocket();
    if (status !== 0) return status;
    const bound = this.sockets!.bind(this.descriptor, address);
    if (bound < 0) {
      this.sockets!.close(this.descriptor);
      this.setDescriptor(-1);
      return bound === UV_ENOENT ? UV_EACCES : bound;
    }
    const path = String(name);
    if (path.charCodeAt(0) !== 0) this.bound = { path, tree: callingTree() as BoundTree | undefined };
    return 0;
  }

  /** uv_pipe_listen: listen(2) on the bound socket, which then holds its loop; listening again sets its backlog. */
  listen(backlog: number): number {
    if (!this.kernelBacked || this.descriptor < 0 || this.type === constants.IPC) return UV_EINVAL;
    const listened = this.sockets!.listen(this.descriptor, Number(backlog) | 0);
    if (listened < 0) return listened;
    this.listening = true;
    startHandle(this);
    this.waitIn();
    return 0;
  }

  /** A listener's readiness is a connection to accept (one a received listener's receiver has not served waits). */
  protected override onReadable(): void {
    if (!this.listening) { super.onReadable(); return; }
    if (this.closed || this.onconnection === null) return;
    this.serveConnection((fd, sockets) => {
      const accepted = Pipe.forDescriptor();
      accepted.setDescriptor(fd, sockets);
      return accepted;
    });
  }

  /**
   * uv_pipe_connect2: a socket connected to the name; the kernel answers at once for AF_UNIX (a refusal, no such
   * path, a full backlog), and the request completes on a later turn either way, as libuv's does.
   */
  connect(req: PipeConnectWrap, name: string): number {
    const address = unixAddress(String(name));
    if (typeof address === 'number') return address;
    let status = this.kernelSocket();
    if (status === 0) {
      let connected: number;
      do connected = this.sockets!.connect(this.descriptor, address); while (connected === -linux.EINTR);
      status = connected < 0 ? connected : 0;
      if (status === 0) this.setOpen(true, true);
    }
    observeNodeRequest(req, this);
    const release = holdRequest(this);
    // A handle closed first completes it ECANCELED, as uv__stream_destroy does.
    queueBindingTask(() => {
      try { invokeOwned(req, 'oncomplete', this.closed ? UV_ECANCELED : status, this, req, true, true); }
      finally { forgetNodeRequest(req); release(); }
    });
    return 0;
  }

  /**
   * uv_pipe_open. A kernel pipe opens a descriptor of its process; a child's channel in its parent's realm, on its
   * parent's tree, is the end its parent's spawn made, which it takes. A plain pipe opened on a kernel AF_UNIX socket
   * becomes one. An engine pipe opens a descriptor the engine itself handed out, a forked child's channel among them,
   * taking over that end of its pairing with whatever arrived on it before anyone opened it, because a child's channel
   * is written to before the child runs.
   */
  open(fd: number): number {
    const held = handleForFd(fd);
    const sockets = callingSockets();
    const kernelSocket = held === undefined && nativeInheritedFdType(fd) === undefined && sockets !== undefined
      && kernelSocketType(sockets, fd) === 'PIPE';
    if (this.kernelBacked || kernelSocket) {
      if (held instanceof Pipe && held.kernelBacked && held[kHandleFd] >= 0) { this.takeDescriptorFrom(held); return 0; }
      if (!this.kernelBacked) { detachNativeStream(this); this.becomeKernel(); }
      return this.openDescriptor(fd);
    }
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'open', id: native.descriptor.id, fd }).status;
      if (status === 0) this.fd = fd;
      return status;
    }
    if (!held) return UV_EBADF;
    this.takeOverFrom(held as LibuvStreamWrap);
    this.ownFd = fd;
    this.fd = fd;
    return 0;
  }

  /** The descriptor this handle can be reached at, for a child's stdio table. */
  toFd(): number {
    if (this.ownFd === null) { this.ownFd = registerFd('PIPE', this); this.fd = this.ownFd; }
    return this.ownFd;
  }

  /** libuv's `dup()` of an engine pipe: the same pairing, under the same flavour. */
  override duplicate(): Pipe {
    const native = nativeStreamFor(this);
    const copy = native ? native.duplicate() as Pipe : new (this.constructor as typeof Pipe)(this.type);
    if (!native) copy.shareConnectionFrom(this);
    return copy;
  }

  /**
   * uv_pipe_chmod: the bound path's mode gains read (`UV_READABLE`) or write (`UV_WRITABLE`) for its owner, group and
   * others, where it lacks them; a path chmod, as libuv's (fchmod of a socket changes no node).
   */
  fchmod(mode: number): number {
    if (!this.kernelBacked || this.descriptor < 0) return UV_EBADF;
    const both = constants.UV_READABLE | constants.UV_WRITABLE;
    if (mode !== constants.UV_READABLE && mode !== constants.UV_WRITABLE && mode !== both) return UV_EINVAL;
    const bound = this.bound;
    if (!bound?.tree) return UV_EINVAL;
    const wanted = (mode & constants.UV_READABLE ? 0o444 : 0) | (mode & constants.UV_WRITABLE ? 0o222 : 0);
    try {
      const current = bound.tree.statSync(bound.path).mode & 0o7777;
      if ((current & wanted) !== wanted) bound.tree.chmodSync(bound.path, current | wanted);
      return 0;
    } catch (cause) {
      const value = uv[`UV_${String((cause as { code?: unknown } | null)?.code)}`];
      return typeof value === 'number' ? value : UV_EIO;
    }
  }

  /** Windows asks for more pipe instances; the engine has one realm and one. */
  setPendingInstances(_count: number): number {
    return 0;
  }

  /** An IPC kernel pipe sends a handle's descriptor (`uv__handle_fd`); one that has none is EBADF, as uv_write2 answers. */
  protected override descriptorToSend(handle: unknown): number {
    if (this.type !== constants.IPC) return super.descriptorToSend(handle);
    const fd = (handle as { [kHandleFd]?: unknown })[kHandleFd];
    return typeof fd === 'number' && fd >= 0 ? fd : UV_EBADF;
  }

  protected override get receivesDescriptors(): boolean { return this.type === constants.IPC; }

  /**
   * An IPC write may carry a handle. On a kernel pipe it is the descriptor's `sendmsg` (`kernel_stream.ts`). On the
   * engine's pairing it is another pairing of the engine's, crossing as a duplicate, the receiver's own handle on the
   * same connection, so the sender's close on `NODE_HANDLE_ACK` ends nothing; the peer is given it before the bytes, so
   * `setupChannel`'s reader sees `channel.pendingHandle` when the message it belongs to arrives, and it is counted in
   * the receiving run's loop. A kernel handle has no place on a pairing (its process has no socket calls to have made
   * it with): EBADF.
   */
  protected override dispatchWrite(req: WriteWrap, bytes: Uint8Array, handle?: unknown): number {
    if (this.kernelBacked) return super.dispatchWrite(req, bytes, handle);
    const native = nativeStreamFor(this);
    if (native) return native.write(req, [bytes], handle);
    if (handle === undefined || handle === null) return super.dispatchWrite(req, bytes);
    if (!(handle instanceof Pipe) || handle.kernelBacked) return UV_EBADF;
    const given = handle.duplicate();
    __adoptHandle(given, ownerOf(this.peer ?? this), this.peer ?? this);
    const status = super.dispatchWrite(req, bytes, given);
    if (status !== 0) given.close();
    return status;
  }

  /** uv__pipe_close: a bound path is unlinked; a descriptor the engine handed out is given back. */
  protected override onCloseHandle(): void {
    this.listening = false;
    this.onconnection = null;
    const bound = this.bound;
    this.bound = null;
    if (bound) { try { bound.tree?.unlinkSync(bound.path); } catch { /* gone already */ } }
    if (this.ownFd !== null) { releaseFd(this.ownFd); this.ownFd = null; }
  }
}

registerNativeStreamConstructor('pipe', Pipe);
registerKernelHandle('PIPE', () => Pipe.forDescriptor());
export default { Pipe, PipeConnectWrap, constants };
