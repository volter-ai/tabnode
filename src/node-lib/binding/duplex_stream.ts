/** A Node Duplex as a libuv stream handle. Node still owns both socket APIs. */
import { queueBindingTask, withGuestExecution } from '../../guest-loop';
import { invokeOwned } from './handles';
import { LibuvStreamWrap, type WriteWrap, type ShutdownWrap, streamBaseState, kBytesWritten, kLastWriteWasAsync } from './stream_wrap';
import { UV_EBADF, UV_ECONNRESET, UV_ENOTSUP } from './uv';

interface DuplexTransport {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  end(callback: () => void): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

/** No listener or network address is allocated for this internal connection. */
export class DuplexStreamHandle extends LibuvStreamWrap {
  private pendingWrite?: (status: number) => void;

  constructor(private readonly transport: DuplexTransport) {
    super();
    transport.pause();
    transport.on('data', (chunk: Uint8Array) => {
      transport.pause();
      this.receive(chunk);
    });
    transport.on('end', () => this.receiveEof());
    transport.on('error', () => {
      this.pendingWrite?.(UV_ECONNRESET);
      this.receiveError(UV_ECONNRESET);
    });
    transport.on('close', () => {
      this.pendingWrite?.(UV_ECONNRESET);
      this.receiveEof();
    });
  }

  override readStop(): number {
    this.transport.pause();
    return super.readStop();
  }

  protected override flushInbound(): void {
    super.flushInbound();
    if (this.reading && !this.closed && !this.inboundEof) this.transport.resume();
  }

  protected override dispatchWrite(req: WriteWrap, buffer: Uint8Array): number {
    if (this.closed) return UV_EBADF;
    streamBaseState[kBytesWritten] = buffer.byteLength;
    streamBaseState[kLastWriteWasAsync] = 1;
    this.writeQueueSize = buffer.byteLength;
    let offset = 0;
    let complete = false;
    const finish = (status: number): void => {
      if (complete) return;
      complete = true;
      this.pendingWrite = undefined;
      this.writeQueueSize = 0;
      queueBindingTask(() => invokeOwned(req, 'oncomplete', status));
    };
    this.pendingWrite = finish;
    const next = (): void => {
      if (complete) return;
      if (this.closed) { finish(UV_EBADF); return; }
      if (offset === buffer.byteLength) { finish(0); return; }
      // A caller's large write is retained until its callback, as in Node;
      // only one bounded copy enters the transport at a time.
      const bytes = buffer.slice(offset, offset + 64 * 1024);
      offset += bytes.byteLength;
      // The transport's `write` is the wrapped Duplex's own: program code. The task that calls it is run with no
      // bracket (queueBindingTask), which is right for a callback a binding makes and wrong here: with the depth
      // at zero, a binding callback made inside that write took itself for the outermost and drained the ticks
      // while the write was still on the stack. The call is bracketed as the program code it is.
      withGuestExecution(() => this.transport.write(bytes, error => {
        if (error) { finish(UV_ECONNRESET); return; }
        this.bytesWritten += bytes.byteLength;
        this.writeQueueSize -= bytes.byteLength;
        next();
      }));
    };
    queueBindingTask(next);
    return 0;
  }

  override shutdown(req: ShutdownWrap): number {
    if (this.closed) return UV_EBADF;
    this.transport.end(() => invokeOwned(req, 'oncomplete', 0));
    return 0;
  }

  protected override onCloseHandle(): void {
    this.pendingWrite?.(UV_EBADF);
    this.transport.destroy();
  }

  getsockname(): number { return UV_ENOTSUP; }
  getpeername(): number { return UV_ENOTSUP; }
  setNoDelay(): number { return 0; }
  setKeepAlive(): number { return 0; }
}
