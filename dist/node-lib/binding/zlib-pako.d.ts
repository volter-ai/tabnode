/** A fresh `z_stream`, the object every call below reads and writes. */
export declare function zstream(): Record<string, unknown>;
export declare const inflateModule: {
    inflateInit2(strm: unknown, windowBits: number): number;
    inflate(strm: unknown, flush: number): number;
    inflateEnd(strm: unknown): number;
    inflateReset(strm: unknown): number;
    inflateSetDictionary(strm: unknown, dictionary: Uint8Array): number;
};
export declare const deflateModule: {
    deflateInit2(strm: unknown, level: number, method: number, windowBits: number, memLevel: number, strategy: number): number;
    deflate(strm: unknown, flush: number): number;
    deflateEnd(strm: unknown): number;
    deflateReset(strm: unknown): number;
    deflateSetDictionary(strm: unknown, dictionary: Uint8Array): number;
};
/** zlib's constants and its own error text, beside the checksum it defines. */
export declare const zlibConstants: Record<string, number> & {
    messages: Record<number, string>;
    crc32: (crc: number, buffer: Uint8Array, length: number, position: number) => number;
};
//# sourceMappingURL=zlib-pako.d.ts.map