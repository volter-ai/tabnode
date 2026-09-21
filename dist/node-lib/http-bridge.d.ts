import type { Socket } from './net-module';
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
export declare function __listening(port: number): boolean;
/**
 * A request to a guest's server, answered whole. The connection is this
 * engine's own loopback: the guest's server accepts it, and nothing leaves
 * the tab.
 */
export declare function __requestOverLoopback(port: number, method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<ResponseData>;
/**
 * The same request, answered as it arrives: the head first, then each chunk
 * the server writes, then the end. This is what the service worker streams
 * to the page.
 */
export declare function __streamOverLoopback(port: number, method: string, url: string, headers: Record<string, string>, body: Buffer | undefined, onStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void, onChunk: (chunk: Uint8Array) => void, onEnd: () => void): Promise<void>;
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
export declare function __upgradeOverLoopback(port: number, method: string, url: string, headers: Record<string, string>): Promise<UpgradeResult>;
//# sourceMappingURL=http-bridge.d.ts.map