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
import { queueBindingTask } from '../../guest-loop';
import { LibuvStreamWrap, type WriteWrap } from './stream_wrap';
import { UV_EACCES, UV_EADDRINUSE, UV_ECONNREFUSED, UV_ENOENT, UV_ENOTDIR, UV_EBADF } from './uv';
import { handleForFd, registerFd, releaseFd } from './fds';
import { __adoptHandle, ownerOf, invokeOwned, observeNodeRequest, forgetNodeRequest } from './handles';
import { nativeStreamFor, registerNativeStreamConstructor } from '../../native-stream-binding';

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

/**
 * The tree of the run whose code is executing, where it can make a socket's node: an AF_UNIX bind to a path makes an
 * S_IFSOCK node there (net/unix/af_unix.c unix_bind_bsd), which `chmod`, `stat` and `unlink` then find. A tree that
 * cannot make one (no `createSocketSync`) keeps the name in the registry alone, as before.
 */
interface SocketTree {
  createSocketSync?(path: string, mode: number): void;
  lstatSync(path: string): { isSocket(): boolean };
  unlinkSync(path: string): void;
}
const kRunFilesystem = Symbol.for('tabnode.run.vfs');
function runTree(): SocketTree | undefined {
  return (globalThis as unknown as { process?: Record<symbol, unknown> }).process?.[kRunFilesystem] as SocketTree | undefined;
}
function socketTree(): SocketTree | undefined {
  const tree = runTree();
  return typeof tree?.createSocketSync === 'function' ? tree : undefined;
}
/**
 * A connect no listener answers: ECONNREFUSED where something is at the path (a socket node left by a server that
 * ended without closing, as Linux answers: unix_find_bsd finds the inode, no socket listens), ENOENT where nothing is.
 * A program that finds a stale socket so unlinks it and binds again (pm2's axon on its pub.sock and rpc.sock).
 */
function noListener(path: string): number {
  if (path.length === 0 || path.charCodeAt(0) === 0) return UV_ECONNREFUSED;
  const tree = runTree();
  if (!tree || typeof tree.lstatSync !== 'function') return UV_ENOENT;
  try { tree.lstatSync(path); return UV_ECONNREFUSED; } catch { return UV_ENOENT; }
}

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
  /** The socket node this handle's bind made in its run's tree, and the tree: removed at close, as libuv's is. */
  private node: { path: string; tree: SocketTree } | null = null;

  constructor(type: number = constants.SOCKET) {
    super();
    this.type = type;
    this.attachNative('pipe', type);
  }

  /**
   * A bind to a path makes the socket's node in the run's tree (the mode 0777, less the umask the tree's process
   * applies), then takes the name: a path that exists is EADDRINUSE, as Linux answers even for a stale socket. A
   * bind the name refuses takes its node away again.
   */
  bind(path: string): number {
    const made = this.makeNode(path);
    if (made !== 0) return made;
    let status = UV_EBADF;
    try {
      const native = nativeStreamFor(this);
      status = native ? native.call({ operation: 'bind', id: native.descriptor.id, address: path }).status : this.bindName(path);
    } finally {
      // A bind refused, or a channel that threw, leaves no node behind.
      if (status !== 0) this.dropNode();
    }
    return status;
  }

  /** The name alone, in the registry a connect looks in: what the native-stream owner binds (the guest made the node). */
  bindName(path: string): number {
    const held = boundPaths.get(path);
    if (held && held !== this) return UV_EADDRINUSE;
    this.path = path;
    boundPaths.set(path, this);
    return 0;
  }

  listen(_backlog: number): number {
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'listen', id: native.descriptor.id, backlog: _backlog }).status;
      if (status === 0) this.listening = true;
      return status;
    }
    if (this.path === null) return UV_EBADF;
    this.listening = true;
    return 0;
  }

  connect(req: PipeConnectWrap, path: string): number {
    const native = nativeStreamFor(this);
    // The owner's registry knows names, not nodes: its "no such name" is said here, where the run's tree is.
    observeNodeRequest(req);
    if (native) {
      try {
        const status = native.connect(path, undefined, false, status => invokeOwned(req, 'oncomplete', status === UV_ENOENT ? noListener(path) : status, this, req, true, true));
        if (status !== 0) forgetNodeRequest(req);
        return status;
      } catch (cause) { forgetNodeRequest(req); throw cause; }
    }
    // libuv answers a connect through the request, never from the call.
    queueBindingTask(() => {
      try {
        if (this.closed) { forgetNodeRequest(req); return; }
        const server = listenerOnPath(path);
        if (!server) {
          invokeOwned(req, 'oncomplete', noListener(path), this, req, true, true);
          return;
        }
        const accepted = new (server.constructor as typeof Pipe)(server.type === constants.IPC ? constants.IPC : constants.SOCKET);
        accepted.path = path;
        // The serving run owns what it accepted, not the connecting one.
        __adoptHandle(accepted, ownerOf(server), server);
        LibuvStreamWrap.pair(this, accepted);
        invokeOwned(server, 'onconnection', 0, accepted);
        invokeOwned(req, 'oncomplete', 0, this, req, true, true);
      } finally { forgetNodeRequest(req); }
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
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'open', id: native.descriptor.id, fd }).status;
      if (status === 0) this.fd = fd;
      return status;
    }
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
    const native = nativeStreamFor(this);
    const copy = native ? native.duplicate() as Pipe : new (this.constructor as typeof Pipe)(this.type);
    if (!native) copy.shareConnectionFrom(this);
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
   * on the socket is an active handle of that process's loop. The binding
   * duplicates the wrapper and assigns that reference to the receiver.
   * Without that ownership, openvscode-server's extension
   * host -- a program whose only handle is the socket its parent sent it --
   * read as idle and was settled with exit 0.
   */
  protected override dispatchWrite(req: WriteWrap, bytes: Uint8Array, handle?: unknown): number {
    const native = nativeStreamFor(this);
    if (native) return native.write(req, [bytes], handle);
    if (handle === undefined || handle === null) return super.dispatchWrite(req, bytes);
    // A descriptor crosses as a duplicate, as `SCM_RIGHTS` hands one over: the
    // receiver gets its own handle on the same connection, so the sender's
    // close on `NODE_HANDLE_ACK` -- which Node's `child_process.js` does the
    // moment the receiver confirms -- ends nothing. A connection is duplicated
    // whether or not its other end is still there; a listening server has no
    // connection to duplicate and crosses as it is.
    const sent = handle as LibuvStreamWrap & { listening?: boolean };
    const given = sent.listening === true ? sent : sent.duplicate();
    // The receiving run owns this reference; the sender retains its own until
    // Node closes it on acknowledgement, or continues using it with keepOpen.
    __adoptHandle(given, ownerOf(this.peer ?? this), this.peer ?? this);
    const status = super.dispatchWrite(req, bytes, given);
    if (status !== 0 && given !== sent) given.close();
    return status;
  }

  private makeNode(path: string): number {
    if (path.length === 0 || path.charCodeAt(0) === 0) return 0; // an abstract name has no node
    const tree = socketTree();
    if (!tree) return 0;
    // A relative name is the bind's working directory's, as unix_bind_bsd resolves it then; the node keeps that path.
    if (!path.startsWith('/')) {
      const cwd = (globalThis as unknown as { process?: { cwd?: () => string } }).process?.cwd?.();
      if (typeof cwd !== 'string' || !cwd.startsWith('/')) return 0;
      // Normalized, so the node, its unlink and every trace name one path (`./x.sock` is `<cwd>/x.sock`).
      const parts: string[] = [];
      for (const part of `${cwd}/${path}`.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') parts.pop(); else parts.push(part);
      }
      path = `/${parts.join('/')}`;
    }
    try { tree.createSocketSync!(path, 0o777); }
    catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === 'EEXIST') return UV_EADDRINUSE;
      if (code === 'ENOENT') return UV_ENOENT;
      if (code === 'ENOTDIR') return UV_ENOTDIR;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return UV_EACCES;
      return 0; // a tree that makes no socket node keeps the name alone
    }
    this.node = { path, tree };
    return 0;
  }

  /** The node this bind made, removed while it is still a socket (libuv's uv__pipe_close unlinks the bound name). */
  private dropNode(): void {
    const node = this.node;
    this.node = null;
    if (!node) return;
    try { if (node.tree.lstatSync(node.path).isSocket()) node.tree.unlinkSync(node.path); } catch { /* gone already */ }
  }

  protected override onCloseHandle(): void {
    this.dropNode();
    this.listening = false;
    this.onconnection = null;
    if (this.path !== null && boundPaths.get(this.path) === this) boundPaths.delete(this.path);
    if (this.ownFd !== null) { releaseFd(this.ownFd); this.ownFd = null; }
  }
}

registerNativeStreamConstructor('pipe', Pipe);
export default { Pipe, PipeConnectWrap, constants };
