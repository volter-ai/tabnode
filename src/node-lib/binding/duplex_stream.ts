/**
 * A program's stream as a libuv stream handle (ADR-0013 §2), as Node's `JSStreamSocket` runs one over its `JSStream`
 * (`lib/internal/js_stream_socket.js`, `src/js_stream.cc`): every call into the stream runs in the guest context of the
 * call that caused it, never from the engine's own deferred work. Node still owns both socket APIs.
 */
import { queueBindingTask, queueGuestNextTick } from '../../guest-loop';
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

/** No listener or network address is allocated for this internal connection. */
export class DuplexStreamHandle extends LibuvStreamWrap {
  private pendingWrite?: (status: number) => void;
  private pendingShutdown?: ShutdownWrap;

  constructor(private readonly transport: DuplexTransport) {
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
    // The stream's own error, by its code as a write's is; its close ends what it had not finished.
    transport.on('error', (error: Error) => this.receiveError(writeError(error)));
    transport.on('close', () => {
      this.pendingWrite?.(UV_ECANCELED);
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
    this.writeQueueSize = buffer.byteLength;
    let complete = false;
    const finish = (status: number): void => {
      if (complete) return;
      complete = true;
      this.pendingWrite = undefined;
      this.writeQueueSize = 0;
      if (status === 0) this.bytesWritten += buffer.byteLength;
      queueBindingTask(() => {
        invokeOwned(req, 'oncomplete', status);
        const shutdown = this.pendingShutdown;
        this.pendingShutdown = undefined;
        if (shutdown) this.shutdown(shutdown);
      });
    };
    this.pendingWrite = finish;
    this.transport.write(buffer.slice(), error => finish(error ? writeError(error) : 0));
    return 0;
  }

  /** Node's `doShutdown`: after a pending write, the stream's `end` on a tick of the caller. */
  override shutdown(req: ShutdownWrap): number {
    if (this.closed) return UV_EBADF;
    if (this.pendingWrite) { this.pendingShutdown = req; return 0; }
    queueGuestNextTick(() => this.transport.end(() => invokeOwned(req, 'oncomplete', 0)));
    return 0;
  }

  /** Node's `doClose`: the stream destroyed at once; a pending write or shutdown ends `UV_ECANCELED`. */
  protected override onCloseHandle(): void {
    this.transport.destroy();
    this.pendingWrite?.(UV_ECANCELED);
    const shutdown = this.pendingShutdown;
    this.pendingShutdown = undefined;
    if (shutdown) queueBindingTask(() => invokeOwned(shutdown, 'oncomplete', UV_ECANCELED));
  }

  getsockname(): number { return UV_ENOTSUP; }
  getpeername(): number { return UV_ENOTSUP; }
  setNoDelay(): number { return 0; }
  setKeepAlive(): number { return 0; }
}
