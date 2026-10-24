/**
 * The page's requests, as bytes on a socket.
 *
 * The page bridge used to reach a guest's server by calling a method on the
 * engine's own `http.Server` object. `http` is Node's own file now and its
 * `Server` has no such method -- it has a socket, and a request is what
 * arrives on one. So the bridge is a client here: it finds the port in the
 * net binding's listening registry, connects to it through the same loopback
 * pairing any guest client uses, writes the request, and reads the answer
 * back through the RESPONSE side of `./binding/http_parser.ts`.
 *
 * What this buys beyond correctness: the guest's server sees a real
 * connection. Its `req.socket` is a socket, `server.on('connection')` fires,
 * keep-alive, `Transfer-Encoding: chunked`, `Expect: 100-continue` and an
 * `upgrade` are the server's own code path rather than something the bridge
 * has to imitate -- and an upgraded connection is a socket the page can be
 * handed, which is what lets the real `ws` run on it.
 */
import { netModule } from './net-module';
import type { Socket } from './net-module';
import { Buffer } from './buffer-module';
import { HTTPParser } from './binding/http_parser';
import { listenerOnPort } from './binding/tcp_wrap';

/** What a page request answers with, the shape the bridge has always answered. */
export interface ResponseData {
  statusCode: number;
  /** Absent where the server sent none, as Node's `res.statusMessage` may be. */
  statusMessage?: string;
  /** A header's value is a string, or the strings of a header sent more than once, as Node's `res.getHeaders()` answers. */
  headers: Record<string, string | string[]>;
  /** Bytes, as a host's own server answers them; Node's Buffer is a Uint8Array. Absent where there is no body. */
  body?: Uint8Array;
}

/** Whether any guest is listening on this port right now. */
export function __listening(port: number): boolean {
  return listenerOnPort(port) !== undefined;
}

/** The request head a server reads, from the parts the page gave. */
function requestHead(method: string, url: string, headers: Record<string, string>, body?: Buffer): string {
  const lines = [`${method.toUpperCase()} ${url} HTTP/1.1`];
  let hasLength = false;
  let hasEncoding = false;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'content-length') hasLength = true;
    if (lower === 'transfer-encoding') hasEncoding = true;
    if (lower === 'connection') continue;
    lines.push(`${name}: ${value}`);
  }
  // A body needs a length or the server waits for one that never ends; a
  // request without a body says zero, which is what a browser sends.
  if (!hasLength && !hasEncoding) lines.push(`Content-Length: ${body ? body.length : 0}`);
  lines.push('Connection: close', '', '');
  return lines.join('\r\n');
}

/** What the RESPONSE parser collected while the answer arrived. */
interface Collected {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  chunks: Uint8Array[];
  complete: boolean;
  upgrade: boolean;
}

/**
 * A response parser wired to collect. Node's own `_http_client.js` does this
 * with the same binding; the bridge needs the parts rather than an
 * `IncomingMessage`, so it reads them off the parser directly.
 */
function responseParser(collected: Collected, onHead?: () => void, onChunk?: (chunk: Uint8Array) => void): HTTPParser {
  const parser = new HTTPParser();
  parser.initialize(HTTPParser.RESPONSE, null, 0, 0);
  parser[HTTPParser.kOnHeadersComplete] = ((
    _major: number, _minor: number, headers: string[], _method: unknown, _url: unknown,
    statusCode: number, statusMessage: string, upgrade: boolean,
  ) => {
    if (collected.complete) return 0;
    collected.statusCode = statusCode;
    collected.statusMessage = statusMessage;
    collected.upgrade = upgrade;
    for (let index = 0; index + 1 < headers.length; index += 2) {
      const name = headers[index]!.toLowerCase();
      const value = headers[index + 1]!;
      // A header sent twice is joined the way a client reads it.
      collected.headers[name] = collected.headers[name] === undefined
        ? value
        : `${collected.headers[name]}, ${value}`;
    }
    onHead?.();
    return 0;
  }) as never;
  parser[HTTPParser.kOnBody] = ((chunk: Uint8Array) => {
    if (collected.complete) return;
    if (onChunk) onChunk(chunk);
    else collected.chunks.push(chunk);
  }) as never;
  parser[HTTPParser.kOnMessageComplete] = (() => {
    if (collected.complete) return collected.upgrade ? 0 : -1;
    collected.complete = true;
    // Stop at Content-Length or the chunked terminator: later bytes on this
    // socket are another message, and must not join this body. pause()
    // alone does not stop the rest of this execute(); a non-zero return
    // does (measured: a 200 followed by a 400 in one write became status 400).
    // An upgrade must not stop that way: execute() has to answer the pause
    // so the leftover bytes can be pushed back onto the socket.
    if (collected.upgrade) return 0;
    parser.pause();
    return -1;
  }) as never;
  return parser;
}

function emptyCollected(): Collected {
  return { statusCode: 0, statusMessage: '', headers: {}, chunks: [], complete: false, upgrade: false };
}

/**
 * The bytes these views name, in a buffer of their own. Node's
 * `Buffer.concat` of a short body is a window on the 8 KB pool, and the
 * page's Fetch Response is built from `body.slice().buffer` — the whole
 * backing store, neighbours included.
 */
function ownedConcat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), at);
    at += chunk.byteLength;
  }
  return joined;
}

function serviceUnavailable(port: number): ResponseData {
  return {
    statusCode: 503,
    statusMessage: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain' },
    body: ownedConcat([Buffer.from(`No server listening on port ${port}`)]),
  };
}

/**
 * A request to a guest's server, answered whole. The connection is this
 * engine's own loopback: the guest's server accepts it, and nothing leaves
 * the tab.
 */
export function __requestOverLoopback(
  port: number, method: string, url: string, headers: Record<string, string>, body?: Buffer,
): Promise<ResponseData> {
  if (!__listening(port)) return Promise.resolve(serviceUnavailable(port));
  return new Promise<ResponseData>((resolve) => {
    const collected = emptyCollected();
    const parser = responseParser(collected);
    let settled = false;
    const answer = (): void => {
      if (settled) return;
      settled = true;
      parser.free();
      resolve({
        statusCode: collected.statusCode || 502,
        statusMessage: collected.statusMessage,
        headers: collected.headers,
        body: ownedConcat(collected.chunks),
      });
    };
    const socket = netModule.connect({ port, host: '127.0.0.1' }) as unknown as Socket;
    socket.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      const read = parser.execute(chunk);
      if (read instanceof Error) { socket.destroy(); answer(); }
      else if (collected.complete) { socket.destroy(); answer(); }
    });
    socket.on('end', () => { if (!settled) { parser.finish(); } answer(); });
    socket.on('close', answer);
    socket.on('error', () => {
      if (settled) return;
      settled = true;
      parser.free();
      resolve(serviceUnavailable(port));
    });
    socket.write(requestHead(method, url, headers, body));
    if (body && body.length > 0) socket.write(body);
  });
}

/**
 * The same request, answered as it arrives: the head first, then each chunk
 * the server writes, then the end. This is what the service worker streams
 * to the page.
 */
/**
 * How a caller paces a streamed answer: `signal` ends the connection (the
 * reader went away), and `control` is handed the connection's pause and
 * resume, so a reader that holds no credit holds the server back instead of
 * a queue growing without bound.
 */
export interface LoopbackStreamFlow {
  signal?: AbortSignal;
  control?(pause: () => void, resume: () => void): void;
}

export function __streamOverLoopback(
  port: number, method: string, url: string, headers: Record<string, string>, body: Buffer | undefined,
  onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
  onChunk: (chunk: Uint8Array) => void,
  onEnd: () => void,
  flow?: LoopbackStreamFlow,
): Promise<void> {
  if (!__listening(port)) {
    onStart(503, 'Service Unavailable', { 'Content-Type': 'text/plain' });
    onEnd();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const collected = emptyCollected();
    let started = false;
    let ended = false;
    const finish = (): void => { if (ended) return; ended = true; parser.free(); onEnd(); resolve(); };
    const parser = responseParser(
      collected,
      () => { started = true; onStart(collected.statusCode, collected.statusMessage, collected.headers); },
      (chunk) => onChunk(chunk),
    );
    const socket = netModule.connect({ port, host: '127.0.0.1' }) as unknown as Socket;
    flow?.control?.(() => socket.pause(), () => socket.resume());
    if (flow?.signal) {
      if (flow.signal.aborted) { socket.destroy(); finish(); return; }
      flow.signal.addEventListener('abort', () => { socket.destroy(); finish(); }, { once: true });
    }
    socket.on('data', (chunk: Uint8Array) => {
      if (ended) return;
      const read = parser.execute(chunk);
      if (read instanceof Error) { socket.destroy(); finish(); }
      else if (collected.complete) { socket.destroy(); finish(); }
    });
    socket.on('end', () => { if (!ended) { parser.finish(); } finish(); });
    socket.on('close', finish);
    socket.on('error', () => {
      if (!started) onStart(503, 'Service Unavailable', { 'Content-Type': 'text/plain' });
      finish();
    });
    socket.write(requestHead(method, url, headers, body));
    if (body && body.length > 0) socket.write(body);
  });
}

/** What an upgrade answered with: the 101 and the socket the page now owns. */
export interface UpgradeResult {
  statusCode: number;
  /** Absent where the server sent none, as Node's `res.statusMessage` may be. */
  statusMessage?: string;
  headers: Record<string, string>;
  socket: Socket | null;
}

/**
 * An `Upgrade` request through the same door. On a 101 the connection stops
 * being HTTP and becomes the two ends of a socket: the guest's server holds
 * one -- its `upgrade` listener was handed it by Node's own `http` -- and the
 * page holds this one, which is exactly what the real `ws` needs on both
 * sides. The bytes llhttp had already read past the head are pushed back
 * onto this end, because they are the first frame.
 */
export function __upgradeOverLoopback(
  port: number, method: string, url: string, headers: Record<string, string>,
): Promise<UpgradeResult> {
  if (!__listening(port)) {
    return Promise.resolve({ statusCode: 503, statusMessage: 'Service Unavailable', headers: {}, socket: null });
  }
  return new Promise<UpgradeResult>((resolve) => {
    const collected = emptyCollected();
    let settled = false;
    const parser = responseParser(collected);
    const socket = netModule.connect({ port, host: '127.0.0.1' }) as unknown as Socket;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      parser.free();
      resolve({ statusCode: collected.statusCode || 502, statusMessage: collected.statusMessage, headers: collected.headers, socket: null });
    };
    socket.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      const read = parser.execute(chunk);
      if (read instanceof Error) { socket.destroy(); fail(); return; }
      if (collected.upgrade || collected.statusCode === 101) {
        settled = true;
        parser.free();
        // Anything after the head is the protocol's first bytes; the reader
        // that takes this socket next must see them.
        const consumed = typeof read === 'number' ? read : chunk.length;
        const rest = chunk.subarray(consumed);
        if (rest.length > 0) (socket as unknown as { unshift(data: Uint8Array): void }).unshift(rest);
        resolve({ statusCode: collected.statusCode, statusMessage: collected.statusMessage, headers: collected.headers, socket });
        return;
      }
      if (collected.complete) { socket.destroy(); fail(); }
    });
    socket.on('error', fail);
    socket.on('close', fail);
    const upgradeHeaders = { ...headers, Connection: 'Upgrade' };
    const lines = [`${method.toUpperCase()} ${url} HTTP/1.1`];
    for (const [name, value] of Object.entries(upgradeHeaders)) {
      if (name.toLowerCase() === 'connection') continue;
      lines.push(`${name}: ${value}`);
    }
    lines.push('Connection: Upgrade', '', '');
    socket.write(lines.join('\r\n'));
  });
}
