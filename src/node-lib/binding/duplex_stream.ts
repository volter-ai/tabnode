/**
 * A program's stream as a libuv stream handle (ADR-0013 §2), as Node's `JSStreamSocket` runs one over its `JSStream`
 * (`lib/internal/js_stream_socket.js`, `src/js_stream.cc`): every call into the stream runs in the guest context of the
 * call that caused it, never from the engine's own deferred work. Node still owns both socket APIs.
 */
import { queueBindingTask } from '../../guest-loop';
import { AsyncLocalStorage } from '../../shims/async_hooks';
import { invokeOwned } from './handles';
import { LibuvStreamWrap, type WriteWrap, type ShutdownWrap, streamBaseState, kBytesWritten, kLastWriteWasAsync } from './stream_wrap';
import uv, { UV_EBADF, UV_ECANCELED, UV_ENOTSUP, UV_EPIPE } from './uv';

interface DuplexTransport {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  end(callback: () => void): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

/** Node's `doWrite` error code for a stream's error: `UV_<err.code>`, else `UV_EPIPE`. */
function writeError(error: Error): number {
  const code = (uv as Record<string, unknown>)[`UV_${(error as { code?: unknown }).code}`];
  return typeof code === 'number' ? code : UV_EPIPE;
}

/** What the handle needs of the process that made it: its own `process.nextTick`, which carries its caller's context. */
interface TickingProcess {
  nextTick(callback: () => void): void;
}

/** No listener or network address is allocated for this internal connection. */
export class DuplexStreamHandle extends LibuvStreamWrap {
  // The handle's requests, each from its admission to its one answer (ADR-0013 §2), as Node's `kCurrentWriteRequest`,
  // `kPendingShutdownRequest` and `kCurrentShutdownRequest`. An answer for a request no longer held is ignored.
  private currentWrite: WriteWrap | null = null;
  private pendingShutdown: ShutdownWrap | null = null;
  private currentShutdown: ShutdownWrap | null = null;

  constructor(private readonly transport: DuplexTransport, private readonly process: TickingProcess) {
    super();
    // Paused until a reader starts reading; each chunk is read at once, inside the stream's own `data` listener
    // (`JSStream::ReadBuffer`).
    transport.pause();
    transport.on('data', (chunk: Uint8Array) => {
      this.receive(chunk);
      this.flushInbound();
    });
    transport.on('end', () => {
      this.receiveEof();
      this.flushInbound();
    });
    // The stream's own error, by its code as a write's is; its close cancels what the handle holds, as Node's
    // `JSStreamSocket` destroys itself at its stream's `close`.
    transport.on('error', (error: Error) => this.receiveError(writeError(error)));
    transport.on('close', () => {
      this.cancelRequests();
      this.receiveEof();
    });
  }

  override readStart(): number {
    const status = super.readStart();
    if (status === 0) this.transport.resume();
    return status;
  }

  override readStop(): number {
    this.transport.pause();
    return super.readStop();
  }

  /** Node's `doWrite`: the whole buffer to the stream in the writer's own call; its completion on the next turn. */
  protected override dispatchWrite(req: WriteWrap, buffer: Uint8Array): number {
    if (this.closed) return UV_EBADF;
    streamBaseState[kBytesWritten] = buffer.byteLength;
    streamBaseState[kLastWriteWasAsync] = 1;
    let done = false;
    this.transport.write(buffer.slice(), (error) => {
      if (done) return;
      done = true;
      // The context the write completed in, which a shutdown waiting on it is dispatched in (Node's `finishWrite`
      // runs in the `setImmediate` its write callback scheduled).
      const completion = AsyncLocalStorage.snapshot();
      queueBindingTask(() => this.finishWrite(req, error ? writeError(error) : 0, buffer.byteLength, completion));
    });
    // Held only once `write` has returned, as Node holds it: a `write` that throws holds no request.
    this.currentWrite = req;
    this.writeQueueSize = buffer.byteLength;
    return 0;
  }

  private finishWrite(req: WriteWrap, status: number, length: number, completion: ReturnType<typeof AsyncLocalStorage.snapshot>): void {
    if (this.currentWrite !== req) return;
    this.currentWrite = null;
    this.writeQueueSize = 0;
    if (status === 0) this.bytesWritten += length;
    invokeOwned(req, 'oncomplete', status);
    const shutdown = this.pendingShutdown;
    this.pendingShutdown = null;
    if (shutdown) completion(() => this.shutdown(shutdown));
  }

  /** Node's `doShutdown`: after a pending write, the stream's `end` on a tick of the caller's process. */
  override shutdown(req: ShutdownWrap): number {
    if (this.closed) return UV_EBADF;
    if (this.currentWrite) { this.pendingShutdown = req; return 0; }
    this.currentShutdown = req;
    this.process.nextTick(() => this.transport.end(() => this.finishShutdown(req, 0)));
    return 0;
  }

  private finishShutdown(req: ShutdownWrap, status: number): void {
    if (this.currentShutdown !== req) return;
    this.currentShutdown = null;
    invokeOwned(req, 'oncomplete', status);
  }

  /** Node's `doClose`: the stream destroyed at once; what the handle holds ends `UV_ECANCELED` on the next turn. */
  protected override onCloseHandle(): void {
    this.transport.destroy();
    this.cancelRequests();
  }

  /** Every request the handle holds, answered `UV_ECANCELED` on the next turn, a write before its shutdowns. */
  private cancelRequests(): void {
    const write = this.currentWrite;
    const shutdowns = [this.pendingShutdown, this.currentShutdown];
    this.currentWrite = this.pendingShutdown = this.currentShutdown = null;
    this.writeQueueSize = 0;
    if (!write && !shutdowns[0] && !shutdowns[1]) return;
    queueBindingTask(() => {
      if (write) invokeOwned(write, 'oncomplete', UV_ECANCELED);
      for (const shutdown of shutdowns) if (shutdown) invokeOwned(shutdown, 'oncomplete', UV_ECANCELED);
    });
  }

  getsockname(): number { return UV_ENOTSUP; }
  getpeername(): number { return UV_ENOTSUP; }
  setNoDelay(): number { return 0; }
  setKeepAlive(): number { return 0; }
}
