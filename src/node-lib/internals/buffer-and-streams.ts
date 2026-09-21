/**
 * The internals Node's `buffer` and `stream` name that neither `net` nor
 * `child_process` did.
 *
 * Each object holds exactly the names the vendored files destructure from it.
 * Where a name stands for something a tab cannot have -- a web-stream
 * adapter, ICU's transcoder -- it refuses and says so at the site, rather
 * than answering with something that is not it.
 */
import { libRequire } from '../require-hook';
import { createBlobFromFilePath } from '../binding/blob';

/** Node's `once(fn)`: the same function, run at most once. */
export function once<F extends (...args: never[]) => unknown>(
  callback: F, options?: { preserveReturnValue?: boolean },
): F {
  let called = false;
  let returned: unknown;
  function ran(this: unknown, ...args: never[]): unknown {
    if (called) return returned;
    called = true;
    const result = Reflect.apply(callback, this, args);
    returned = options?.preserveReturnValue === true ? result : undefined;
    return result;
  }
  return ran as unknown as F;
}

/**
 * Node's `defineLazyProperties`: each key becomes a getter that loads the
 * named module on first read. `buffer.js` hangs `Blob`, `File` and
 * `resolveObjectURL` off its exports this way, so a program that never asks
 * for a Blob never loads one.
 */
export function defineLazyProperties(target: object, id: string, keys: string[], enumerable = true): void {
  const descriptors: PropertyDescriptorMap = {};
  let module: Record<string, unknown> | undefined;
  for (const key of keys) {
    let value: unknown;
    let loaded = false;
    descriptors[key] = {
      configurable: true,
      enumerable,
      get(): unknown {
        if (!loaded) {
          module ??= libRequire(id) as Record<string, unknown>;
          value = module[key];
          loaded = true;
        }
        return value;
      },
      set(next: unknown): void { value = next; loaded = true; },
    };
  }
  Object.defineProperties(target, descriptors);
}

/** Node's `lazyDOMException`: the realm's own, which every realm here has. */
export function lazyDOMException(message: string, name: string): Error {
  const Exception = (globalThis as unknown as { DOMException?: new (m: string, n: string) => Error }).DOMException;
  if (typeof Exception === 'function') return new Exception(message, name);
  return Object.assign(new Error(message), { name });
}

/**
 * Node's `encodingsMap`: the number each encoding is to the buffer binding,
 * from `enum encoding` in `node_buffer.h`. Only `buffer.js` and the binding
 * exchange them.
 */
export const encodingsMap: Record<string, number> = {
  ascii: 0, utf8: 1, 'utf-8': 1, base64: 2, ucs2: 3, 'ucs-2': 3,
  utf16le: 3, 'utf-16le': 3, binary: 4, latin1: 4, hex: 5, buffer: 6, base64url: 7,
};

/** Node's `customInspectSymbol` and the symbol `Buffer.isEncoding` is marked with. */
export const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
export const kIsEncodingSymbol = Symbol('kIsEncodingSymbol');

/** `internal/abort_controller`: the realm's own, which is the web's. */
export const internalAbortController = {
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  aborted: (signal: AbortSignal): boolean => signal.aborted,
};

/**
 * `internal/blob` and `internal/file`: the realm's own `Blob` and `File`,
 * which every realm the engine runs in has. `resolveObjectURL` answers
 * nothing, because the engine registers no blob URLs of its own.
 * `createBlobFromFilePath` is the blob binding's, which `fs.openAsBlob` is.
 */
export const internalBlob = {
  Blob: globalThis.Blob,
  isBlob: (value: unknown): boolean => typeof Blob === 'function' && value instanceof Blob,
  resolveObjectURL: (): undefined => undefined,
  createBlobFromFilePath,
};
export const internalFile = {
  File: (globalThis as unknown as { File?: unknown }).File,
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

function streamModule(): Record<string, new (options?: unknown) => AnyStream> {
  return libRequire('stream') as Record<string, new (options?: unknown) => AnyStream>;
}

function newReadableStreamFromStreamReadable(readable: AnyStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      (readable.on as (e: string, l: (v: unknown) => void) => void)('data', (chunk) => {
        controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer_from(chunk)));
      });
      (readable.on as (e: string, l: () => void) => void)('end', () => { try { controller.close(); } catch { /* a stream closed twice is closed */ } });
      (readable.on as (e: string, l: (v: unknown) => void) => void)('error', (error) => { try { controller.error(error); } catch { /* likewise */ } });
    },
    cancel() { (readable.destroy as () => void)(); },
  });
}

/** The bytes of a chunk that is not already one, without importing `buffer` at load. */
function Buffer_from(chunk: unknown): Uint8Array {
  const { Buffer } = libRequire('buffer') as { Buffer: { from(value: unknown): Uint8Array } };
  return Buffer.from(chunk);
}

function newStreamReadableFromReadableStream(web: ReadableStream): AnyStream {
  const { Readable } = streamModule() as unknown as { Readable: { from(source: unknown): AnyStream } };
  return Readable.from({
    [Symbol.asyncIterator]() {
      const reader = web.getReader();
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          const step = await reader.read();
          return step.done ? { value: undefined, done: true } : { value: step.value, done: false };
        },
        async return(value: unknown) { await reader.cancel(); return { value, done: true }; },
      };
    },
  });
}

function newWritableStreamFromStreamWritable(writable: AnyStream): WritableStream {
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        (writable.write as (c: unknown, cb: (e: unknown) => void) => void)(chunk, (error) => (error ? reject(error as Error) : resolve()));
      });
    },
    close() { return new Promise<void>((resolve) => { (writable.end as (cb: () => void) => void)(resolve); }); },
    abort(reason) { (writable.destroy as (e?: Error) => void)(reason instanceof Error ? reason : undefined); },
  });
}

function newStreamWritableFromWritableStream(web: WritableStream): AnyStream {
  const { Writable } = streamModule() as unknown as { Writable: new (options: unknown) => AnyStream };
  const writer = web.getWriter();
  return new Writable({
    write(chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void) {
      writer.write(chunk instanceof Uint8Array ? chunk : Buffer_from(chunk)).then(() => callback(null), callback);
    },
    final(callback: (error?: Error | null) => void) {
      writer.close().then(() => callback(null), callback);
    },
    destroy(error: Error | null, callback: (error?: Error | null) => void) {
      writer.abort(error ?? undefined).then(() => callback(error), callback);
    },
  });
}

function newReadableWritablePairFromDuplex(duplex: AnyStream): { readable: ReadableStream; writable: WritableStream } {
  return {
    readable: newReadableStreamFromStreamReadable(duplex),
    writable: newWritableStreamFromStreamWritable(duplex),
  };
}

function newStreamDuplexFromReadableWritablePair(pair: { readable: ReadableStream; writable: WritableStream }): AnyStream {
  const { Duplex } = streamModule() as unknown as { Duplex: new (options: unknown) => AnyStream };
  const writer = pair.writable.getWriter();
  const reader = pair.readable.getReader();
  const duplex: AnyStream = new Duplex({
    read() {
      reader.read().then(
        (step) => { (duplex.push as (c: unknown) => void)(step.done ? null : step.value); },
        (error: Error) => { (duplex.destroy as (e: Error) => void)(error); },
      );
    },
    write(chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void) {
      writer.write(chunk instanceof Uint8Array ? chunk : Buffer_from(chunk)).then(() => callback(null), callback);
    },
    final(callback: (error?: Error | null) => void) {
      writer.close().then(() => callback(null), callback);
    },
  });
  return duplex;
}

export const internalWebStreamsAdapters = {
  newReadableStreamFromStreamReadable,
  newStreamReadableFromReadableStream,
  newWritableStreamFromStreamWritable,
  newStreamWritableFromWritableStream,
  newReadableWritablePairFromDuplex,
  newStreamDuplexFromReadableWritablePair,
};
