/**
 * zlib and Brotli numbers the engine actually answers. A leaf: no imports,
 * so the constants table can read them without entering the zlib shim,
 * which pulls buffer and sits in a load cycle with this table.
 */
export declare const zlibConstants: {
    Z_NO_FLUSH: number;
    Z_PARTIAL_FLUSH: number;
    Z_SYNC_FLUSH: number;
    Z_FULL_FLUSH: number;
    Z_FINISH: number;
    Z_BLOCK: number;
    Z_OK: number;
    Z_STREAM_END: number;
    Z_NEED_DICT: number;
    Z_ERRNO: number;
    Z_STREAM_ERROR: number;
    Z_DATA_ERROR: number;
    Z_MEM_ERROR: number;
    Z_BUF_ERROR: number;
    Z_VERSION_ERROR: number;
    Z_NO_COMPRESSION: number;
    Z_BEST_SPEED: number;
    Z_BEST_COMPRESSION: number;
    Z_DEFAULT_COMPRESSION: number;
    Z_FILTERED: number;
    Z_HUFFMAN_ONLY: number;
    Z_RLE: number;
    Z_FIXED: number;
    Z_DEFAULT_STRATEGY: number;
    ZLIB_VERNUM: number;
    Z_MIN_WINDOWBITS: number;
    Z_MAX_WINDOWBITS: number;
    Z_DEFAULT_WINDOWBITS: number;
    Z_MIN_CHUNK: number;
    Z_MAX_CHUNK: number;
    Z_DEFAULT_CHUNK: number;
    Z_MIN_MEMLEVEL: number;
    Z_MAX_MEMLEVEL: number;
    Z_DEFAULT_MEMLEVEL: number;
    Z_MIN_LEVEL: number;
    Z_MAX_LEVEL: number;
    Z_DEFAULT_LEVEL: number;
    BROTLI_DECODE: number;
    BROTLI_ENCODE: number;
    BROTLI_OPERATION_PROCESS: number;
    BROTLI_OPERATION_FLUSH: number;
    BROTLI_OPERATION_FINISH: number;
    BROTLI_OPERATION_EMIT_METADATA: number;
    BROTLI_PARAM_MODE: number;
    BROTLI_MODE_GENERIC: number;
    BROTLI_MODE_TEXT: number;
    BROTLI_MODE_FONT: number;
    BROTLI_PARAM_QUALITY: number;
    BROTLI_MIN_QUALITY: number;
    BROTLI_MAX_QUALITY: number;
    BROTLI_DEFAULT_QUALITY: number;
    BROTLI_PARAM_LGWIN: number;
    BROTLI_MIN_WINDOW_BITS: number;
    BROTLI_MAX_WINDOW_BITS: number;
    BROTLI_DEFAULT_WINDOW: number;
    BROTLI_PARAM_LGBLOCK: number;
    BROTLI_MIN_INPUT_BLOCK_BITS: number;
    BROTLI_MAX_INPUT_BLOCK_BITS: number;
};
//# sourceMappingURL=zlib-constants.d.ts.map