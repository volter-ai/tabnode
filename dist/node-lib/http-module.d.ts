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
export declare const httpModule: HttpModule;
export declare const httpsModule: HttpModule;
/**
 * The five `_http_*` modules, which Node lets a program require by name --
 * they are legacy public names, not internals, and a program that subclasses
 * `_http_outgoing`'s `OutgoingMessage` or reads `_http_server`'s `STATUS_CODES`
 * reaches them that way.
 */
export declare const httpCommonModule: Record<string, unknown>;
export declare const httpIncomingModule: Record<string, unknown>;
export declare const httpOutgoingModule: Record<string, unknown>;
export declare const httpServerModule: Record<string, unknown>;
export declare const httpClientModule: Record<string, unknown>;
export declare const httpAgentModule: Record<string, unknown>;
export default httpModule;
//# sourceMappingURL=http-module.d.ts.map