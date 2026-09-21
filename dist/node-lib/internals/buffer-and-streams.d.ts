import { createBlobFromFilePath } from '../binding/blob';
/** Node's `once(fn)`: the same function, run at most once. */
export declare function once<F extends (...args: never[]) => unknown>(callback: F, options?: {
    preserveReturnValue?: boolean;
}): F;
/**
 * Node's `defineLazyProperties`: each key becomes a getter that loads the
 * named module on first read. `buffer.js` hangs `Blob`, `File` and
 * `resolveObjectURL` off its exports this way, so a program that never asks
 * for a Blob never loads one.
 */
export declare function defineLazyProperties(target: object, id: string, keys: string[], enumerable?: boolean): void;
/** Node's `lazyDOMException`: the realm's own, which every realm here has. */
export declare function lazyDOMException(message: string, name: string): Error;
/**
 * Node's `encodingsMap`: the number each encoding is to the buffer binding,
 * from `enum encoding` in `node_buffer.h`. Only `buffer.js` and the binding
 * exchange them.
 */
export declare const encodingsMap: Record<string, number>;
/** Node's `customInspectSymbol` and the symbol `Buffer.isEncoding` is marked with. */
export declare const customInspectSymbol: unique symbol;
export declare const kIsEncodingSymbol: unique symbol;
/** `internal/abort_controller`: the realm's own, which is the web's. */
export declare const internalAbortController: {
    AbortController: {
        new (): AbortController;
        prototype: AbortController;
    };
    AbortSignal: {
        new (): AbortSignal;
        prototype: AbortSignal;
        abort(reason?: any): AbortSignal;
        any(signals: AbortSignal[]): AbortSignal;
        timeout(milliseconds: number): AbortSignal;
    };
    aborted: (signal: AbortSignal) => boolean;
};
/**
 * `internal/blob` and `internal/file`: the realm's own `Blob` and `File`,
 * which every realm the engine runs in has. `resolveObjectURL` answers
 * nothing, because the engine registers no blob URLs of its own.
 * `createBlobFromFilePath` is the blob binding's, which `fs.openAsBlob` is.
 */
export declare const internalBlob: {
    Blob: {
        new (blobParts?: BlobPart[], options?: BlobPropertyBag): Blob;
        prototype: Blob;
    };
    isBlob: (value: unknown) => boolean;
    resolveObjectURL: () => undefined;
    createBlobFromFilePath: typeof createBlobFromFilePath;
};
export declare const internalFile: {
    File: unknown;
};
/**
 * `internal/webstreams/adapters`: what `Readable.toWeb`, `Readable.fromWeb`,
 * `Writable.toWeb`, `Writable.fromWeb` and the `Duplex` pair reach for.
 *
 * Node's own is pure JavaScript over Node's own `ReadableStream` and
 * `WritableStream`, which are themselves a port of the web's. A tab HAS the
 * web's, so this is the one place where the platform is the implementation
 * rather than a thing to port: each adapter is written against the realm's
 * `ReadableStream`/`WritableStream`, which is what a server bundle turning a
 * `node:http` request into a `Request` gets. The engine carried these same
 * six bodies as patches over its hand-written streams; they move here,
 * unchanged in behaviour, now that the streams above them are Node's.
 *
 * What is not here is what Node's adapters add on top: a byte-mode
 * `ReadableStream` with BYOB readers, and the `AbortSignal` options. Named,
 * not guessed at.
 */
type AnyStream = Record<string, (...args: never[]) => unknown> & Record<string, unknown>;
declare function newReadableStreamFromStreamReadable(readable: AnyStream): ReadableStream;
declare function newStreamReadableFromReadableStream(web: ReadableStream): AnyStream;
declare function newWritableStreamFromStreamWritable(writable: AnyStream): WritableStream;
declare function newStreamWritableFromWritableStream(web: WritableStream): AnyStream;
declare function newReadableWritablePairFromDuplex(duplex: AnyStream): {
    readable: ReadableStream;
    writable: WritableStream;
};
declare function newStreamDuplexFromReadableWritablePair(pair: {
    readable: ReadableStream;
    writable: WritableStream;
}): AnyStream;
export declare const internalWebStreamsAdapters: {
    newReadableStreamFromStreamReadable: typeof newReadableStreamFromStreamReadable;
    newStreamReadableFromReadableStream: typeof newStreamReadableFromReadableStream;
    newWritableStreamFromStreamWritable: typeof newWritableStreamFromStreamWritable;
    newStreamWritableFromWritableStream: typeof newStreamWritableFromWritableStream;
    newReadableWritablePairFromDuplex: typeof newReadableWritablePairFromDuplex;
    newStreamDuplexFromReadableWritablePair: typeof newStreamDuplexFromReadableWritablePair;
};
export {};
//# sourceMappingURL=buffer-and-streams.d.ts.map