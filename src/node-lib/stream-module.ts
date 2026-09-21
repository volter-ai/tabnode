/**
 * `stream`, as Node's own `lib/stream.js`.
 *
 * What died: the engine's streams were hand-written, 2,281 lines inside
 * `shims/stream.ts`, an imitation of `Readable`, `Writable`, `Duplex` and
 * `Transform` that lane A had already had to patch so `net.js` could run on
 * it. Node's own `test-stream-*`: 70 of 171 passed.
 *
 * What this is: Node's `lib/stream.js`, `lib/stream/promises.js` and all of
 * `lib/internal/streams/*.js` v22.18.0, vendored unmodified. There is no
 * binding underneath: Node's streams are pure JavaScript over `events`,
 * `buffer` and `string_decoder`, which is why this module is only a loader.
 *
 * The rule for this file: it binds, it does not implement. A stream bug is
 * fixed by moving the vendored files to a newer Node, never by editing them.
 */
import { lazyModule, lazyExport } from './lazy';

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

export interface DuplexLike extends ReadableLike, WritableLike {}

/** Node's own `stream.js`, built by the loader on the first property read. */
export const streamModule = lazyModule<StreamModule>('stream');

/**
 * The classes, and the names the engine's own code uses as TYPES for them:
 * a stream a shim holds is "a Readable", whatever Node's own class is.
 */
export type Readable = ReadableLike;
export type Writable = WritableLike;
export type Duplex = DuplexLike;
export type Transform = DuplexLike;
export type PassThrough = DuplexLike;

export const Stream = lazyExport<StreamModule['Stream']>('stream', 'Stream');
export const Readable = lazyExport<StreamModule['Readable']>('stream', 'Readable');
export const Writable = lazyExport<StreamModule['Writable']>('stream', 'Writable');
export const Duplex = lazyExport<StreamModule['Duplex']>('stream', 'Duplex');
export const Transform = lazyExport<StreamModule['Transform']>('stream', 'Transform');
export const PassThrough = lazyExport<StreamModule['PassThrough']>('stream', 'PassThrough');
export const pipeline = lazyExport<StreamModule['pipeline']>('stream', 'pipeline');
export const finished = lazyExport<StreamModule['finished']>('stream', 'finished');
export const promises = lazyModule<Record<string, unknown>>('stream/promises');

/** The promise form of `pipeline` and `finished`, as `stream/promises`. */
export const streamPromisesModule = lazyModule<Record<string, unknown>>('stream/promises');

/** Node's `stream` module object IS the `Stream` class, as `stream.js` exports it. */
export default streamModule;
