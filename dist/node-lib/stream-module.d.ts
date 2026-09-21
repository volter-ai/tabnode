/** Node's `stream` module object, as the engine's own parts read it. */
export interface StreamModule {
    Stream: new (options?: unknown) => unknown;
    Readable: new (options?: unknown) => ReadableLike;
    Writable: new (options?: unknown) => WritableLike;
    Duplex: new (options?: unknown) => DuplexLike;
    Transform: new (options?: unknown) => DuplexLike;
    PassThrough: new (options?: unknown) => DuplexLike;
    pipeline: (...args: unknown[]) => unknown;
    finished: (...args: unknown[]) => unknown;
    compose: (...args: unknown[]) => unknown;
    addAbortSignal: (...args: unknown[]) => unknown;
    duplexPair: (...args: unknown[]) => unknown;
    promises: Record<string, unknown>;
    isDisturbed: (stream: unknown) => boolean;
    isErrored: (stream: unknown) => boolean;
    isReadable: (stream: unknown) => boolean;
    _isUint8Array: (value: unknown) => boolean;
    _uint8ArrayToBuffer: (value: Uint8Array) => Uint8Array;
}
/** The shape the engine's own parts use a readable through. */
export interface ReadableLike {
    push(chunk: unknown, encoding?: string): boolean;
    read(size?: number): string | Uint8Array | null;
    pause(): this;
    resume(): this;
    destroy(error?: Error): this;
    setEncoding(encoding: string): this;
    pipe(destination: unknown, options?: unknown): unknown;
    on(event: string, listener: (...args: never[]) => void): this;
    once(event: string, listener: (...args: never[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    readable: boolean;
    readableEnded: boolean;
    destroyed: boolean;
    isTTY?: boolean;
    [key: string]: unknown;
}
/** The shape the engine's own parts use a writable through. */
export interface WritableLike {
    write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean;
    end(chunk?: unknown, encoding?: unknown, callback?: unknown): this;
    destroy(error?: Error): this;
    on(event: string, listener: (...args: never[]) => void): this;
    once(event: string, listener: (...args: never[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    writable: boolean;
    destroyed: boolean;
    [key: string]: unknown;
}
export interface DuplexLike extends ReadableLike, WritableLike {
}
/** Node's own `stream.js`, built by the loader on the first property read. */
export declare const streamModule: StreamModule;
/**
 * The classes, and the names the engine's own code uses as TYPES for them:
 * a stream a shim holds is "a Readable", whatever Node's own class is.
 */
export type Readable = ReadableLike;
export type Writable = WritableLike;
export type Duplex = DuplexLike;
export type Transform = DuplexLike;
export type PassThrough = DuplexLike;
export declare const Stream: new (options?: unknown) => unknown;
export declare const Readable: new (options?: unknown) => ReadableLike;
export declare const Writable: new (options?: unknown) => WritableLike;
export declare const Duplex: new (options?: unknown) => DuplexLike;
export declare const Transform: new (options?: unknown) => DuplexLike;
export declare const PassThrough: new (options?: unknown) => DuplexLike;
export declare const pipeline: (...args: unknown[]) => unknown;
export declare const finished: (...args: unknown[]) => unknown;
export declare const promises: Record<string, unknown>;
/** The promise form of `pipeline` and `finished`, as `stream/promises`. */
export declare const streamPromisesModule: Record<string, unknown>;
/** Node's `stream` module object IS the `Stream` class, as `stream.js` exports it. */
export default streamModule;
//# sourceMappingURL=stream-module.d.ts.map