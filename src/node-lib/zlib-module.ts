/**
 * `node:zlib` as the engine's own bundled dependencies import it (just-bash's `gzip`, `gunzip`, `zcat` and `rg`,
 * `vite.lib.config.js`): Node's own `zlib.js` of the realm's library graph, each export read on its first use, over
 * the `zlib` binding (ADR-0018 item 10). A realm the host gives no `node` program has no zlib, and an export's first
 * call there answers that it has none.
 */
import { lazyExport } from './lazy';
import { zlibModule } from './small-modules';

type Export = (...args: unknown[]) => unknown;
const of = (key: string): Export => lazyExport<Export>('zlib', key);

export const crc32 = of('crc32');
export const Deflate = of('Deflate');
export const Inflate = of('Inflate');
export const Gzip = of('Gzip');
export const Gunzip = of('Gunzip');
export const DeflateRaw = of('DeflateRaw');
export const InflateRaw = of('InflateRaw');
export const Unzip = of('Unzip');
export const BrotliCompress = of('BrotliCompress');
export const BrotliDecompress = of('BrotliDecompress');
export const ZstdCompress = of('ZstdCompress');
export const ZstdDecompress = of('ZstdDecompress');
export const deflate = of('deflate');
export const deflateSync = of('deflateSync');
export const gzip = of('gzip');
export const gzipSync = of('gzipSync');
export const deflateRaw = of('deflateRaw');
export const deflateRawSync = of('deflateRawSync');
export const unzip = of('unzip');
export const unzipSync = of('unzipSync');
export const inflate = of('inflate');
export const inflateSync = of('inflateSync');
export const gunzip = of('gunzip');
export const gunzipSync = of('gunzipSync');
export const inflateRaw = of('inflateRaw');
export const inflateRawSync = of('inflateRawSync');
export const brotliCompress = of('brotliCompress');
export const brotliCompressSync = of('brotliCompressSync');
export const brotliDecompress = of('brotliDecompress');
export const brotliDecompressSync = of('brotliDecompressSync');
export const zstdCompress = of('zstdCompress');
export const zstdCompressSync = of('zstdCompressSync');
export const zstdDecompress = of('zstdDecompress');
export const zstdDecompressSync = of('zstdDecompressSync');
export const createDeflate = of('createDeflate');
export const createInflate = of('createInflate');
export const createDeflateRaw = of('createDeflateRaw');
export const createInflateRaw = of('createInflateRaw');
export const createGzip = of('createGzip');
export const createGunzip = of('createGunzip');
export const createUnzip = of('createUnzip');
export const createBrotliCompress = of('createBrotliCompress');
export const createBrotliDecompress = of('createBrotliDecompress');
export const createZstdCompress = of('createZstdCompress');
export const createZstdDecompress = of('createZstdDecompress');
export const constants = lazyExport<Record<string, number>>('zlib', 'constants');
export const codes = lazyExport<Record<string, unknown>>('zlib', 'codes');

export default zlibModule;
