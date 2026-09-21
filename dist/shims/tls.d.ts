/**
 * tls shim - TLS/SSL is not available in browser
 * Provides stubs that allow code to load without crashing
 */
import { EventEmitter } from '../node-lib/events-module';
export declare class TLSSocket extends EventEmitter {
    authorized: boolean;
    encrypted: boolean;
    constructor(_socket?: unknown, _options?: unknown);
    getPeerCertificate(_detailed?: boolean): object;
    getCipher(): {
        name: string;
        version: string;
    } | null;
    getProtocol(): string | null;
    setServername(_name: string): void;
    renegotiate(_options: unknown, _callback: (err: Error | null) => void): boolean;
}
export declare class Server extends EventEmitter {
    constructor(_options?: unknown, _connectionListener?: (socket: TLSSocket) => void);
    listen(..._args: unknown[]): this;
    close(_callback?: (err?: Error) => void): this;
    address(): {
        port: number;
        family: string;
        address: string;
    } | string | null;
    getTicketKeys(): Buffer;
    setTicketKeys(_keys: Buffer): void;
    setSecureContext(_options: unknown): void;
}
export declare function createServer(_options?: unknown, _connectionListener?: (socket: TLSSocket) => void): Server;
export declare function connect(_options: unknown, _callback?: () => void): TLSSocket;
export declare const createSecureContext: (_options?: unknown) => {};
export declare const getCiphers: () => string[];
export declare const DEFAULT_ECDH_CURVE = "auto";
export declare const DEFAULT_MAX_VERSION = "TLSv1.3";
export declare const DEFAULT_MIN_VERSION = "TLSv1.2";
export declare const rootCertificates: string[];
declare const _default: {
    TLSSocket: typeof TLSSocket;
    Server: typeof Server;
    createServer: typeof createServer;
    connect: typeof connect;
    createSecureContext: (_options?: unknown) => {};
    getCiphers: () => string[];
    DEFAULT_ECDH_CURVE: string;
    DEFAULT_MAX_VERSION: string;
    DEFAULT_MIN_VERSION: string;
    rootCertificates: string[];
};
export default _default;
//# sourceMappingURL=tls.d.ts.map