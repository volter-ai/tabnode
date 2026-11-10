/**
 * `internalBinding('js_stream')`: Node's `JSStream` (src/js_stream.cc), the StreamBase a `JSStreamSocket`
 * (`lib/internal/js_stream_socket.js`, vendored) drives from JavaScript, so a TLS socket can wrap a stream that has
 * no native handle. Its reads are the bytes the JavaScript side hands it (`readBuffer`, `emitEOF`); its writes and
 * shutdowns go to the JavaScript side (`onwrite`, `onshutdown`), which completes them (`finishWrite`,
 * `finishShutdown`). Each method names the lines of js_stream.cc it carries.
 */
import { Buffer } from '../buffer-module';
import { LibuvStreamWrap, ShutdownWrap, WriteWrap, streamBaseState, kBytesWritten, kLastWriteWasAsync } from './stream_wrap';
import { invokeOwned } from './handles';
import { UV_EPROTO } from './uv';

/** A callback's answer as Node reads it (`Int32Value`), UV_EPROTO where it gave none. */
function status(value: unknown): number {
  return typeof value === 'number' ? value | 0 : UV_EPROTO;
}

export class JSStream extends LibuvStreamWrap {
  isStreamBase = true;

  /** IsClosing (44-58). */
  isClosing(): boolean { return Boolean(invokeOwned(this, 'isclosing')); }

  /** ReadStart/ReadStop (60-86): the JavaScript side's. */
  override readStart(): number {
    const result = super.readStart();
    if (result !== 0) return result;
    return status(invokeOwned(this, 'onreadstart'));
  }
  override readStop(): number {
    super.readStop();
    return status(invokeOwned(this, 'onreadstop'));
  }

  /** DoShutdown (88-106). */
  override shutdown(req: ShutdownWrap): number {
    return status(invokeOwned(this, 'onshutdown', req));
  }

  /** DoWrite (109-141): a copy of the bytes, as an array of one Buffer (writev has joined them). */
  protected override dispatchWrite(req: WriteWrap, buffer: Uint8Array): number {
    streamBaseState[kBytesWritten] = buffer.byteLength;
    streamBaseState[kLastWriteWasAsync] = 1;
    this.bytesWritten += buffer.byteLength;
    return status(invokeOwned(this, 'onwrite', req, [Buffer.from(buffer)]));
  }

  /** Finish<WriteWrap>/Finish<ShutdownWrap> (155-162): the request's Done. */
  finishWrite(req: WriteWrap, errCode: number): void { invokeOwned(req, 'oncomplete', errCode | 0); }
  finishShutdown(req: ShutdownWrap, errCode: number): void { invokeOwned(req, 'oncomplete', errCode | 0); }

  /** ReadBuffer (165-189): the bytes, emitted as a read synchronously, inside the stream's own `data` listener. */
  readBuffer(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    LibuvStreamWrap.prototype.receive.call(this, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
    this.flushInbound();
  }

  /** EmitEOF (192-200): at once, as the read is. */
  emitEOF(): void {
    this.receiveEof();
    this.flushInbound();
  }
}

export default { JSStream };
