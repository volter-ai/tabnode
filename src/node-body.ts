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
 * Only such a body is changed; every other init is handed on untouched.
 */
const encoder = new TextEncoder();

function isAsyncIterableBody(body: unknown): body is AsyncIterable<unknown> {
  if (body === null || typeof body !== 'object') return false;
  if (typeof ReadableStream === 'function' && body instanceof ReadableStream) return false;
  if (typeof Blob === 'function' && body instanceof Blob) return false;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false;
  if (typeof FormData === 'function' && body instanceof FormData) return false;
  if (body instanceof URLSearchParams) return false;
  return typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

/** undici's `ReadableStreamFrom`: one chunk a pull, bytes as they come, the iterator returned on cancel. */
function streamFrom(iterable: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<unknown> | undefined;
  return new ReadableStream<Uint8Array>({
    start() { iterator = iterable[Symbol.asyncIterator](); },
    async pull(controller) {
      const { done, value } = await iterator!.next();
      if (done) { controller.close(); return; }
      const bytes = typeof value === 'string' ? encoder.encode(value)
        : value instanceof Uint8Array ? value
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value instanceof ArrayBuffer ? new Uint8Array(value)
        : new Uint8Array(value as ArrayLike<number>);
      if (bytes.byteLength) controller.enqueue(new Uint8Array(bytes));
    },
    async cancel(reason) { await iterator?.return?.(reason); },
  }, { highWaterMark: 0 });
}

const REQUEST_INIT_MEMBERS = ['method', 'headers', 'body', 'referrer', 'referrerPolicy', 'mode', 'credentials', 'cache', 'redirect', 'integrity', 'keepalive', 'signal', 'window', 'duplex', 'priority'] as const;

/**
 * The init with an async-iterable body read as a stream, or the init itself.
 * The replacement is built member by member (an init may carry its members on
 * getters of its prototype, as a `Request` passed as an init does).
 */
export function withNodeRequestBody<T extends RequestInit | undefined>(init: T): T {
  if (!init || !isAsyncIterableBody((init as RequestInit).body)) return init;
  const copy: Record<string, unknown> = {};
  for (const member of REQUEST_INIT_MEMBERS) {
    const value = (init as Record<string, unknown>)[member];
    if (value !== undefined) copy[member] = value;
  }
  copy.body = streamFrom((init as RequestInit).body as unknown as AsyncIterable<unknown>);
  return copy as T;
}

/** A response body as undici takes it: an async iterable read as a stream, anything else as given. */
export function nodeResponseBody(body: unknown): unknown {
  return isAsyncIterableBody(body) ? streamFrom(body) : body;
}
