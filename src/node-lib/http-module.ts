/**
 * `http` and `https`, as Node's own `http.js` on llhttp.
 *
 * What died: the engine's `http` was a hand-written parser and server, 1,374
 * lines. Node's own `test-http-*`: 28 of 377 passed.
 *
 * What this is: Node's `http.js`, `https.js` and the five `_http_*.js` files
 * v22.18.0, vendored unmodified, on `./binding/http_parser.ts` -- llhttp's own
 * WebAssembly build, which is the parser Node itself links. `Agent`,
 * `ClientRequest`, `IncomingMessage`, `OutgoingMessage`, `Server` and
 * `ServerResponse` are Node's own code, over the engine's `net`.
 *
 * The rule for this file: it binds, it does not implement.
 */
import { lazyModule } from './lazy';

/** The whole of Node's `http` module object, as the engine's parts read it. */
export interface HttpModule {
  Agent: new (options?: unknown) => unknown;
  ClientRequest: new (...args: unknown[]) => unknown;
  IncomingMessage: new (socket?: unknown) => unknown;
  OutgoingMessage: new () => unknown;
  Server: new (options?: unknown, listener?: unknown) => unknown;
  ServerResponse: new (request: unknown) => unknown;
  createServer(options?: unknown, listener?: unknown): unknown;
  request(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  globalAgent: unknown;
  METHODS: string[];
  STATUS_CODES: Record<number, string>;
  maxHeaderSize: number;
  setMaxIdleHTTPParsers(max: number): void;
  validateHeaderName(name: string, label?: string): void;
  validateHeaderValue(name: string, value: unknown): void;
}

export const httpModule = lazyModule<HttpModule>('http');
export const httpsModule = lazyModule<HttpModule>('https');

/**
 * The five `_http_*` modules, which Node lets a program require by name --
 * they are legacy public names, not internals, and a program that subclasses
 * `_http_outgoing`'s `OutgoingMessage` or reads `_http_server`'s `STATUS_CODES`
 * reaches them that way.
 */
export const httpCommonModule = lazyModule<Record<string, unknown>>('_http_common');
export const httpIncomingModule = lazyModule<Record<string, unknown>>('_http_incoming');
export const httpOutgoingModule = lazyModule<Record<string, unknown>>('_http_outgoing');
export const httpServerModule = lazyModule<Record<string, unknown>>('_http_server');
export const httpClientModule = lazyModule<Record<string, unknown>>('_http_client');
export const httpAgentModule = lazyModule<Record<string, unknown>>('_http_agent');

export default httpModule;
