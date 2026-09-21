/**
 * http2 shim - HTTP/2 is not available in browser
 */
import { EventEmitter } from '../node-lib/events-module';
export declare class Http2Session extends EventEmitter {
    close(_callback?: () => void): void;
    destroy(_error?: Error, _code?: number): void;
    get destroyed(): boolean;
    get encrypted(): boolean;
    get closed(): boolean;
    ping(_callback: (err: Error | null, duration: number, payload: Buffer) => void): boolean;
    ref(): void;
    unref(): void;
    setTimeout(_msecs: number, _callback?: () => void): void;
}
export declare class ClientHttp2Session extends Http2Session {
}
export declare class ServerHttp2Session extends Http2Session {
}
export declare class Http2Stream extends EventEmitter {
    close(_code?: number, _callback?: () => void): void;
    get id(): number;
    get pending(): boolean;
    get destroyed(): boolean;
    get closed(): boolean;
    priority(_options: unknown): void;
    setTimeout(_msecs: number, _callback?: () => void): void;
    end(_data?: unknown, _encoding?: string, _callback?: () => void): void;
}
export declare class Http2ServerRequest extends EventEmitter {
}
export declare class Http2ServerResponse extends EventEmitter {
    writeHead(_statusCode: number, _headers?: object): this;
    end(_data?: unknown): void;
}
export declare function createServer(_options?: unknown, _onRequestHandler?: unknown): EventEmitter;
export declare function createSecureServer(_options?: unknown, _onRequestHandler?: unknown): EventEmitter;
export declare function connect(_authority: string, _options?: unknown, _listener?: () => void): ClientHttp2Session;
export declare const constants: {
    NGHTTP2_SESSION_SERVER: number;
    NGHTTP2_SESSION_CLIENT: number;
    HTTP2_HEADER_STATUS: string;
    HTTP2_HEADER_METHOD: string;
    HTTP2_HEADER_AUTHORITY: string;
    HTTP2_HEADER_SCHEME: string;
    HTTP2_HEADER_PATH: string;
    HTTP_STATUS_OK: number;
    HTTP_STATUS_NOT_FOUND: number;
};
export declare function getDefaultSettings(): object;
export declare function getPackedSettings(_settings?: object): Buffer;
export declare function getUnpackedSettings(_buf: Buffer): object;
export declare const sensitiveHeaders: unique symbol;
declare const _default: {
    Http2Session: typeof Http2Session;
    ClientHttp2Session: typeof ClientHttp2Session;
    ServerHttp2Session: typeof ServerHttp2Session;
    Http2Stream: typeof Http2Stream;
    Http2ServerRequest: typeof Http2ServerRequest;
    Http2ServerResponse: typeof Http2ServerResponse;
    createServer: typeof createServer;
    createSecureServer: typeof createSecureServer;
    connect: typeof connect;
    constants: {
        NGHTTP2_SESSION_SERVER: number;
        NGHTTP2_SESSION_CLIENT: number;
        HTTP2_HEADER_STATUS: string;
        HTTP2_HEADER_METHOD: string;
        HTTP2_HEADER_AUTHORITY: string;
        HTTP2_HEADER_SCHEME: string;
        HTTP2_HEADER_PATH: string;
        HTTP_STATUS_OK: number;
        HTTP_STATUS_NOT_FOUND: number;
    };
    getDefaultSettings: typeof getDefaultSettings;
    getPackedSettings: typeof getPackedSettings;
    getUnpackedSettings: typeof getUnpackedSettings;
    sensitiveHeaders: symbol;
};
export default _default;
//# sourceMappingURL=http2.d.ts.map