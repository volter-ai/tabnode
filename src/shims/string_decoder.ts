/**
 * Node's `string_decoder`, which is Node's own `lib/string_decoder.js`.
 *
 * The engine had a hand-written stub built in `runtime.ts`: it decoded each
 * chunk on its own, so a multi-byte character split across two chunks came out
 * as two replacement characters. Every protocol VS Code's workbench speaks to
 * its extension host is UTF-8 over a socket, and a message that happened to be
 * cut inside a character was corrupted; `Readable.setEncoding` had nothing to
 * decode with at all.
 *
 * The method is Node's, transcribed over the engine's `Buffer`: a decoder holds
 * back the bytes of an incomplete sequence in `lastChar` and completes it with
 * the head of the next chunk. `lastChar`, `lastNeed` and `lastTotal` are Node's
 * own undocumented fields, which Node's test reads.
 *
 * Two departures from `lib/string_decoder.js`, both named where they are: the
 * held-back bytes are in a zeroed buffer rather than an uninitialised one, and
 * a string too long for V8 is refused by the input's size rather than by
 * building the string and failing.
 */

import { loadNodeLib } from '../node-lib/load';

/**
 * Node's `Buffer`, read when a decoder is first used rather than when this
 * module is evaluated. `buffer` is a vendored Node file that `node-lib`'s
 * loader builds, and this shim is one of the public modules that loader
 * resolves: taking the class at import time makes the two wait on each other
 * and neither loads at all.
 */
interface BufferClass {
  isBuffer(value: unknown): boolean;
  from(value: unknown, offset?: unknown, length?: number): Buffer;
  alloc(size: number): Buffer;
}
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_THIS,
  ERR_STRING_TOO_LONG,
  ERR_UNKNOWN_ENCODING,
} from '../node-internals';

/** V8's longest string, which Node reports as ERR_STRING_TOO_LONG. */
const kStringMaxLength = 0x1fffffe8;
/** A marker the constructor leaves, so a prototype method knows its `this`. */
const kIsStringDecoder = Symbol('kIsStringDecoder');

export interface StringDecoder {
  encoding: string;
  lastChar: Buffer;
  lastNeed: number;
  lastTotal: number;
  write(buffer: unknown): string;
  end(buffer?: unknown): string;
  text(buffer: Buffer, offset: number): string;
  fillLast(buffer: Buffer): string | undefined;
}

interface StringDecoderConstructor {
  new (encoding?: string): StringDecoder;
  (this: unknown, encoding?: string): void;
  prototype: StringDecoder;
}

/** A decoder's constructors and held bytes belong to one builtin graph. */
export function createStringDecoderModule(Bytes: () => BufferClass) {
/** lib/internal/util.js normalizeEncoding, with Node's aliases. */
const kEncodingAliases: Record<string, string> = {
  utf8: 'utf8', 'utf-8': 'utf8',
  ucs2: 'utf16le', 'ucs-2': 'utf16le', utf16le: 'utf16le', 'utf-16le': 'utf16le',
  latin1: 'latin1', binary: 'latin1',
  base64: 'base64', base64url: 'base64url',
  ascii: 'ascii',
  hex: 'hex',
};

function normalizeEncoding(encoding: unknown): string {
  if (encoding === undefined || encoding === null || encoding === '') return 'utf8';
  if (typeof encoding !== 'string') throw new ERR_UNKNOWN_ENCODING(encoding);
  const normalized = kEncodingAliases[encoding.toLowerCase()];
  if (normalized === undefined) throw new ERR_UNKNOWN_ENCODING(encoding);
  return normalized;
}

/** The most characters one byte can decode to, per encoding. */
const kCharsPerByte: Record<string, number> = {
  utf8: 1, utf16le: 0.5, latin1: 1, ascii: 1, hex: 2, base64: 2, base64url: 2,
};

/**
 * Node's decoder takes a Buffer, a TypedArray of any width or a DataView, and
 * refuses everything else. The engine works over the bytes either way.
 */
function decoderInput(self: StringDecoder, buffer: unknown): Buffer {
  let bytes: Buffer;
  if (Bytes().isBuffer(buffer)) {
    bytes = buffer as Buffer;
  } else if (ArrayBuffer.isView(buffer)) {
    const view = buffer as ArrayBufferView;
    bytes = Bytes().from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  } else {
    throw new ERR_INVALID_ARG_TYPE('buf', ['Buffer', 'TypedArray', 'DataView'], buffer);
  }
  // Node builds the string and lets V8 refuse it; the engine asks first, from
  // the widest a byte can decode to, so the refusal costs nothing.
  const charsPerByte = kCharsPerByte[self.encoding] ?? 1;
  if (bytes.length * charsPerByte > kStringMaxLength) throw new ERR_STRING_TOO_LONG(kStringMaxLength);
  return bytes;
}

function assertDecoder(self: unknown): StringDecoder {
  if (!self || !(self as Record<symbol, unknown>)[kIsStringDecoder]) {
    throw new ERR_INVALID_THIS('StringDecoder');
  }
  return self as StringDecoder;
}

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

/** The width a UTF-8 byte leads: 0 for ASCII, -1 continuation, -2 invalid. */
function utf8CheckByte(byte: number): number {
  if (byte <= 0x7f) return 0;
  if (byte >> 5 === 0x06) return 2;
  if (byte >> 4 === 0x0e) return 3;
  if (byte >> 3 === 0x1e) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
}

/** The last three bytes of a chunk, for a character the chunk cut in half. */
function utf8CheckIncomplete(self: StringDecoder, buf: Buffer, i: number): number {
  let j = buf.length - 1;
  if (j < i) return 0;
  let nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;
      else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

/**
 * A continuation byte where one is due, or V8's replacement character for the
 * bytes already taken. The check is written out three times, as Node writes it.
 */
function utf8CheckExtraBytes(self: StringDecoder, buf: Buffer, p: number): string | undefined {
  if ((buf[0] & 0xc0) !== 0x80) {
    self.lastNeed = 0;
    return utf8BrokenSequence(self, buf, p, 0);
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xc0) !== 0x80) {
      self.lastNeed = 1;
      return utf8BrokenSequence(self, buf, p, 1);
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xc0) !== 0x80) {
        self.lastNeed = 2;
        return utf8BrokenSequence(self, buf, p, 2);
      }
    }
  }
  return undefined;
}

/**
 * What a broken multi-byte sequence decodes to: the `p` bytes held back plus
 * the `taken` continuation bytes that were good, handed to the platform's own
 * UTF-8 decoder. V8 emits one replacement character per maximal ill-formed
 * subpart, not one per byte -- `F0 B8` then `41` is one (F0 B8 is a good
 * prefix), while `F6 9B` then `D1` is two (F6 leads nothing, 9B is stray) --
 * so the count is read off a decode rather than guessed from a length.
 */
function utf8BrokenSequence(self: StringDecoder, buf: Buffer, p: number, taken: number): string {
  const bytes = Bytes().alloc(p + taken) as unknown as Buffer;
  self.lastChar.copy(bytes, 0, 0, p);
  if (taken > 0) buf.copy(bytes, p, 0, taken);
  return bytes.toString('utf8');
}

function utf8FillLast(this: StringDecoder, buf: Buffer): string | undefined {
  const p = this.lastTotal - this.lastNeed;
  // One replacement character per byte of the broken sequence already taken.
  const r = utf8CheckExtraBytes(this, buf, p);
  if (r !== undefined) return r;
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, p, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding as BufferEncoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, p, 0, buf.length);
  this.lastNeed -= buf.length;
  return undefined;
}

function utf8Text(this: StringDecoder, buf: Buffer, i: number): string {
  const total = utf8CheckIncomplete(this, buf, i);
  if (!this.lastNeed) return buf.toString('utf8', i);
  this.lastTotal = total;
  const end = buf.length - (total - this.lastNeed);
  buf.copy(this.lastChar, 0, end);
  return buf.toString('utf8', i, end);
}

function utf8End(this: StringDecoder, buf?: unknown): string {
  const r = buf !== undefined && buf !== null && (buf as Buffer).length ? this.write(buf) : '';
  // Node's native decoder flushes its held-back bytes and forgets them, so a
  // decoder reused after end() starts clean; the pure-JS file it came from did
  // not, and the next write carried the last stream's broken tail into it.
  // What the flush says is the decode of those bytes, not one replacement
  // character: `F6 9B` left over is two, `E1 8B` is one, and the pure-JS file
  // answered one for both, so a chunked decode and a whole-buffer decode of the
  // same bytes disagreed.
  if (this.lastNeed) {
    const held = this.lastTotal - this.lastNeed;
    this.lastNeed = 0;
    this.lastTotal = 0;
    return r + this.lastChar.toString('utf8', 0, held);
  }
  return r;
}

// ---------------------------------------------------------------------------
// UTF-16LE
// ---------------------------------------------------------------------------

function utf16Text(this: StringDecoder, buf: Buffer, i: number): string {
  if ((buf.length - i) % 2 === 0) {
    const r = buf.toString('utf16le', i);
    if (r) {
      const c = r.charCodeAt(r.length - 1);
      // A lead surrogate at the end is half a character: its two bytes wait.
      if (c >= 0xd800 && c <= 0xdbff) {
        this.lastNeed = 2;
        this.lastTotal = 4;
        this.lastChar[0] = buf[buf.length - 2];
        this.lastChar[1] = buf[buf.length - 1];
        return r.slice(0, -1);
      }
    }
    return r;
  }
  this.lastNeed = 1;
  this.lastTotal = 2;
  this.lastChar[0] = buf[buf.length - 1];
  return buf.toString('utf16le', i, buf.length - 1);
}

function utf16End(this: StringDecoder, buf?: unknown): string {
  const r = buf !== undefined && buf !== null && (buf as Buffer).length ? this.write(buf) : '';
  if (this.lastNeed) {
    const end = this.lastTotal - this.lastNeed;
    this.lastNeed = 0;
    this.lastTotal = 0;
    return r + this.lastChar.toString('utf16le', 0, end);
  }
  return r;
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

function base64Text(this: StringDecoder, buf: Buffer, i: number): string {
  const n = (buf.length - i) % 3;
  // The decoder's own encoding, not 'base64': base64url writes no padding.
  const enc = this.encoding as BufferEncoding;
  if (n === 0) return buf.toString(enc, i);
  this.lastNeed = 3 - n;
  this.lastTotal = 3;
  if (n === 1) {
    this.lastChar[0] = buf[buf.length - 1];
  } else {
    this.lastChar[0] = buf[buf.length - 2];
    this.lastChar[1] = buf[buf.length - 1];
  }
  return buf.toString(enc, i, buf.length - n);
}

function base64End(this: StringDecoder, buf?: unknown): string {
  const r = buf !== undefined && buf !== null && (buf as Buffer).length ? this.write(buf) : '';
  if (this.lastNeed) {
    const taken = 3 - this.lastNeed;
    this.lastNeed = 0;
    this.lastTotal = 0;
    return r + this.lastChar.toString(this.encoding as BufferEncoding, 0, taken);
  }
  return r;
}

// ---------------------------------------------------------------------------
// One byte per character: nothing is ever held back.
// ---------------------------------------------------------------------------

function simpleWrite(this: StringDecoder, buf: unknown): string {
  return decoderInput(this, buf).toString(this.encoding as BufferEncoding);
}

function simpleEnd(this: StringDecoder, buf?: unknown): string {
  return buf !== undefined && buf !== null && (buf as Buffer).length ? this.write(buf) : '';
}

// ---------------------------------------------------------------------------

function StringDecoderImpl(this: StringDecoder, encoding?: string): void {
  this.encoding = normalizeEncoding(encoding);
  Object.defineProperty(this, kIsStringDecoder, { value: true, enumerable: false });
  let nb: number;
  switch (this.encoding) {
    case 'utf16le':
      this.text = utf16Text;
      this.end = utf16End;
      nb = 4;
      break;
    case 'utf8':
      this.fillLast = utf8FillLast;
      nb = 4;
      break;
    case 'base64':
    case 'base64url':
      this.text = base64Text;
      this.end = base64End;
      nb = 3;
      break;
    default:
      this.write = simpleWrite;
      this.end = simpleEnd;
      return;
  }
  this.lastNeed = 0;
  this.lastTotal = 0;
  // Node's `Buffer.allocUnsafe(nb)`. Zeroed here, because Node's own test reads
  // the bytes of `lastChar` that no write has reached yet and expects zeros.
  this.lastChar = Bytes().alloc(nb) as unknown as Buffer;
}

const decoderPrototype = StringDecoderImpl.prototype as unknown as StringDecoder;

decoderPrototype.write = function write(this: unknown, buffer: unknown): string {
  const self = assertDecoder(this);
  const buf = decoderInput(self, buffer);
  if (buf.length === 0) return '';
  let r: string | undefined;
  let i: number;
  if (self.lastNeed) {
    r = self.fillLast(buf);
    if (r === undefined) return '';
    i = self.lastNeed;
    self.lastNeed = 0;
  } else {
    i = 0;
  }
  if (i < buf.length) return r ? r + self.text(buf, i) : self.text(buf, i);
  return r || '';
};

decoderPrototype.end = function end(this: unknown, buffer?: unknown): string {
  return utf8End.call(assertDecoder(this), buffer);
};

decoderPrototype.text = function text(this: unknown, buffer: Buffer, offset: number): string {
  return utf8Text.call(assertDecoder(this), buffer, offset);
};

/** Node's generic fillLast, for every encoding but UTF-8, which has its own. */
decoderPrototype.fillLast = function fillLast(this: unknown, buf: Buffer): string | undefined {
  const self = assertDecoder(this);
  if (self.lastNeed <= buf.length) {
    buf.copy(self.lastChar, self.lastTotal - self.lastNeed, 0, self.lastNeed);
    return self.lastChar.toString(self.encoding as BufferEncoding, 0, self.lastTotal);
  }
  buf.copy(self.lastChar, self.lastTotal - self.lastNeed, 0, buf.length);
  self.lastNeed -= buf.length;
  return undefined;
};

const StringDecoder = StringDecoderImpl as unknown as StringDecoderConstructor;

return { StringDecoder };

}
let bufferClass: BufferClass | undefined;
const decoder = createStringDecoderModule(() => bufferClass ??= (loadNodeLib('buffer') as { Buffer: BufferClass }).Buffer);
export const StringDecoder = decoder.StringDecoder;
export default decoder;
