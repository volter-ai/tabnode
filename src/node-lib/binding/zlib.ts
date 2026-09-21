/**
 * `internalBinding('zlib')`: Node's own `zlib.js` over zlib's own algorithm.
 *
 * WHICH IMPLEMENTATION, AND WHY IT IS NOT A WASM BUILD. The engine's `zlib`
 * was a hand-written wrapper; Node's `zlib.js` wants a handle with an
 * `init`/`write`/`writeSync`/`params`/`reset` shape whose every call writes
 * into a buffer the CALLER owns, at the caller's offset, and reports back
 * how much input was left and how much of that buffer is still free. That is
 * zlib's `z_stream`, which is what Node's C++ binding drives.
 *
 * pako's public `Inflate`/`Deflate` cannot answer it, and this was measured
 * rather than assumed: given a caller's output buffer they write into it and
 * then, the instant it fills, REPLACE it with one of their own and carry on
 * consuming -- the whole input disappears into buffers the caller never sees,
 * and there is no per-call `avail_in` to re-enter with. That loop is the very
 * thing `zlib.js` exists to drive.
 *
 * pako's `lib/zlib/*` is the layer below that loop: zlib's own inflate and
 * deflate, ported line for line, taking a `z_stream` and honouring
 * `next_out`, `avail_out`, `next_in` and `avail_in` exactly as the C does. It
 * is the same interface Node's own binding sits on, so that is where this
 * binding sits.
 *
 * A wasm build of zlib would have been the closer mirror, as llhttp's was for
 * `http`, and there is none to vendor: no zlib wasm exists anywhere on this
 * box, npm's `zlib-wasm` is one maintainer, two versions, and depends on pako
 * itself, and compiling `deps/zlib` here would mean running a C toolchain,
 * which this product does not do. The row in FORK.md says the same.
 */
import { zstream, inflateModule, deflateModule, zlibConstants } from './zlib-pako';

/** Node's `zlib` modes, by the numbers `zlib.js` passes. */
const DEFLATE = 1;
const INFLATE = 2;
const GZIP = 3;
const GUNZIP = 4;
const DEFLATERAW = 5;
const INFLATERAW = 6;
const UNZIP = 7;

type ProcessCallback = () => void;

/**
 * One compression or decompression stream. Node makes one per `Gzip`,
 * `Inflate` and the rest, initializes it once, and then drives it a buffer at
 * a time until its input is gone.
 */
export class Zlib {
  #strm: Record<string, unknown> | null = null;
  #writeState: Uint32Array | null = null;
  #callback: ProcessCallback | null = null;
  #level = zlibConstants.Z_DEFAULT_COMPRESSION;
  #strategy = zlibConstants.Z_DEFAULT_STRATEGY;
  #windowBits = 15;
  #memLevel = 8;
  #dictionary: Uint8Array | undefined;
  #ended = false;
  /** `zlib.js` hangs its own error reporter here. */
  onerror: ((message: string, errno: number, code?: string) => void) | null = null;

  constructor(public readonly mode: number) {}

  get #inflating(): boolean {
    return this.mode === INFLATE || this.mode === GUNZIP || this.mode === INFLATERAW || this.mode === UNZIP;
  }

  /**
   * The window a mode asks for, in zlib's own encoding: a raw stream is a
   * negative window, gzip adds sixteen, and `unzip` -- which decides between
   * zlib and gzip by reading the header -- adds thirty-two.
   */
  #windowFor(windowBits: number): number {
    if (this.mode === DEFLATERAW || this.mode === INFLATERAW) return -windowBits;
    if (this.mode === GZIP || this.mode === GUNZIP) return windowBits + 16;
    if (this.mode === UNZIP) return windowBits + 32;
    return windowBits;
  }

  init(
    windowBits: number, level: number, memLevel: number, strategy: number,
    writeState: Uint32Array, processCallback: ProcessCallback, dictionary?: Uint8Array,
  ): void {
    this.#windowBits = windowBits;
    this.#level = level;
    this.#memLevel = memLevel;
    this.#strategy = strategy;
    this.#writeState = writeState;
    this.#callback = processCallback;
    this.#dictionary = dictionary;
    this.#start();
  }

  #start(): void {
    const strm = zstream();
    const window = this.#windowFor(this.#windowBits);
    const status = this.#inflating
      ? inflateModule.inflateInit2(strm, window)
      : deflateModule.deflateInit2(strm, this.#level, zlibConstants.Z_DEFLATED, window, this.#memLevel, this.#strategy);
    if (status !== zlibConstants.Z_OK) { this.#fail(status, strm); return; }
    if (this.#dictionary && this.#dictionary.length > 0 && !this.#inflating) {
      deflateModule.deflateSetDictionary(strm, this.#dictionary);
    }
    this.#strm = strm;
    this.#ended = false;
  }

  /** What zlib said went wrong, reported the way `zlib.js` reports it. */
  #fail(status: number, strm?: Record<string, unknown>): void {
    const message = (strm?.msg as string | undefined) ?? zlibConstants.messages[status] ?? 'zlib error';
    this.onerror?.(message, status, `Z_${status}`);
  }

  /** The shared pair `zlib.js` reads after every call: output free, input left. */
  #report(strm: Record<string, unknown>): void {
    const state = this.#writeState;
    if (!state) return;
    state[0] = strm.avail_out as number;
    state[1] = strm.avail_in as number;
  }

  #run(
    flush: number, inBuf: Uint8Array | null, inOff: number, inLen: number,
    outBuf: Uint8Array, outOff: number, outLen: number,
  ): void {
    const strm = this.#strm;
    if (!strm) { this.onerror?.('zlib: write after close', zlibConstants.Z_STREAM_ERROR); return; }
    strm.input = inBuf ?? new Uint8Array(0);
    strm.next_in = inOff;
    strm.avail_in = inLen;
    strm.output = outBuf;
    strm.next_out = outOff;
    strm.avail_out = outLen;
    const status = this.#inflating
      ? inflateModule.inflate(strm, flush)
      : deflateModule.deflate(strm, flush);
    if (status === zlibConstants.Z_NEED_DICT && this.#dictionary) {
      const dictStatus = inflateModule.inflateSetDictionary(strm, this.#dictionary);
      if (dictStatus === zlibConstants.Z_OK) {
        const again = inflateModule.inflate(strm, flush);
        if (again !== zlibConstants.Z_OK && again !== zlibConstants.Z_STREAM_END && again !== zlibConstants.Z_BUF_ERROR) {
          this.#fail(again, strm); return;
        }
        this.#report(strm);
        return;
      }
      this.#fail(dictStatus, strm);
      return;
    }
    // `Z_BUF_ERROR` is zlib saying it made no progress, which is an ordinary
    // answer when the caller's buffer is full or its input is spent; Node's
    // own binding treats it as one and asks again.
    if (status !== zlibConstants.Z_OK && status !== zlibConstants.Z_STREAM_END && status !== zlibConstants.Z_BUF_ERROR) {
      this.#fail(status, strm);
      return;
    }
    if (status === zlibConstants.Z_STREAM_END) this.#ended = true;
    this.#report(strm);
  }

  write(
    flush: number, inBuf: Uint8Array | null, inOff: number, inLen: number,
    outBuf: Uint8Array, outOff: number, outLen: number,
  ): this {
    // Node's own binding does this work on the thread pool and calls back;
    // a tab has one thread, so the work is done here and the callback is the
    // next tick, which is the difference a program can observe.
    const tick = (globalThis as { process?: { nextTick?: (fn: () => void) => void } }).process?.nextTick
      ?? ((fn: () => void) => { queueMicrotask(fn); });
    tick(() => {
      this.#run(flush, inBuf, inOff, inLen, outBuf, outOff, outLen);
      this.#callback?.();
    });
    return this;
  }

  writeSync(
    flush: number, inBuf: Uint8Array | null, inOff: number, inLen: number,
    outBuf: Uint8Array, outOff: number, outLen: number,
  ): this {
    this.#run(flush, inBuf, inOff, inLen, outBuf, outOff, outLen);
    return this;
  }

  /**
   * `deflateParams` mid-stream. pako's deflate does not carry it, so the
   * level and strategy are taken by starting the stream again -- which is
   * what zlib does when the two cannot be changed in place, and is only
   * reachable before any output has been produced.
   */
  params(level: number, strategy: number): void {
    this.#level = level;
    this.#strategy = strategy;
    if (!this.#inflating) { this.#end(); this.#start(); }
  }

  reset(): void {
    const strm = this.#strm;
    if (!strm) { this.#start(); return; }
    const status = this.#inflating ? inflateModule.inflateReset(strm) : deflateModule.deflateReset(strm);
    if (status !== zlibConstants.Z_OK) this.#fail(status, strm);
    this.#ended = false;
  }

  #end(): void {
    const strm = this.#strm;
    if (!strm) return;
    try { if (this.#inflating) inflateModule.inflateEnd(strm); else deflateModule.deflateEnd(strm); }
    catch { /* a stream already ended is ended */ }
    this.#strm = null;
  }

  close(): void { this.#end(); this.#callback = null; this.#writeState = null; }

  /** Node asks a handle for these two after a `Z_STREAM_END`. */
  get ended(): boolean { return this.#ended; }
}

/**
 * The codecs this engine does not carry, refused by name.
 *
 * Node's own `zlib.js` exports `BrotliCompress`, `ZstdCompress` and their
 * families whatever the build has, and each one reaches for a constructor on
 * this binding. Without these a program got `binding.ZstdCompress is not a
 * constructor`, which says nothing about why; with them it is told what is
 * missing and what the engine does carry. This is the same refusal the
 * engine gives for `dgram` or `http2`: a door that states its own absence.
 */
function absentCodec(name: string, reason: string): new (...args: unknown[]) => never {
  return class AbsentCodec {
    constructor() {
      throw Object.assign(
        new Error(`zlib: ${name} is not in this engine. ${reason}`),
        { code: 'ERR_NOT_IMPLEMENTED' },
      );
    }
  } as unknown as new (...args: unknown[]) => never;
}

const BROTLI_REASON =
  'Brotli is a codec of its own, not zlib; the engine has a wasm build of it as a dependency ' +
  'but no binding for Node\'s Brotli handle yet. `zlib.gzip`, `deflate` and `inflate` are Node\'s own here.';
const ZSTD_REASON =
  'Zstandard is a codec of its own and this engine has no implementation of it at all. ' +
  '`zlib.gzip`, `deflate` and `inflate` are Node\'s own here.';

export const zlibBinding = {
  Zlib,
  BrotliEncoder: absentCodec('Brotli compression', BROTLI_REASON),
  BrotliDecoder: absentCodec('Brotli decompression', BROTLI_REASON),
  ZstdCompress: absentCodec('Zstandard compression', ZSTD_REASON),
  ZstdDecompress: absentCodec('Zstandard decompression', ZSTD_REASON),
  /** `zlib.crc32`, which is zlib's own table-driven one. */
  crc32: (data: Uint8Array | string, value = 0): number => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return zlibConstants.crc32(value, bytes, bytes.length, 0) >>> 0;
  },
};

export default zlibBinding;
