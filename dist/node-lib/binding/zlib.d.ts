type ProcessCallback = () => void;
/**
 * One compression or decompression stream. Node makes one per `Gzip`,
 * `Inflate` and the rest, initializes it once, and then drives it a buffer at
 * a time until its input is gone.
 */
export declare class Zlib {
    #private;
    readonly mode: number;
    /** `zlib.js` hangs its own error reporter here. */
    onerror: ((message: string, errno: number, code?: string) => void) | null;
    constructor(mode: number);
    init(windowBits: number, level: number, memLevel: number, strategy: number, writeState: Uint32Array, processCallback: ProcessCallback, dictionary?: Uint8Array): void;
    write(flush: number, inBuf: Uint8Array | null, inOff: number, inLen: number, outBuf: Uint8Array, outOff: number, outLen: number): this;
    writeSync(flush: number, inBuf: Uint8Array | null, inOff: number, inLen: number, outBuf: Uint8Array, outOff: number, outLen: number): this;
    /**
     * `deflateParams` mid-stream. pako's deflate does not carry it, so the
     * level and strategy are taken by starting the stream again -- which is
     * what zlib does when the two cannot be changed in place, and is only
     * reachable before any output has been produced.
     */
    params(level: number, strategy: number): void;
    reset(): void;
    close(): void;
    /** Node asks a handle for these two after a `Z_STREAM_END`. */
    get ended(): boolean;
}
export declare const zlibBinding: {
    Zlib: typeof Zlib;
    BrotliEncoder: new (...args: unknown[]) => never;
    BrotliDecoder: new (...args: unknown[]) => never;
    ZstdCompress: new (...args: unknown[]) => never;
    ZstdDecompress: new (...args: unknown[]) => never;
    /** `zlib.crc32`, which is zlib's own table-driven one. */
    crc32: (data: Uint8Array | string, value?: number) => number;
};
export default zlibBinding;
//# sourceMappingURL=zlib.d.ts.map