/**
 * zlib's own inflate and deflate, as pako ports them.
 *
 * pako is already the engine's dependency, and `pako/lib/zlib/*` is not
 * pako's convenience API -- it is zlib's `inflate.c` and `deflate.c` ported
 * line for line, taking a `z_stream` and honouring `next_in`, `avail_in`,
 * `next_out` and `avail_out` exactly as the C does. `./zlib.ts` says why the
 * binding sits at this layer and not on pako's `Inflate`/`Deflate`, which
 * cannot answer Node's contract.
 */
import ZStream from 'pako/lib/zlib/zstream.js';
import * as pakoInflate from 'pako/lib/zlib/inflate.js';
import * as pakoDeflate from 'pako/lib/zlib/deflate.js';
import pakoConstants from 'pako/lib/zlib/constants.js';
import pakoCrc32 from 'pako/lib/zlib/crc32.js';
import pakoMessages from 'pako/lib/zlib/messages.js';

/** A fresh `z_stream`, the object every call below reads and writes. */
export function zstream(): Record<string, unknown> {
  return new (ZStream as unknown as new () => Record<string, unknown>)();
}

export const inflateModule = pakoInflate as unknown as {
  inflateInit2(strm: unknown, windowBits: number): number;
  inflate(strm: unknown, flush: number): number;
  inflateEnd(strm: unknown): number;
  inflateReset(strm: unknown): number;
  inflateSetDictionary(strm: unknown, dictionary: Uint8Array): number;
};

export const deflateModule = pakoDeflate as unknown as {
  deflateInit2(strm: unknown, level: number, method: number, windowBits: number, memLevel: number, strategy: number): number;
  deflate(strm: unknown, flush: number): number;
  deflateEnd(strm: unknown): number;
  deflateReset(strm: unknown): number;
  deflateSetDictionary(strm: unknown, dictionary: Uint8Array): number;
};

/** zlib's constants and its own error text, beside the checksum it defines. */
export const zlibConstants: Record<string, number> & {
  messages: Record<number, string>;
  crc32: (crc: number, buffer: Uint8Array, length: number, position: number) => number;
} = {
  ...(pakoConstants as unknown as Record<string, number>),
  messages: pakoMessages as unknown as Record<number, string>,
  crc32: pakoCrc32 as unknown as (crc: number, buffer: Uint8Array, length: number, position: number) => number,
} as Record<string, number> & {
  messages: Record<number, string>;
  crc32: (crc: number, buffer: Uint8Array, length: number, position: number) => number;
};
