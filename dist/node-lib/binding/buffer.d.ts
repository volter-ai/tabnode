/**
 * `internalBinding('buffer')`: the bytes under Node's own `buffer.js`.
 *
 * Node's `Buffer` is a `Uint8Array` subclass whose whole API -- `alloc`,
 * `concat`, `toString`, `write`, `compare`, `indexOf`, `readInt32BE` and the
 * rest -- is JavaScript in `lib/buffer.js` and `lib/internal/buffer.js`. What
 * is native is only the part underneath: encode a string into bytes, decode
 * bytes into a string, compare two ranges, find one range inside another,
 * fill, copy, swap. That is this file, over `TextEncoder`, `TextDecoder` and
 * the realm's own base64, and nothing above it.
 *
 * Every function here has the shape Node's own files call it with: the
 * `*Slice` family is installed as a method and reads `this`; `base64Write`,
 * `base64urlWrite`, `hexWrite` and `ucs2Write` likewise; `asciiWriteStatic`,
 * `latin1WriteStatic` and `utf8WriteStatic` take the buffer as their first
 * argument, which is how `internal/buffer.js` wraps them.
 */
/** libuv has no say here: these are V8's, and the engine's realm is V8's. */
export declare const kMaxLength: number;
export declare const kStringMaxLength = 536870888;
/**
 * Node's encoding numbers, from `enum encoding` in `node_buffer.h`. They are
 * private to this binding and `internal/util`'s `encodingsMap`, which is the
 * only thing that hands them over.
 */
export declare const ASCII = 0;
export declare const UTF8 = 1;
export declare const BASE64 = 2;
export declare const UCS2 = 3;
export declare const LATIN1 = 4;
export declare const HEX = 5;
export declare const BUFFER = 6;
export declare const BASE64URL = 7;
/** Node's `StringWrite<UTF8>`: as many whole code points as fit. */
export declare function utf8WriteStatic(buf: Uint8Array, string: string, offset?: number, length?: number): number;
/** Node's `StringWrite<ASCII>`: the low seven bits of each unit, one byte each. */
export declare function asciiWriteStatic(buf: Uint8Array, string: string, offset?: number, length?: number): number;
/** Node's `StringWrite<LATIN1>`: the low eight bits of each unit. */
export declare function latin1WriteStatic(buf: Uint8Array, string: string, offset?: number, length?: number): number;
/** Node's `StringWrite<UCS2>`: whole 16-bit units, little-endian. */
export declare function ucs2Write(this: Uint8Array, string: string, offset?: number, length?: number): number;
/** Node's `StringWrite<HEX>`: whole byte pairs, stopping at the first that is not one. */
export declare function hexWrite(this: Uint8Array, string: string, offset?: number, length?: number): number;
/** Node's `StringWrite<BASE64>`. */
export declare function base64Write(this: Uint8Array, string: string, offset?: number, length?: number): number;
/** Node's `StringWrite<BASE64URL>`. */
export declare function base64urlWrite(this: Uint8Array, string: string, offset?: number, length?: number): number;
export declare function utf8Slice(this: Uint8Array, start?: number, end?: number): string;
export declare function asciiSlice(this: Uint8Array, start?: number, end?: number): string;
export declare function latin1Slice(this: Uint8Array, start?: number, end?: number): string;
export declare function ucs2Slice(this: Uint8Array, start?: number, end?: number): string;
export declare function hexSlice(this: Uint8Array, start?: number, end?: number): string;
export declare function base64Slice(this: Uint8Array, start?: number, end?: number): string;
export declare function base64urlSlice(this: Uint8Array, start?: number, end?: number): string;
/** Node's `ByteLengthUtf8`. */
export declare function byteLengthUtf8(string: string): number;
/** Node's `Compare`: two buffers whole, as `memcmp` orders them. */
export declare function compare(a: Uint8Array, b: Uint8Array): number;
/** Node's `CompareOffset`: a range of one against a range of the other. */
export declare function compareOffset(source: Uint8Array, target: Uint8Array, targetStart?: number, sourceStart?: number, targetEnd?: number, sourceEnd?: number): number;
/**
 * Node's `Copy(source, target, targetStart, sourceStart, toCopy)`. The last
 * argument is a LENGTH, not an end offset: `buffer.js`'s `_copyActual` has
 * already clamped the range and hands over how many bytes to move.
 */
export declare function copy(source: Uint8Array, target: Uint8Array, targetStart?: number, sourceStart?: number, toCopy?: number): number;
/**
 * Node's `Fill` for a value that is not a number: a string in some encoding,
 * or another buffer, repeated over the range. -1 says the value stands for no
 * bytes at all, which is what `buffer.js` turns into ERR_INVALID_ARG_VALUE.
 */
export declare function fill(buf: Uint8Array, value: unknown, start: number, end: number, encoding?: string): number;
/** The bytes a string stands for in one of Node's encodings. */
export declare function bytesOfString(value: string, encoding: string): Uint8Array;
/** Node's `IndexOfNumber`. */
export declare function indexOfNumber(buffer: Uint8Array, value: number, byteOffset: number, isForward: boolean): number;
/** Node's `IndexOfBuffer`. */
export declare function indexOfBuffer(buffer: Uint8Array, value: Uint8Array, byteOffset: number, encoding: number, isForward: boolean): number;
/** Node's `IndexOfString`. */
export declare function indexOfString(buffer: Uint8Array, value: string, byteOffset: number, encoding: number, isForward: boolean): number;
/** Node's `Swap16`/`Swap32`/`Swap64`, in place, answering the same buffer. */
export declare function swap16(buf: Uint8Array): Uint8Array;
export declare function swap32(buf: Uint8Array): Uint8Array;
export declare function swap64(buf: Uint8Array): Uint8Array;
/** Node's `IsUtf8`: whether the bytes decode without a replacement. */
export declare function isUtf8(buf: Uint8Array): boolean;
/** Node's `IsAscii`: every byte under 128. */
export declare function isAscii(buf: Uint8Array): boolean;
/** Node's `Atob`: the string a base64 one stands for, -1 for one that is not. */
export declare function atob(input: string): string | number;
/** Node's `Btoa`: the base64 of a latin1 string, -1 for a character outside it. */
export declare function btoa(input: string): string | number;
export declare function getZeroFillToggle(): Uint32Array;
/**
 * Node's `DetachArrayBuffer` and `CopyArrayBuffer`, which `Blob` and the
 * worker's message port use. A realm can detach through `structuredClone`'s
 * transfer list, and that is the only detach there is here.
 */
export declare function detachArrayBuffer(buffer: ArrayBuffer): void;
export declare function copyArrayBuffer(dest: ArrayBuffer, destOffset: number, source: ArrayBuffer, sourceOffset: number, length: number): void;
/** Node's `SetBufferPrototype`: C++ keeps it to build buffers; nothing here does. */
export declare function setBufferPrototype(_proto: object): void;
/** Node's `CreateFromString`: `buffer.js` has its own and never calls this. */
export declare function createFromString(string: string, encoding: number): Uint8Array;
declare const _default: {
    byteLengthUtf8: typeof byteLengthUtf8;
    compare: typeof compare;
    compareOffset: typeof compareOffset;
    copy: typeof copy;
    fill: typeof fill;
    isAscii: typeof isAscii;
    isUtf8: typeof isUtf8;
    indexOfBuffer: typeof indexOfBuffer;
    indexOfNumber: typeof indexOfNumber;
    indexOfString: typeof indexOfString;
    swap16: typeof swap16;
    swap32: typeof swap32;
    swap64: typeof swap64;
    kMaxLength: number;
    kStringMaxLength: number;
    atob: typeof atob;
    btoa: typeof btoa;
    asciiSlice: typeof asciiSlice;
    base64Slice: typeof base64Slice;
    base64urlSlice: typeof base64urlSlice;
    latin1Slice: typeof latin1Slice;
    hexSlice: typeof hexSlice;
    ucs2Slice: typeof ucs2Slice;
    utf8Slice: typeof utf8Slice;
    asciiWriteStatic: typeof asciiWriteStatic;
    base64Write: typeof base64Write;
    base64urlWrite: typeof base64urlWrite;
    latin1WriteStatic: typeof latin1WriteStatic;
    hexWrite: typeof hexWrite;
    ucs2Write: typeof ucs2Write;
    utf8WriteStatic: typeof utf8WriteStatic;
    getZeroFillToggle: typeof getZeroFillToggle;
    detachArrayBuffer: typeof detachArrayBuffer;
    copyArrayBuffer: typeof copyArrayBuffer;
    setBufferPrototype: typeof setBufferPrototype;
    createFromString: typeof createFromString;
};
export default _default;
//# sourceMappingURL=buffer.d.ts.map