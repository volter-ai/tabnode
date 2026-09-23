/**
 * Node's Agent connection seam over a host HTTP exchange. Both sides of the
 * internal connection use Node's unmodified HTTP library: it parses requests,
 * generates responses and owns ClientRequest/IncomingMessage and backpressure.
 * No TLS socket or network metadata is fabricated. The host admits the target
 * and capabilities before sending, and returns one response without retries.
 */
import { httpModule, httpsModule } from './node-lib/http-module';
import { netModule } from './node-lib/net-module';
import { streamModule } from './node-lib/stream-module';
import { onNodeLibLoaded, type NodeLibRequire } from './node-lib/load';
import { DuplexStreamHandle } from './node-lib/binding/duplex_stream';

export interface HttpClientExchangeRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body?: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  profile: 'server-http';
}
export interface HttpClientExchangeResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: ReadableStream<Uint8Array> | null;
}
export type HttpClientExchange = (request: HttpClientExchangeRequest) => Promise<HttpClientExchangeResponse>;
/** Capture process attribution synchronously when the connection is requested. */
export type HttpClientTransportFactory = () => HttpClientExchange;

const unsupported = (detail: string): Error => Object.assign(new Error(`HTTP transport does not support ${detail}.`), { code: 'ERR_HTTP_TRANSPORT_UNSUPPORTED' });
const local = (host: string): boolean => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./u.test(host);
const tlsOptions = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'ciphers', 'secureContext', 'checkServerIdentity', 'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'session', 'ALPNProtocols', 'pskCallback'];

export interface HttpClientTransportOptions {
  /**
   * Loopback ports the host itself serves (a service of the page, not a
   * guest's listener). Plain HTTP to one of them goes through the host
   * exchange; every other loopback port stays the engine's own network.
   */
  hostPorts?: () => ReadonlySet<number>;
}

/** Host-only installation; guest modules receive Node's normal exports. */
export function installHttpClientTransport(factory: HttpClientTransportFactory, transportOptions: HttpClientTransportOptions = {}): () => void {
  type AgentPrototype = { createConnection: (...args: any[]) => any };
  const installed = new WeakMap<AgentPrototype, { original: AgentPrototype['createConnection']; connect: AgentPrototype['createConnection'] }>();
  const live = new Set<WeakRef<AgentPrototype>>();
  const collected = new FinalizationRegistry<WeakRef<AgentPrototype>>(ref => live.delete(ref));
  const install = (Agent: { prototype: AgentPrototype }, protocol: string, require?: NodeLibRequire): void => {
    const prototype = Agent.prototype;
    if (installed.has(prototype)) return;
    const original = prototype.createConnection;
    const connect = function(this: unknown, options: Record<string, any>, callback: (error: Error | null, socket?: unknown) => void): unknown {
      const host = String(options.hostname ?? options.host ?? 'localhost').toLowerCase();
      // Plain local HTTP is the engine's existing virtual network, except a port the host serves itself.
      if (protocol === 'http:' && (local(host) || options.socketPath)
        && !(local(host) && !options.socketPath && transportOptions.hostPorts?.().has(Number(options.port ?? 80)))) {
        return original.call(this, options, callback);
      }
      try {
        if (options.socketPath || options.localAddress || options.localPort || options.lookup || options.family) throw unsupported('custom socket routing');
        // Node's Agent names a servername for plain HTTP too ('' for an IP); TLS options are an https question.
        if (protocol === 'https:' && (tlsOptions.some(key => options[key] !== undefined) || options.rejectUnauthorized === false
          || (options.servername !== undefined && options.servername !== host))) throw unsupported('custom TLS options');
        const authority = new URL(`${protocol}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${options.port ?? (protocol === 'https:' ? 443 : 80)}`);
        return connection(authority, factory(), require);
      } catch (cause) {
        queueMicrotask(() => callback(cause instanceof Error ? cause : new Error(String(cause))));
        return undefined;
      }
    };
    prototype.createConnection = connect;
    installed.set(prototype, { original, connect });
    const ref = new WeakRef(prototype);
    live.add(ref);
    collected.register(prototype, ref, ref);
  };
  // The host graph serves engine-internal calls. Every guest graph gets the
  // same host adapter at bootstrap, before application monkey patches run.
  install(httpModule.Agent, 'http:');
  install(httpsModule.Agent, 'https:');
  const unsubscribe = onNodeLibLoaded((name, value, require) => {
    if (name === '_http_agent') install(value.Agent, 'http:', require);
    if (name === 'https') install(value.Agent, 'https:', require);
  });
  return () => {
    unsubscribe();
    for (const ref of live) {
      const prototype = ref.deref();
      const held = prototype && installed.get(prototype);
      if (prototype && held && prototype.createConnection === held.connect) prototype.createConnection = held.original;
      collected.unregister(ref);
    }
    live.clear();
  };
}

function connection(origin: URL, exchange: HttpClientExchange, require?: NodeLibRequire): unknown {
  // Resolve at connection time; eagerly loading during Agent compilation
  // would enter a partially initialized HTTP/stream dependency cycle.
  const streams = require ? require('stream') : streamModule;
  const net = require ? require('net') : netModule;
  const http = require ? require('http') : httpModule;
  const pair = streams.duplexPair({ highWaterMark: 64 * 1024 }) as [any, any];
  const client = new net.Socket({ handle: new DuplexStreamHandle(pair[0]), readable: true, writable: true });
  const peer = new net.Socket({ handle: new DuplexStreamHandle(pair[1]), readable: true, writable: true });
  peer.unref();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const fail = (cause: unknown): void => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    controller.abort(error);
    client.destroy(error);
    peer.destroy();
  };
  client.once('close', (() => {
    controller.abort(new Error('HTTP client connection closed.'));
    void reader?.cancel(controller.signal.reason).catch(() => {});
    peer.destroy();
  }) as never);
  peer.on('error', fail as never);
  const server = http.createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 0, headersTimeout: 0 }, (request: any, response: any) => {
    void (async () => {
      if (!request.url.startsWith('/') || request.url.startsWith('//')) throw unsupported('absolute-form request targets');
      const url = new URL(request.url, origin);
      if (url.origin !== origin.origin) throw unsupported('a request target that changes origin');
      const headers: Array<[string, string]> = [];
      const connectionHeaders = new Set<string>();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i], value = request.rawHeaders[i + 1];
        const lower = name.toLowerCase();
        if (['expect', 'upgrade', 'trailer', 'te'].includes(lower)) throw unsupported(`${lower} headers`);
        if (lower === 'host') {
          if (value.toLowerCase() !== origin.host) throw unsupported('a Host header different from the destination');
          continue;
        }
        if (lower === 'connection') for (const token of value.split(',')) connectionHeaders.add(token.trim().toLowerCase());
        headers.push([name, value]);
      }
      // Preserve the parsed length as metadata. The host can send a bounded,
      // known-small body without Fetch's HTTP/2-only streaming upload mode;
      // the remote transport still generates its own HTTP framing.
      const outgoing = headers.filter(([name]) => !['connection', 'keep-alive', 'transfer-encoding'].includes(name.toLowerCase()) && !connectionHeaders.has(name.toLowerCase()));
      const carriesBody = request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) > 0;
      const Readable = streams.Readable as any;
      const body = carriesBody ? Readable.toWeb(request, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) : undefined;
      if (!carriesBody) request.resume();
      const result = await exchange({ url: url.href, method: request.method, headers: outgoing, ...(body ? { body } : {}), signal: controller.signal, profile: 'server-http' });
      if (controller.signal.aborted) { await result.body?.cancel(controller.signal.reason); return; }
      // This virtual connection carries one exchange. Framing is Node's; the
      // remote connection's hop-by-hop state is never a local socket promise.
      response.shouldKeepAlive = false;
      response.sendDate = false;
      response.writeHead(result.status, result.statusText, result.headers.flat());
      reader = result.body?.getReader();
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const next = reader ? await reader.read() : { done: true, value: undefined };
          if (next.done) break;
          if (!response.write(next.value)) await new Promise<void>((resolve, reject) => {
            const abort = (): void => { response.removeListener('drain', drain); reject(controller.signal.reason); };
            const drain = (): void => { controller.signal.removeEventListener('abort', abort); resolve(); };
            response.once('drain', drain);
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
          });
        }
        response.end();
      } catch (cause) {
        await reader?.cancel(cause).catch(() => {});
        throw cause;
      } finally { reader?.releaseLock(); reader = undefined; }
    })().catch(fail);
  }) as any;
  for (const name of ['connect', 'upgrade', 'checkContinue', 'checkExpectation']) server.on(name, () => fail(unsupported(name)));
  server.on('clientError', fail);
  server.emit('connection', peer);
  return client;
}
