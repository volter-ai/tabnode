/**
 * The two bindings `internal/child_process.js` names only to ask an
 * `instanceof` of.
 *
 * `udp_wrap`'s `UDP` tells a datagram handle from a stream one when a handle
 * is sent over IPC, and `http_parser`'s `HTTPParser` tells a parser handle
 * from a socket when one is released. The engine has no datagram handle and
 * parses HTTP in JavaScript, so nothing is ever an instance of either; the
 * classes exist so the question can be asked, and answered no.
 */
/** libuv's `uv_udp_t`, which this engine never makes one of. */
export declare class UDP {
}
/** The HTTP parser handle a C++ Node keeps on a socket; this one has none. */
export declare class HTTPParser {
}
export declare const udpWrapBinding: {
    UDP: typeof UDP;
};
export declare const httpParserBinding: {
    HTTPParser: typeof HTTPParser;
};
//# sourceMappingURL=stubs.d.ts.map