/** The callback slots Node hangs off a parser, by the index its C++ uses. */
declare const kOnMessageBegin = 0;
declare const kOnHeaders = 1;
declare const kOnHeadersComplete = 2;
declare const kOnBody = 3;
declare const kOnMessageComplete = 4;
declare const kOnExecute = 5;
declare const kOnTimeout = 6;
type ParserCallback = ((...args: never[]) => unknown) | null;
export declare class HTTPParser {
    #private;
    static readonly REQUEST = 1;
    static readonly RESPONSE = 2;
    static readonly kOnMessageBegin = 0;
    static readonly kOnHeaders = 1;
    static readonly kOnHeadersComplete = 2;
    static readonly kOnBody = 3;
    static readonly kOnMessageComplete = 4;
    static readonly kOnExecute = 5;
    static readonly kOnTimeout = 6;
    /** Node's lenient flags. Each one llhttp itself can be told about is passed on. */
    static readonly kLenientNone = 0;
    static readonly kLenientHeaders = 1;
    static readonly kLenientChunkedLength = 2;
    static readonly kLenientKeepAlive = 4;
    static readonly kLenientTransferEncoding = 8;
    static readonly kLenientVersion = 16;
    static readonly kLenientDataAfterClose = 32;
    static readonly kLenientOptionalLFAfterCR = 64;
    static readonly kLenientOptionalCRLFAfterChunk = 128;
    static readonly kLenientOptionalCRBeforeLF = 256;
    static readonly kLenientSpacesAfterChunkSize = 512;
    static readonly kLenientAll = 1023;
    [kOnMessageBegin]: ParserCallback;
    [kOnHeaders]: ParserCallback;
    [kOnHeadersComplete]: ParserCallback;
    [kOnBody]: ParserCallback;
    [kOnMessageComplete]: ParserCallback;
    [kOnExecute]: ParserCallback;
    [kOnTimeout]: ParserCallback;
    /** The socket `_http_server.js` hangs on a parser, and reads off one here. */
    socket?: {
        destroy(): void;
    } | null;
    /** When this connection's current head and current message began, in ms. */
    headersStart: number;
    messageStart: number;
    /** Whether a message is in flight, which is what `idle()` is the absence of. */
    active: boolean;
    /**
     * `parser.initialize(type, resource, maxHeaderSize, lenient, headersTimeout)`,
     * which Node calls for every parser it takes off its free list.
     */
    initialize(type: number, _resource?: unknown, maxHeaderSize?: number, lenient?: number, connections?: ConnectionsList): void;
    /** Node's `parser.free()`: back on the free list, holding no llhttp state. */
    free(): void;
    /** Node's `parser.remove()`, which only matters for a consumed stream. */
    remove(): void;
    close(): void;
    pause(): void;
    resume(): void;
    /** The engine's handles are not stream bases, so Node never consumes one. */
    consume(): void;
    unconsume(): void;
    getCurrentBuffer(): Uint8Array;
    /**
     * `parser.execute(buffer)`: the bytes through llhttp, answering how many it
     * took, or an `Error` carrying `bytesParsed`, the llhttp code and llhttp's
     * own reason -- which is the shape `_http_server.js` reads to decide
     * between a 400 and a destroyed socket.
     */
    execute(buffer: Uint8Array): number | Error;
    /** `parser.finish()`: the stream ended; llhttp says whether that was legal. */
    finish(): number | Error | undefined;
    onMessageBegin(): number;
    onUrl(at: number, length: number): number;
    onStatus(at: number, length: number): number;
    onHeaderField(at: number, length: number): number;
    onHeaderValue(at: number, length: number): number;
    onHeadersComplete(statusCode: number, upgrade: boolean, shouldKeepAlive: boolean): number;
    onBody(at: number, length: number): number;
    onMessageComplete(): number;
    /** Off the list it was initialized onto; `free` is where Node lets one go. */
    detach(): void;
}
/**
 * `internalBinding('http_parser')`'s `ConnectionsList`: the parsers a server
 * has open, which is how `_http_server.js` closes its connections and
 * enforces `headersTimeout` and `requestTimeout`. Node keeps the list in C++
 * beside the parsers themselves; here it is a set of the same parsers, and
 * each answers from the timestamps llhttp's own callbacks set on it.
 */
export declare class ConnectionsList {
    #private;
    add(parser: HTTPParser): void;
    remove(parser: HTTPParser): void;
    all(): HTTPParser[];
    /** A connection with no message in flight. */
    idle(): HTTPParser[];
    /** A connection with one. */
    active(): HTTPParser[];
    /**
     * The connections that have taken too long: one whose head is still
     * arriving after `headersTimeout`, or whose message has been in flight past
     * `requestTimeout`. A timeout of 0 is off, as it is in Node.
     */
    expired(headersTimeout: number, requestTimeout: number): HTTPParser[];
}
/** The binding object, built on the first ask. */
export declare const httpParserBinding: {
    HTTPParser: typeof HTTPParser;
    ConnectionsList: typeof ConnectionsList;
    /**
     * `http.METHODS`: the HTTP methods, which are the ones llhttp lists before
     * `PRI` -- that is where its RTSP block begins, and RTSP's verbs are not
     * HTTP's. Read off the same table as `allMethods`, so the two cannot drift.
     */
    readonly methods: string[];
    readonly allMethods: string[];
};
export default httpParserBinding;
//# sourceMappingURL=http_parser.d.ts.map