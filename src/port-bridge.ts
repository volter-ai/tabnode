/**
 * The page's side of the virtual-port service worker (public/__sw__.js): the
 * servers a host registered, by port, and the protocol the worker speaks to
 * reach them, flow control and streaming included. It carries none of Node's
 * library, so a page whose engine runs in a worker loads no engine to serve
 * that worker's ports (browser-substrate ADR-0042). An engine's own bridge,
 * `ServerBridge`, extends it with the servers its guests listen on.
 */

import type { ResponseData, LoopbackStreamFlow } from './node-lib/http-bridge';
import { uint8ToBase64 } from './utils/binary-encoding';

const _encoder = new TextEncoder();
// The worker's flow-controlled stream: a request body up to this size, and a
// response in chunks of exactly the worker's own maximum, one per pull.
const FLOW_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const FLOW_MAX_CHUNK_BYTES = 65536;
// Chunks that may wait for the reader's credit before the server is paused.
const FLOW_QUEUED_CHUNKS = 16;

/** The bytes this view names, in a buffer of their own. A pooled Buffer is a window on 8 KB. */
export function ownedBytes(view: Uint8Array): Uint8Array {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy;
}

export type { ResponseData, LoopbackStreamFlow };

/**
 * Interface for virtual servers that can be registered with the bridge
 */
export interface IVirtualServer {
  listening: boolean;
  /** What `net.Server.address()` answers: an address and a port, or the PATH of a unix-domain socket. */
  address(): { port: number; address: string; family: string } | string | null;
  handleRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array | string
  ): Promise<ResponseData>;
}

export interface VirtualServer {
  /**
   * A server the host registered and answers itself, or null for a guest's
   * own: a guest's server is a port this engine is listening on, and it is
   * reached by connecting to it like any other client.
   */
  server: IVirtualServer | null;
  port: number;
  hostname: string;
}

export interface BridgeOptions {
  baseUrl?: string;
  onServerReady?: (port: number, url: string) => void;
}

export interface InitServiceWorkerOptions {
  /**
   * The URL path to the service worker file
   * @default '/__sw__.js'
   */
  swUrl?: string;
  /**
   * The page's own documents that are frames of it (a sandbox, a worker
   * host), by path, so the worker does not take one for the preview's.
   */
  ownDocuments?: string[];
}

type Listener = (...args: any[]) => void;

/** The events a bridge announces, `server-ready` and `sw-ready`, without Node's EventEmitter. */
class BridgeEvents {
  private readonly listenersByEvent = new Map<string | symbol, Listener[]>();

  on(event: string | symbol, listener: Listener): this {
    const list = this.listenersByEvent.get(event) ?? [];
    list.push(listener);
    this.listenersByEvent.set(event, list);
    return this;
  }

  addListener(event: string | symbol, listener: Listener): this { return this.on(event, listener); }

  once(event: string | symbol, listener: Listener): this {
    const wrapped: Listener & { listener?: Listener } = (...args) => { this.off(event, wrapped); listener(...args); };
    wrapped.listener = listener;
    return this.on(event, wrapped);
  }

  off(event: string | symbol, listener: Listener): this {
    const list = this.listenersByEvent.get(event);
    if (!list) return this;
    const at = list.findIndex((candidate) => candidate === listener || (candidate as Listener & { listener?: Listener }).listener === listener);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.listenersByEvent.delete(event);
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this { return this.off(event, listener); }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listenersByEvent.clear();
    else this.listenersByEvent.delete(event);
    return this;
  }

  listenerCount(event: string | symbol): number {
    return this.listenersByEvent.get(event)?.length ?? 0;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.listenersByEvent.get(event);
    if (!list || list.length === 0) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }
}

/**
 * Server Bridge manages virtual HTTP servers and routes requests
 */
export class PortBridge extends BridgeEvents {
  static DEBUG = false;
  servers: Map<number, VirtualServer> = new Map();
  private baseUrl: string;
  private options: BridgeOptions;
  private messageChannel: MessageChannel | null = null;
  private serviceWorkerReady: boolean = false;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: BridgeOptions = {}) {
    super();
    this.options = options;

    // Handle browser vs Node.js environment
    if (typeof location !== 'undefined') {
      this.baseUrl = options.baseUrl || `${location.protocol}//${location.host}`;
    } else {
      this.baseUrl = options.baseUrl || 'http://localhost';
    }

  }

  /**
   * Give back everything this bridge opened: the service worker keepalive,
   * and in an engine's bridge its upgrade channel. A host that is done with a
   * container calls it and has its process back; calling it twice is nothing.
   */
  close(): void {
    if (this.keepaliveInterval !== null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Register a server on a port
   */
  registerServer(server: IVirtualServer | null, port: number, hostname: string = '0.0.0.0'): void {
    this.servers.set(port, { server, port, hostname });

    // Emit server-ready event
    const url = this.getServerUrl(port);
    this.emit('server-ready', port, url);

    if (this.options.onServerReady) {
      this.options.onServerReady(port, url);
    }

    // Notify service worker if connected
    this.notifyServiceWorker('server-registered', { port, hostname, primary: port === this.primaryPort });
  }

  /**
   * Unregister a server
   */
  unregisterServer(port: number): void {
    this.servers.delete(port);
    if (this.primaryPort === port) this.primaryPort = null;
    this.notifyServiceWorker('server-unregistered', { port });
  }

  /** The server the service worker answers at the origin's root, the preview's; null for none. */
  private primaryPort: number | null = null;

  /**
   * Names the server the service worker serves at the origin's root, as an
   * app is served at its own origin's root: its documents read their routes
   * from `location.pathname`, which under /__virtual__/<port>/ is not the
   * path they expect. Told to the worker now and again whenever the worker
   * is (re)initialized, since a worker that restarted remembers nothing.
   */
  setPrimaryPort(port: number | null): void {
    const previous = this.primaryPort;
    this.primaryPort = port;
    if (previous !== null && previous !== port) {
      const entry = this.servers.get(previous);
      if (entry) this.notifyServiceWorker('server-registered', { port: previous, hostname: entry.hostname, primary: false });
    }
    if (port !== null) {
      const entry = this.servers.get(port);
      this.notifyServiceWorker('server-registered', { port, hostname: entry?.hostname ?? '0.0.0.0', primary: true });
    }
  }

  /** Every registration the worker should hold, sent again to a worker that was (re)initialized. */
  private announceServers(): void {
    if (this.ownDocuments) this.notifyServiceWorker('own-documents', { paths: this.ownDocuments });
    for (const [port, entry] of this.servers) {
      this.notifyServiceWorker('server-registered', { port, hostname: entry.hostname, primary: port === this.primaryPort });
    }
  }
  private ownDocuments: string[] | undefined;

  /**
   * Get server URL for a port
   */
  getServerUrl(port: number): string {
    return `${this.baseUrl}/__virtual__/${port}`;
  }

  /**
   * Get all registered server ports
   */
  getServerPorts(): number[] {
    return [...this.servers.keys()];
  }

  /**
   * Handle an incoming request from Service Worker
   */
  async handleRequest(
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer
  ): Promise<ResponseData> {
    const virtualServer = this.servers.get(port);

    if (!virtualServer) {
      return {
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain' },
        body: _encoder.encode(`No server listening on port ${port}`),
      };
    }

    try {
      const bodyBuffer = body ? this.bodyOf(new Uint8Array(body)) : undefined;
      // Every request a server sees carries a Host. HTTP/1.1 requires one and
      // Node's own parser answers 400 without it, so a server is written as
      // though it is always there: Next's middleware reads
      // `req.headers.get('host')` on its first line and Dub's died on null.
      // A browser's `fetch` may not send the header and a service worker may
      // not add it, so the request that arrives here often has none; the
      // server is listening on a port, and that is the authority it is
      // reachable at.
      const named = Object.keys(headers).some((name) => name.toLowerCase() === 'host');
      const authority = `${virtualServer.hostname && virtualServer.hostname !== '0.0.0.0' && virtualServer.hostname !== '::' ? virtualServer.hostname : '127.0.0.1'}:${port}`;
      const withHost = named ? headers : { ...headers, host: authority };
      // A server the host registered answers for itself; a guest's server is
      // a port this engine is listening on, and the request goes to it as
      // bytes on a connection, which is what a server reads.
      if (virtualServer.server) return await virtualServer.server.handleRequest(method, url, withHost, bodyBuffer);
      return await this.requestGuest(port, method, url, withHost, bodyBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      return {
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        headers: { 'Content-Type': 'text/plain' },
        body: _encoder.encode(message),
      };
    }
  }

  /**
   * Initialize Service Worker communication
   * @param options - Configuration options for the service worker
   * @param options.swUrl - Custom URL path to the service worker file (default: '/__sw__.js')
   */
  async initServiceWorker(options?: InitServiceWorkerOptions): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Workers not supported');
    }

    const swUrl = options?.swUrl ?? '/__sw__.js';

    // Set up controllerchange listener BEFORE registration so we don't miss the event.
    // clients.claim() in the SW's activate handler fires controllerchange, and it can
    // happen before our activation wait completes.
    const controllerReady = navigator.serviceWorker.controller
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        });

    // Register service worker
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: '/',
    });

    // Wait for service worker to be active
    const sw = registration.active || registration.waiting || registration.installing;

    if (!sw) {
      throw new Error('Service Worker registration failed');
    }

    await new Promise<void>((resolve) => {
      if (sw.state === 'activated') {
        resolve();
      } else {
        const handler = () => {
          if (sw.state === 'activated') {
            sw.removeEventListener('statechange', handler);
            resolve();
          }
        };
        sw.addEventListener('statechange', handler);
      }
    });

    // Set up message channel for communication
    this.messageChannel = new MessageChannel();
    this.messageChannel.port1.onmessage = this.handleServiceWorkerMessage.bind(this);

    this.ownDocuments = options?.ownDocuments;
    // Send port to service worker
    sw.postMessage({ type: 'init', port: this.messageChannel.port2, data: { ownDocuments: this.ownDocuments ?? [] } }, [
      this.messageChannel.port2,
    ]);

    // Wait for SW to actually control this page (clients.claim() in SW activate handler)
    // Without this, fetch requests bypass the SW and go directly to the server
    await controllerReady;

    // Re-establish communication when the SW loses its port (idle termination)
    // or when the SW is replaced (new deployment). The SW sends 'sw-needs-init'
    // to all clients when a request arrives but mainPort is null.
    const reinit = () => {
      if (navigator.serviceWorker.controller) {
        for (const stream of [...this.controlledStreams.values()]) stream.cancel();
        this.messageChannel = new MessageChannel();
        this.messageChannel.port1.onmessage = this.handleServiceWorkerMessage.bind(this);
        navigator.serviceWorker.controller.postMessage(
          { type: 'init', port: this.messageChannel.port2, data: { ownDocuments: this.ownDocuments ?? [] } },
          [this.messageChannel.port2]
        );
        this.announceServers();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', reinit);
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'sw-needs-init') {
        reinit();
      }
    });

    // Keep the SW alive with periodic pings. Browsers terminate idle SWs
    // after ~30s, losing the MessageChannel port and all in-memory state.
    this.keepaliveInterval = setInterval(() => {
      this.messageChannel?.port1.postMessage({ type: 'keepalive' });
    }, 20_000);

    this.serviceWorkerReady = true;
    this.announceServers();
    this.emit('sw-ready');
  }

  /**
   * Handle messages from Service Worker
   */
  private async handleServiceWorkerMessage(event: MessageEvent): Promise<void> {
    const { type, id, data } = event.data;

    PortBridge.DEBUG && console.log('[ServerBridge] SW message:', type, id, data?.url);

    if (type === 'stream-pull' || type === 'stream-cancel') {
      const stream = this.controlledStreams.get(id);
      if (type === 'stream-pull') stream?.pull(); else stream?.cancel();
      return;
    }
    if (type === 'request' && data?.flowControl === 1) {
      const { port, method, url, headers, body } = data;
      await this.controlledStream(id, port, method, url, headers, body, data.binaryChunks === 1);
      return;
    }
    if (type === 'request') {
      const { port, method, url, headers, body, streaming } = data;

      PortBridge.DEBUG && console.log('[ServerBridge] Handling request:', port, method, url, 'streaming:', streaming);
      if (streaming) {
        PortBridge.DEBUG && console.log('[ServerBridge] 🔴 Will use streaming handler');
      }

      try {
        if (streaming) {
          // Handle streaming request
          await this.streamToServiceWorker(id, port, method, url, headers, body);
        } else {
          // Handle regular request
          const response = await this.handleRequest(port, method, url, headers, body);
          PortBridge.DEBUG && console.log('[ServerBridge] Response:', response.statusCode, 'body length:', response.body?.length);

          // Convert body to base64 string to avoid structured cloning issues with Uint8Array
          let bodyBase64 = '';
          if (response.body && response.body.length > 0) {
            const bytes = response.body instanceof Uint8Array ? response.body : new Uint8Array(0);
            bodyBase64 = uint8ToBase64(bytes);
          }

          PortBridge.DEBUG && console.log('[ServerBridge] Sending response to SW, body base64 length:', bodyBase64.length);

          this.messageChannel?.port1.postMessage({
            type: 'response',
            id,
            data: {
              statusCode: response.statusCode,
              statusMessage: response.statusMessage,
              headers: response.headers,
              bodyBase64: bodyBase64,
            },
          });
        }
      } catch (error) {
        this.messageChannel?.port1.postMessage({
          type: 'response',
          id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Handle a streaming request - sends chunks as they arrive
   */
  /**
   * A page-side request streamed to the caller as it arrives, the door a host
   * reads a guest's server through when it wants chunks rather than a body:
   * a guest's own server is reached over the loopback as any client reaches
   * it; a server the host registered answers through its own streaming
   * method where it has one, else its buffered answer is delivered whole.
   */
  async handleStreamingRequest(
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body: ArrayBuffer | undefined,
    callbacks: {
      start(statusCode: number, statusMessage: string, headers: Record<string, string>): void;
      chunk(chunk: Uint8Array): void;
      end(): void;
    },
    flow?: LoopbackStreamFlow,
  ): Promise<boolean> {
    const virtualServer = this.servers.get(port);
    if (!virtualServer) return false;
    const bodyBuffer = body ? this.bodyOf(new Uint8Array(body)) : undefined;
    // A guest's listener (the old null sentinel, now a request adapter) is
    // streamed off its connection; its adapter would answer whole.
    if (this.isGuest(virtualServer)) {
      const named = Object.keys(headers).some((name) => name.toLowerCase() === 'host');
      const authority = `${virtualServer.hostname && virtualServer.hostname !== '0.0.0.0' && virtualServer.hostname !== '::' ? virtualServer.hostname : '127.0.0.1'}:${port}`;
      await this.streamGuest(
        port, method, url, named ? headers : { ...headers, host: authority }, bodyBuffer,
        (statusCode, statusMessage, respHeaders) => callbacks.start(statusCode, statusMessage, respHeaders),
        (chunk) => callbacks.chunk(ownedBytes(chunk)),
        () => callbacks.end(),
        flow,
      );
      return true;
    }
    const server = virtualServer.server as IVirtualServer & {
      handleStreamingRequest?: (
        method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined,
        onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
        onChunk: (chunk: string | Uint8Array) => void,
        onEnd: () => void,
        flow?: LoopbackStreamFlow,
      ) => Promise<void>;
    };
    if (typeof server.handleStreamingRequest === 'function') {
      // a registered server that streams is paced the same way: it is handed
      // the reader's going away and the pause and resume of its own producer
      await server.handleStreamingRequest(
        method, url, headers, bodyBuffer,
        (statusCode, statusMessage, respHeaders) => callbacks.start(statusCode, statusMessage, respHeaders),
        (chunk) => callbacks.chunk(typeof chunk === 'string' ? _encoder.encode(chunk) : ownedBytes(chunk)),
        () => callbacks.end(),
        flow,
      );
      return true;
    }
    const response = await this.handleRequest(port, method, url, headers, body);
    callbacks.start(response.statusCode, response.statusMessage ?? '', response.headers as Record<string, string>);
    if (response.body) {
      const body = typeof response.body === 'string' ? _encoder.encode(response.body) : response.body;
      callbacks.chunk(ownedBytes(body));
    }
    callbacks.end();
    return true;
  }

  private async streamToServiceWorker(
    id: number,
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer
  ): Promise<void> {
    const virtualServer = this.servers.get(port);

    if (!virtualServer) {
      this.messageChannel?.port1.postMessage({
        type: 'stream-start',
        id,
        data: { statusCode: 503, statusMessage: 'Service Unavailable', headers: {} },
      });
      this.messageChannel?.port1.postMessage({ type: 'stream-end', id });
      return;
    }

    // A guest's server is a port: its answer is streamed off the connection
    // as it arrives, which is what the page reads chunk by chunk.
    if (this.isGuest(virtualServer)) {
      const bodyBuffer = body ? this.bodyOf(new Uint8Array(body)) : undefined;
      const named = Object.keys(headers).some((name) => name.toLowerCase() === 'host');
      const authority = `${virtualServer.hostname && virtualServer.hostname !== '0.0.0.0' && virtualServer.hostname !== '::' ? virtualServer.hostname : '127.0.0.1'}:${port}`;
      await this.streamGuest(
        port, method, url, named ? headers : { ...headers, host: authority }, bodyBuffer,
        (statusCode, statusMessage, respHeaders) => {
          this.messageChannel?.port1.postMessage({ type: 'stream-start', id, data: { statusCode, statusMessage, headers: respHeaders } });
        },
        (chunk) => {
          // A pooled Buffer's `.slice()` is a window on the same 8 KB; the
          // transfer of `copy.buffer` would move the pool. These are the
          // bytes the view names, in a buffer of their own.
          const copy = ownedBytes(chunk);
          this.messageChannel?.port1.postMessage({ type: 'stream-chunk', id, data: copy.buffer }, [copy.buffer]);
        },
        () => { this.messageChannel?.port1.postMessage({ type: 'stream-end', id }); },
      );
      return;
    }

    // Check if the server supports streaming (has handleStreamingRequest method)
    const server = virtualServer.server as any;
    if (!server) return;
    if (typeof server.handleStreamingRequest === 'function') {
      PortBridge.DEBUG && console.log('[ServerBridge] 🟢 Server has streaming support, calling handleStreamingRequest');
      // Use streaming handler
      const bodyBuffer = body ? this.bodyOf(new Uint8Array(body)) : undefined;

      await server.handleStreamingRequest(
        method,
        url,
        headers,
        bodyBuffer,
        // onStart - called with headers
        (statusCode: number, statusMessage: string, respHeaders: Record<string, string>) => {
          PortBridge.DEBUG && console.log('[ServerBridge] 🟢 onStart called, sending stream-start');
          this.messageChannel?.port1.postMessage({
            type: 'stream-start',
            id,
            data: { statusCode, statusMessage, headers: respHeaders },
          });
        },
        // onChunk - called for each chunk
        (chunk: string | Uint8Array) => {
          const bytes = typeof chunk === 'string' ? _encoder.encode(chunk) : chunk;
          const chunkBase64 = uint8ToBase64(bytes);
          PortBridge.DEBUG && console.log('[ServerBridge] 🟡 onChunk called, sending stream-chunk, size:', chunkBase64.length);
          this.messageChannel?.port1.postMessage({
            type: 'stream-chunk',
            id,
            data: { chunkBase64 },
          });
        },
        // onEnd - called when response is complete
        () => {
          PortBridge.DEBUG && console.log('[ServerBridge] 🟢 onEnd called, sending stream-end');
          this.messageChannel?.port1.postMessage({ type: 'stream-end', id });
        }
      );
    } else {
      // Fall back to regular request handling
      const bodyBuffer = body ? this.bodyOf(new Uint8Array(body)) : undefined;
      const response = await server.handleRequest(method, url, headers, bodyBuffer);

      // Send as a single stream
      this.messageChannel?.port1.postMessage({
        type: 'stream-start',
        id,
        data: {
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
        },
      });

      if (response.body && response.body.length > 0) {
        const bytes = response.body instanceof Uint8Array ? response.body : new Uint8Array(0);
        this.messageChannel?.port1.postMessage({
          type: 'stream-chunk',
          id,
          data: { chunkBase64: uint8ToBase64(bytes) },
        });
      }

      this.messageChannel?.port1.postMessage({ type: 'stream-end', id });
    }
  }

  /**
   * Send message to Service Worker
   */
  private notifyServiceWorker(type: string, data: unknown): void {
    if (this.serviceWorkerReady && this.messageChannel) {
      // Every port this bridge answers speaks the worker's flow-controlled
      // stream: a response is paced by the reader's pulls, one chunk a pull,
      // and a reader that goes away ends the request (virtual HTTP flow
      // control, the worker's side of which is in public/__sw__.js).
      const flow = type === 'server-registered'
        ? { flowControl: 1, maxRequestBytes: FLOW_MAX_REQUEST_BYTES, maxChunkBytes: FLOW_MAX_CHUNK_BYTES } : {};
      this.messageChannel.port1.postMessage({ type, data: { ...(data as object), ...flow } });
    }
  }

  /** Flow-controlled requests in flight: a pull is one chunk's credit, a cancel ends the upstream. */
  private readonly controlledStreams = new Map<number, { pull(): void; cancel(): void }>();

  /**
   * A request the worker sent under flow control: the response starts with
   * its head, then goes one chunk (at most FLOW_MAX_CHUNK_BYTES) for each
   * `stream-pull`, and ends with `stream-end` once the server finished and
   * every chunk went out. The upstream connection is paused while chunks wait
   * for credit, so a slow reader holds the server back; `stream-cancel` ends it.
   */
  private async controlledStream(id: number, port: number, method: string, url: string, headers: Record<string, string>, body?: ArrayBuffer, binaryChunks = false): Promise<void> {
    // the stream belongs to the channel it arrived on; a new channel's worker failed it already
    const channel = this.messageChannel;
    const post = (type: string, data?: unknown, transfer: Transferable[] = []): void => { channel?.port1.postMessage({ type, id, ...(data === undefined ? {} : { data }) }, transfer); };
    // A worker that reads bytes is sent a copy of each chunk, transferred:
    // base64 of every response body was 373 ms of the page's main thread
    // opening the model editor (2026-09-26). The copy is the chunk's own,
    // never a view of a buffer the server or a pool still holds.
    const postChunk = (bytes: Uint8Array): void => {
      if (!binaryChunks) { post('stream-chunk', { chunkBase64: uint8ToBase64(bytes) }); return; }
      const copy = Uint8Array.prototype.slice.call(bytes) as Uint8Array;
      post('stream-chunk', { chunk: copy.buffer }, [copy.buffer]);
    };
    const queue: Uint8Array[] = [];
    const abort = new AbortController();
    let credits = 0;
    let upstreamEnded = false;
    let finished = false;
    let paused = false;
    let pause = (): void => undefined;
    let resume = (): void => undefined;
    const finish = (): void => { finished = true; this.controlledStreams.delete(id); };
    const flush = (): void => {
      if (finished) return;
      while (credits > 0 && queue.length > 0) {
        credits -= 1;
        postChunk(queue.shift()!);
      }
      if (upstreamEnded && queue.length === 0) { post('stream-end'); finish(); return; }
      // a few chunks may wait for credit; more than that, and the server waits
      if (queue.length >= FLOW_QUEUED_CHUNKS && !paused) { paused = true; pause(); }
      else if (queue.length < FLOW_QUEUED_CHUNKS && paused) { paused = false; resume(); }
    };
    this.controlledStreams.set(id, {
      pull: () => { credits += 1; flush(); },
      cancel: () => { if (finished) return; finish(); queue.length = 0; abort.abort(); },
    });
    try {
      const answered = await this.handleStreamingRequest(port, method, url, headers, body, {
        start: (statusCode, statusMessage, respHeaders) => post('stream-start', { statusCode, statusMessage, headers: respHeaders }),
        chunk: (chunk) => {
          if (finished) return;
          for (let at = 0; at < chunk.byteLength; at += FLOW_MAX_CHUNK_BYTES) queue.push(chunk.slice(at, at + FLOW_MAX_CHUNK_BYTES));
          flush();
        },
        end: () => { upstreamEnded = true; flush(); },
      }, { signal: abort.signal, control: (p, r) => { pause = p; resume = r; } });
      if (!answered) {
        post('stream-start', { statusCode: 503, statusMessage: 'Service Unavailable', headers: {} });
        post('stream-end');
        finish();
      }
    } catch (error) {
      if (!finished) { post('stream-error', { message: error instanceof Error ? error.message : String(error) }); finish(); }
    }
  }

  /**
   * Create a mock request handler for testing without Service Worker
   */
  createFetchHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      // Check if this is a virtual server request
      const match = url.pathname.match(/^\/__virtual__\/(\d+)(\/.*)?$/);
      if (!match) {
        throw new Error('Not a virtual server request');
      }

      const port = parseInt(match[1], 10);
      const path = match[2] || '/';

      // Build headers object
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Get body if present
      let body: ArrayBuffer | undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = await request.arrayBuffer();
      }

      // Handle request
      const response = await this.handleRequest(
        port,
        request.method,
        path + url.search,
        headers,
        body
      );

      // Convert to fetch Response
      // A header sent more than once, `set-cookie` above all, is appended as
      // many times; a fetch Response takes each value on its own.
      const answerHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const each of Array.isArray(value) ? value : [value]) answerHeaders.append(name, each);
      }
      return new Response(response.body as unknown as BodyInit, {
        status: response.statusCode,
        statusText: response.statusMessage ?? '',
        headers: answerHeaders,
      });
    };
  }

  // ---------------------------------------------------------------- an engine's own servers

  /**
   * Whether a registration is a guest's own listener, answered over the
   * engine's loopback rather than by a server object the host registered. A
   * bridge with no engine in its realm has none: every server it holds was
   * registered by the host, a worker's proxies among them.
   */
  protected isGuest(entry: VirtualServer): boolean {
    return entry.server === null;
  }

  /** A request to a guest's listener, over the engine's loopback. */
  protected requestGuest(port: number, _method: string, _url: string, _headers: Record<string, string>, _body: Uint8Array | undefined): Promise<ResponseData> {
    return Promise.reject(new Error(`Port ${port} has no server in this realm.`));
  }

  /** A guest's answer streamed off its connection as it arrives. */
  protected streamGuest(
    port: number, _method: string, _url: string, _headers: Record<string, string>, _body: Uint8Array | undefined,
    _onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void,
    _onChunk: (chunk: Uint8Array) => void,
    _onEnd: () => void,
    _flow?: LoopbackStreamFlow,
  ): Promise<void> {
    return Promise.reject(new Error(`Port ${port} has no server in this realm.`));
  }

  /** A request's body as the servers of this realm read it. */
  protected bodyOf(bytes: Uint8Array): Uint8Array {
    return bytes;
  }
}

// The page's bridge: one per realm, as the service worker keeps one channel per page.
let globalPortBridge: PortBridge | null = null;

/** Get or create this realm's port bridge, for a page whose engine, if any, runs elsewhere. */
export function getPortBridge(options?: BridgeOptions): PortBridge {
  if (!globalPortBridge) globalPortBridge = new PortBridge(options);
  return globalPortBridge;
}
