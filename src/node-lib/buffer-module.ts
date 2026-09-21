/**
 * `buffer`, as Node's own `lib/buffer.js`.
 *
 * What died: the engine's `Buffer` was hand-written inside `shims/stream.ts`,
 * a `Uint8Array` subclass with the methods one program after another turned
 * out to need. Node's own `test-buffer-*`: 15 of 64 passed.
 *
 * What this is: Node's `lib/buffer.js` and `lib/internal/buffer.js`
 * v22.18.0, vendored unmodified, on the binding in `./binding/buffer.ts` --
 * encode, decode, compare, search, fill, copy, swap, over `TextEncoder`,
 * `TextDecoder` and the realm's own base64, and nothing above it. `alloc`,
 * `concat`, `toString`, `write`, `readInt32BE` and the rest are Node's own
 * code.
 *
 * The rule for this file: it binds, it does not implement.
 */
import { lazyModule, lazyExport } from './lazy';

/** Node's `Buffer`, as the engine's own parts use it. */
export interface BufferConstructor {
  new (size: number): NodeBuffer;
  from(value: unknown, encodingOrOffset?: unknown, length?: number): NodeBuffer;
  alloc(size: number, fill?: unknown, encoding?: string): NodeBuffer;
  allocUnsafe(size: number): NodeBuffer;
  allocUnsafeSlow(size: number): NodeBuffer;
  concat(list: readonly Uint8Array[], totalLength?: number): NodeBuffer;
  isBuffer(value: unknown): boolean;
  isEncoding(encoding: string): boolean;
  byteLength(value: unknown, encoding?: string): number;
  compare(a: Uint8Array, b: Uint8Array): number;
  poolSize: number;
  prototype: NodeBuffer;
}

/** The whole of Node's `buffer` module object. */
export interface BufferModule {
  Buffer: BufferConstructor;
  SlowBuffer: (size: number) => Uint8Array;
  kMaxLength: number;
  kStringMaxLength: number;
  INSPECT_MAX_BYTES: number;
  constants: { MAX_LENGTH: number; MAX_STRING_LENGTH: number };
  atob(input: string): string;
  btoa(input: string): string;
  isUtf8(value: Uint8Array): boolean;
  isAscii(value: Uint8Array): boolean;
  transcode?: (source: Uint8Array, from: string, to: string) => Uint8Array;
  Blob: unknown;
  File: unknown;
  resolveObjectURL: unknown;
}

/** Node's own `buffer.js`, built by the loader on the first property read. */
export const bufferModule = lazyModule<BufferModule>('buffer');

/**
 * Node's `Buffer`, which is the one every part of the engine uses. The type
 * is `Uint8Array` with Node's own methods on it: TypeScript's `Buffer` comes
 * from `@types/node` and describes the host's, not this one.
 */
/**
 * The type of one of these buffers. At runtime it is Node's own `Buffer`, so
 * the type is the one `@types/node` describes: every part of the engine was
 * written against that name and means this object by it.
 */
export type NodeBuffer = Buffer;

export const Buffer = lazyExport<BufferConstructor>('buffer', 'Buffer');

export default bufferModule;
