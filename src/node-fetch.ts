/**
 * A guest's global `fetch`, as Node's is: undici's contract over Node's own HTTP client, so every connection a fetch
 * makes is a socket of the calling process's kernel, routed and egressed by the network its process is in
 * (ADR-0009), never by the page the engine runs in.
 *
 * What it keeps of undici's fetch (Node v24.21.0's `lib/internal/deps/undici`), read as its spec:
 * - the request headers undici adds where the request has none: `accept: *\/*`, `accept-language: *`,
 *   `sec-fetch-mode: cors`, `user-agent: node`, and `accept-encoding` (`br, gzip, deflate` over https, `gzip,
 *   deflate` otherwise);
 * - redirects as `redirect` says: followed (at most 20), a 303, or a 301 or 302 of a POST, as a GET without its body
 *   and its body's headers, the credentials dropped on a change of origin; `manual` answers the redirect; `error`
 *   fails it;
 * - a body that is not a stream is sent again on a 307 or 308; a stream is not, and that redirect fails;
 * - the response body decoded by its `content-encoding` (gzip, deflate, br), none for a HEAD, a CONNECT, a
 *   status with no body or a redirect being followed;
 * - an abort as the signal's reason; every other failure `TypeError: fetch failed`, with the cause.
 * A `data:` or `blob:` URL, which no socket carries, is the realm's own `fetch`'s; every other scheme fails.
 */
import { withNodeRequestBody } from './node-body';
import type { Process } from './shims/process';
import { __tokenForProcess, enterRun } from './process-tokens';
import { loadNodeLibFor } from './node-lib/load';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const MAX_REDIRECTS = 20;
/** The headers a request body brings, which a redirect that drops the body drops with it (fetch's "request-body-header name"). */
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'];
/** The headers fetch drops when a redirect changes the origin. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'host'];

type NodeStream = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(error?: unknown): unknown;
  pipe<T>(destination: T): T;
};
type IncomingMessage = NodeStream & { statusCode: number; statusMessage: string; rawHeaders: string[] };
type ClientRequest = NodeStream & { write(chunk: Uint8Array): boolean; end(chunk?: Uint8Array): unknown };

const fetchFailed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause });

/** Whether a body given at the call is one fetch keeps the source of (anything but a stream), so a redirect can send it again. */
function replayable(input: unknown, init: RequestInit | undefined): boolean {
  const body = init?.body ?? (input instanceof Request ? input.body : null);
  if (body === null || body === undefined) return true;
  if (init?.body !== undefined && init.body !== null) return !(init.body instanceof ReadableStream);
  return false;
}

/** A Node readable as a web stream, read as it is pulled. */
function webStream(source: NodeStream, onCancel: (reason: unknown) => void): ReadableStream<Uint8Array> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(given) {
      controller = given;
      source.on('data', (chunk: Uint8Array) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
        if ((controller.desiredSize ?? 0) <= 0) source.pause();
      });
      source.once('end', () => { if (!done) { done = true; controller.close(); } });
      source.once('error', (error: unknown) => { if (!done) { done = true; controller.error(fetchFailed(error)); } });
    },
    pull() { source.resume(); },
    cancel(reason) { done = true; onCancel(reason); },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
}

/** The decoders `content-encoding` names, outermost last, as undici applies them; none for a coding it does not know. */
function decoders(process: object, encoding: string | null): NodeStream[] {
  if (!encoding) return [];
  const zlib = loadNodeLibFor(process, 'zlib') as Record<string, (options?: object) => NodeStream> & { constants: Record<string, number> };
  const flush = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const out: NodeStream[] = [];
  for (const coding of encoding.toLowerCase().split(',').map(part => part.trim()).filter(Boolean).reverse()) {
    if (coding === 'gzip' || coding === 'x-gzip') out.push(zlib.createGunzip!(flush));
    else if (coding === 'deflate') out.push(zlib.createInflate!(flush));
    else if (coding === 'br') out.push(zlib.createBrotliDecompress!({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }));
    else return [];
  }
  return out;
}

interface Exchange { response: IncomingMessage; request: ClientRequest }

/** One request and its response's head, over the process's own `http` or `https`. */
function exchange(process: object, url: URL, method: string, headers: Headers, body: Uint8Array | ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Exchange> {
  const module = loadNodeLibFor(process, url.protocol === 'https:' ? 'https' : 'http') as { request(options: object): ClientRequest };
  const outgoing: Record<string, string> = {};
  headers.forEach((value, name) => { outgoing[name] = value; });
  return new Promise<Exchange>((resolve, reject) => {
    let request: ClientRequest;
    try {
      request = module.request({
        protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/gu, ''), port: url.port || undefined,
        path: `${url.pathname}${url.search}`, method, headers: outgoing,
      });
    } catch (cause) { reject(fetchFailed(cause)); return; }
    const abort = (): void => { request.destroy(signal.reason); reject(signal.reason); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    request.once('response', (response: IncomingMessage) => {
      signal.removeEventListener('abort', abort);
      resolve({ response, request });
    });
    request.once('error', (cause: unknown) => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : fetchFailed(cause)); });
    if (body === null) { request.end(); return; }
    if (body instanceof Uint8Array) { request.end(body); return; }
    const reader = body.getReader();
    void (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (!request.write(next.value)) await new Promise(resolve => request.once('drain', resolve));
        }
        request.end();
      } catch (cause) { request.destroy(cause); }
    })();
  });
}

/** fetch over Node's HTTP client, following redirects as `request.redirect` says. */
async function fetchOver(process: object, request: Request, replay: boolean, local: typeof globalThis.fetch | undefined): Promise<Response> {
  const signal = request.signal;
  let url = new URL(request.url);
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    if (local) return local.call(globalThis, request);
    throw fetchFailed(new Error('not implemented... yet...'));
  }
  let method = request.method;
  const headers = new Headers(request.headers);
  if (!headers.has('accept')) headers.set('accept', '*/*');
  if (!headers.has('accept-language')) headers.set('accept-language', '*');
  if (!headers.has('sec-fetch-mode')) headers.set('sec-fetch-mode', 'cors');
  if (!headers.has('user-agent')) headers.set('user-agent', 'node');
  let body: Uint8Array | ReadableStream<Uint8Array> | null = request.body === null ? null
    : replay ? new Uint8Array(await request.arrayBuffer()) : request.body;
  for (let redirects = 0; ; redirects += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fetchFailed(new TypeError('URL scheme must be a HTTP(S) scheme'));
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', url.protocol === 'https:' ? 'br, gzip, deflate' : 'gzip, deflate');
    const { response } = await exchange(process, url, method, headers, body, signal);
    const status = response.statusCode;
    const responseHeaders = new Headers();
    for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
    const location = responseHeaders.get('location');
    const follow = REDIRECT_STATUSES.has(status) && location !== null && request.redirect === 'follow';
    if (REDIRECT_STATUSES.has(status) && location !== null && request.redirect === 'error') {
      response.destroy();
      throw fetchFailed(new Error('unexpected redirect'));
    }
    if (follow) {
      response.resume();
      if (redirects >= MAX_REDIRECTS) throw fetchFailed(new Error('redirect count exceeded'));
      let next: URL;
      try { next = new URL(location!, url); } catch (cause) { throw fetchFailed(cause); }
      if (status !== 303 && body !== null && !(body instanceof Uint8Array)) throw fetchFailed(new Error('Cannot follow a redirect with a streamed request body'));
      if (status === 303 ? method !== 'GET' && method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
        method = 'GET';
        body = null;
        for (const name of BODY_HEADERS) headers.delete(name);
      }
      if (next.origin !== url.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      url = next;
      continue;
    }
    const nullBody = NULL_BODY_STATUSES.has(status) || method === 'HEAD' || method === 'CONNECT';
    let stream: ReadableStream<Uint8Array> | null = null;
    if (nullBody) response.resume();
    else {
      let source: NodeStream = response;
      for (const decoder of decoders(process, responseHeaders.get('content-encoding'))) {
        source.once('error', (error: unknown) => decoder.destroy(error));
        source = source.pipe(decoder);
      }
      stream = webStream(source, reason => response.destroy(reason instanceof Error ? reason : undefined));
      const aborted = (): void => { response.destroy(signal.reason); };
      if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
    }
    const answer = new Response(stream, { status, statusText: response.statusMessage ?? '', headers: responseHeaders });
    Object.defineProperty(answer, 'url', { value: url.href, enumerable: true, configurable: true });
    Object.defineProperty(answer, 'redirected', { value: redirects > 0, enumerable: true, configurable: true });
    return answer;
  }
}

/** The guest's `fetch` for `process`; `local` is the realm's own, for the URLs no socket carries. */
export function guestFetch(process: Process, local: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  return function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // A stream body is read as undici reads it; a body undici refuses rejects the fetch, as Node's does.
    try { init = withNodeRequestBody(init); } catch (error) { return Promise.reject(error); }
    let request: Request;
    try { request = new Request(input as RequestInfo, init); } catch (error) { return Promise.reject(error); }
    const replay = replayable(input, init);
    const owner = __tokenForProcess(process);
    const run = (): Promise<Response> => fetchOver(process, request, replay, local);
    return owner === null ? run() : enterRun(owner, run);
  };
}
