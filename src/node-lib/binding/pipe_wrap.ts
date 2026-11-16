/**
 * `internalBinding('pipe_wrap')`: Node's PipeWrap (Node v24.21.0's `src/pipe_wrap.cc`) over libuv's `uv_pipe_t`
 * (ADR-0018 §3, item 3), where the realm's process is `node` on libuv's loop. The handle is libuv's in the process's
 * memory, an IPC one where Node makes one, its stream `kernel_stream.ts`'s; its AF_UNIX socket, a bind's node and its
 * unlink at close, `sun_path`'s bound (UV_PIPE_NO_TRUNCATE), a connect, chmod, and the handles an IPC pipe sends and
 * receives (SCM_RIGHTS, uv_write2, uv_pipe_pending_type) are libuv's (`deps/uv/src/unix/pipe.c`, `stream.c`). A
 * child's stdio pipe and its IPC channel are each one end of a socketpair its parent made (`child_stdio.ts`), opened
 * here by uv_pipe_open.
 *
 * A realm with no libuv has no AF_UNIX: a bind or connect is `EAFNOSUPPORT`, and its stdio pipes and IPC channels are
 * the engine's pairing, on which an IPC write may carry another pairing, set on the peer before the peer's read, where
 * `setupChannel` in `internal/child_process.js` takes a sent handle.
 */
import { LibuvStreamWrap, kPeer, type WriteWrap } from './stream_wrap';
import { KernelStreamWrap, kKernelBacked, realmHasLibuv, registerKernelHandle } from './kernel_stream';
import { uvConstant } from './uv';
import { handleForFd, registerFd, releaseFd } from './fds';
import { __adoptHandle, ownerOf, observeNodeRequest } from './handles';
import { nativeStreamFor, registerNativeStreamConstructor } from '../../native-stream-binding';
import { nodeProgram, withCString } from './program';
import { wrapConstants } from '../../shims/constants';

/** PipeWrap's SocketType (pipe_wrap.h:37-41) and uv.h's two chmod bits, for a realm with no program. */
const engineConstants = { SOCKET: 0, SERVER: 1, IPC: 2, UV_READABLE: 1, UV_WRITABLE: 2 };

/** PipeWrap::Initialize's constants (pipe_wrap.cc:98-103), the program's compiled ones where the realm has it. */
export function pipeConstants(): typeof engineConstants { return wrapConstants('pipe_wrap', engineConstants); }

/** Node's `PipeConnectWrap`: the request a pipe connect is answered through. */
export class PipeConnectWrap {
  oncomplete: ((status: number, handle: unknown, req: unknown, readable: boolean, writable: boolean) => void) | null = null;
  address = '';
}

export class Pipe extends KernelStreamWrap {
  readonly type: number;
  listening = false;
  onconnection: ((status: number, clientHandle: Pipe | undefined) => void) | null = null;

  /** The engine's pairing: the descriptor number it handed out for this end. */
  private ownFd: number | null = null;

  /** PipeWrap::New: a uv_pipe_init'd handle, IPC for `IPC`. */
  constructor(type: number = pipeConstants().SOCKET) {
    super(realmHasLibuv());
    this.type = type;
    if (this[kKernelBacked]) this.attachUv(nodeProgram().exports.tabnode_pipe_init(type === pipeConstants().IPC ? 1 : 0), true);
    else this.attachNative('pipe', type);
  }

  /** A pipe for a descriptor it is handed (a child's end of a socketpair), opened on it by its caller. */
  static forDescriptor(): Pipe {
    return new Pipe(pipeConstants().SOCKET);
  }

  protected override get isIpc(): boolean { return this[kKernelBacked] && this.type === pipeConstants().IPC; }

  /** ConnectionWrap::OnConnection's client: PipeWrap::Instantiate with SOCKET. */
  protected override makeClient(): Pipe {
    return new (this.constructor as typeof Pipe)(pipeConstants().SOCKET);
  }

  /** The name as PipeWrap takes it, Utf8Value of the argument, with its length (an abstract name begins with NUL). */
  #named<T>(name: string, call: (at: number, length: number) => T): T {
    return withCString(String(name), call);
  }

  /** PipeWrap::Bind: uv_pipe_bind2 with UV_PIPE_NO_TRUNCATE. */
  bind(name: string): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return uvConstant('UV_EAFNOSUPPORT');
    if (!handle) return uvConstant('UV_EBADF');
    return this.#named(name, (at, length) => nodeProgram().exports.tabnode_pipe_bind(handle.wrap, at, length));
  }

  /** PipeWrap::Listen: uv_listen, whose connections are ConnectionWrap::OnConnection's. */
  listen(backlog: number): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return uvConstant('UV_EINVAL');
    if (!handle) return uvConstant('UV_EBADF');
    const err = nodeProgram().exports.tabnode_stream_listen(handle.wrap, Number(backlog) | 0);
    if (err === 0) this.listening = true;
    return err;
  }

  /** PipeWrap::Connect: uv_pipe_connect2 under the request, completed by AfterConnect. */
  connect(req: PipeConnectWrap, name: string): number {
    const handle = this.liveUv();
    if (!this[kKernelBacked]) return uvConstant('UV_EAFNOSUPPORT');
    if (!handle) return uvConstant('UV_EBADF');
    const id = handle.dispatch(this.connectDone(req));
    const err = this.#named(name, (at, length) => nodeProgram().exports.tabnode_pipe_connect(handle.wrap, id, at, length));
    if (err) handle.undispatch(id);
    else observeNodeRequest(req, this);
    return err;
  }

  /**
   * PipeWrap::Open: uv_pipe_open of a descriptor of this process's. An engine pipe opens a descriptor the engine itself
   * handed out, a forked child's channel among them, taking over that end of its pairing with whatever arrived on it
   * before anyone opened it, because a child's channel is written to before the child runs.
   */
  open(fd: number): number {
    if (this[kKernelBacked]) {
      const handle = this.liveUv();
      if (!handle) return uvConstant('UV_EBADF');
      return nodeProgram().exports.tabnode_pipe_open(handle.wrap, Number(fd) | 0);
    }
    const native = nativeStreamFor(this);
    if (native) {
      const status = native.call({ operation: 'open', id: native.descriptor.id, fd }).status;
      if (status === 0) this.fd = fd;
      return status;
    }
    const held = handleForFd(fd);
    if (!held) return uvConstant('UV_EBADF');
    this.takeOverFrom(held as LibuvStreamWrap);
    this.ownFd = fd;
    this.fd = fd;
    return 0;
  }

  /** The descriptor an engine pipe can be reached at, for a child's stdio table. */
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

  /** PipeWrap::Fchmod: uv_pipe_chmod. */
  fchmod(mode: number): number {
    const handle = this.liveUv();
    if (!handle) return uvConstant('UV_EBADF');
    return nodeProgram().exports.tabnode_pipe_chmod(handle.wrap, Number(mode) | 0);
  }

  /** Windows asks for more pipe instances; Node defines this on Windows alone. */
  setPendingInstances(_count: number): number {
    return 0;
  }

  /**
   * An IPC write on the engine's pairing may carry another pairing of the engine's, crossing as a duplicate, the
   * receiver's own handle on the same connection, so the sender's close on `NODE_HANDLE_ACK` ends nothing; the peer is
   * given it before the bytes, so `setupChannel`'s reader sees `channel.pendingHandle` when the message it belongs to
   * arrives, and it is counted in the receiving run's loop. libuv's pipe sends its handle itself.
   */
  protected override dispatchWrite(req: WriteWrap, bytes: Uint8Array, handle?: unknown): number {
    if (this[kKernelBacked]) return super.dispatchWrite(req, bytes, handle);
    const native = nativeStreamFor(this);
    if (native) return native.write(req, [bytes], handle);
    if (handle === undefined || handle === null) return super.dispatchWrite(req, bytes);
    if (!(handle instanceof Pipe) || handle[kKernelBacked]) return uvConstant('UV_EBADF');
    const given = handle.duplicate();
    __adoptHandle(given, ownerOf(this[kPeer] ?? this), this[kPeer] ?? this);
    const status = super.dispatchWrite(req, bytes, given);
    if (status !== 0) given.close();
    return status;
  }

  /** What a close gives up beyond the stream: an engine descriptor's number. */
  protected override onCloseHandle(): void {
    this.listening = false;
    this.onconnection = null;
    if (this.ownFd !== null) { releaseFd(this.ownFd); this.ownFd = null; }
  }
}

registerNativeStreamConstructor('pipe', Pipe);
registerKernelHandle('PIPE', () => new Pipe(pipeConstants().SOCKET));
export default { Pipe, PipeConnectWrap, get constants() { return pipeConstants(); } };
