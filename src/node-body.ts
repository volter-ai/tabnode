/**
 * A body as Node's fetch (undici's `extractBody`) accepts it: besides what a
 * browser takes, any async iterable (a Node `Readable`, an `http.IncomingMessage`,
 * an async generator) is read as a stream of its chunks, each a `Buffer`,
 * a typed array or a string (UTF-8). A browser's `Request` and `Response` take
 * such an object for a string: `new Request(url, { method: 'POST', body:
 * incomingMessage, duplex: 'half' })` has the body "[object Object]". Next's
 * App Router builds every route handler's request exactly that way (its
 * request adapter passes the Node request as the body, "handled by undici"),
 * so every POST a route handler read was that string, and NextAuth's
 * credentials callback found no CSRF token in it.
 *
 * A body that is a view of shared memory is the other one changed: undici copies a view's bytes into the request
 * (`extractBody`: `new Uint8Array(object.buffer.slice(…))`), and the platform's fetch refuses a shared view, so
 * the request is given an unshared copy of exactly those bytes.
 *
 * Only such bodies are changed; every other init is handed on untouched.
 */
import { Buffer } from './node-lib/buffer-module';

/** The mark Node's streams carry once read (`internal/streams/utils`, `kIsDisturbed`). */
const kIsDisturbed = Symbol.for('nodejs.stream.disturbed');

function isAsyncIterableBody(body: unknown): body is AsyncIterable<unknown> {
  if (body === null || typeof body !== 'object') return false;
  if (typeof ReadableStream === 'function' && body instanceof ReadableStream) return false;
  if (typeof Blob === 'function' && body instanceof Blob) return false;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false;
  if (typeof FormData === 'function' && body instanceof FormData) return false;
  if (body instanceof URLSearchParams) return false;
  return typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

/** Node's `isDisturbed`, and undici's refusal of a body already read or locked. */
function refuseDisturbed(body: object): void {
  const stream = body as { locked?: unknown; readableDidRead?: unknown; readableAborted?: unknown; [kIsDisturbed]?: unknown };
  const disturbed = stream[kIsDisturbed] !== undefined ? Boolean(stream[kIsDisturbed]) : Boolean(stream.readableDidRead || stream.readableAborted);
  if (disturbed || stream.locked === true) throw new TypeError('Response body object should not be disturbed or locked');
}

/**
 * undici's `ReadableStreamFrom`: the iterator made when the stream starts,
 * each chunk `Buffer.from`'d as Node's is (a chunk `Buffer.from` refuses
 * errors the stream), an empty chunk passed over for the next, and the
 * iterator returned, with no argument, on cancel.
 */
function streamFrom(iterable: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<unknown> | undefined;
  return new ReadableStream<Uint8Array>({
    async start() { iterator = iterable[Symbol.asyncIterator](); },
    async pull(controller) {
      for (;;) {
        const { done, value } = await iterator!.next();
        if (done) { controller.close(); return; }
        const bytes = (Buffer.isBuffer(value) ? value : (Buffer.from as (chunk: unknown) => Uint8Array)(value)) as Uint8Array;
        if (bytes.byteLength) { controller.enqueue(new Uint8Array(bytes)); return; }
      }
    },
    async cancel() { await iterator?.return?.(); },
  }, { highWaterMark: 0 });
}

const REQUEST_INIT_MEMBERS = ['method', 'headers', 'referrer', 'referrerPolicy', 'mode', 'credentials', 'cache', 'redirect', 'integrity', 'keepalive', 'signal', 'window', 'duplex', 'priority'] as const;

/**
 * The init with an async-iterable body read as a stream, or the init itself.
 * The body is read once; the replacement is built member by member (an init
 * may carry its members on getters of its prototype, as a `Request` passed as
 * an init does), with the init's own other members as they are.
 */
export function withNodeRequestBody<T extends RequestInit | undefined>(init: T): T {
  if (!init) return init;
  const body = (init as RequestInit).body as unknown;
  const shared = ArrayBuffer.isView(body) && Object.prototype.toString.call(body.buffer) === '[object SharedArrayBuffer]';
  if (!shared && !isAsyncIterableBody(body)) return init;
  if (!shared) refuseDisturbed(body as object);
  const copy: Record<string, unknown> = {};
  for (const member of Object.keys(init)) if (member !== 'body') copy[member] = (init as Record<string, unknown>)[member];
  for (const member of REQUEST_INIT_MEMBERS) {
    if (member in copy) continue;
    const value = (init as Record<string, unknown>)[member];
    if (value !== undefined) copy[member] = value;
  }
  copy.body = shared ? new Uint8Array(new Uint8Array((body as ArrayBufferView).buffer, (body as ArrayBufferView).byteOffset, (body as ArrayBufferView).byteLength)) : streamFrom(body as AsyncIterable<unknown>);
  return copy as T;
}

/** A response body as undici takes it: an async iterable read as a stream, anything else as given. */
export function nodeResponseBody(body: unknown): unknown {
  if (!isAsyncIterableBody(body)) return body;
  refuseDisturbed(body);
  return streamFrom(body);
}
