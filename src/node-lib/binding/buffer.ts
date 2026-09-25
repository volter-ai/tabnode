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
export const kMaxLength = 4294967296 - 1;
export const kStringMaxLength = 536870888;

/**
 * Node's encoding numbers, from `enum encoding` in `node_buffer.h`. They are
 * private to this binding and `internal/util`'s `encodingsMap`, which is the
 * only thing that hands them over.
 */
export const ASCII = 0;
export const UTF8 = 1;
export const BASE64 = 2;
export const UCS2 = 3;
export const LATIN1 = 4;
export const HEX = 5;
export const BUFFER = 6;
export const BASE64URL = 7;

const encoder = new TextEncoder();
/** A decoder per flavour: `fatal: false` is what Node's lossy decode is. */
const utf8Decoder = new TextDecoder('utf-8');
const latin1Decoder = new TextDecoder('latin1');
const ucs2Decoder = new TextDecoder('utf-16le');

const HEX_DIGITS = '0123456789abcdef';

function asBytes(value: Uint8Array): Uint8Array {
  return value;
}

/** libuv's `uv_buf` clamp: a range inside the buffer, in order. */
function clamp(buffer: Uint8Array, start: number, end: number): [number, number] {
  const length = buffer.length;
  let from = start === undefined || Number.isNaN(start) ? 0 : Math.trunc(start);
  let to = end === undefined || Number.isNaN(end) ? length : Math.trunc(end);
  if (from < 0) from = 0;
  if (to > length) to = length;
  if (to < from) to = from;
  return [from, to];
}

// ── Encoding a string into a buffer ────────────────────────────────────────

/** Node's `StringWrite<UTF8>`: as many whole code points as fit. */
export function utf8WriteStatic(buf: Uint8Array, string: string, offset = 0, length = buf.byteLength - offset): number {
  const room = Math.min(length, buf.byteLength - offset);
  if (room <= 0) return 0;
  const { written } = encoder.encodeInto(string, buf.subarray(offset, offset + room));
  return written ?? 0;
}

/** Node's `StringWrite<ASCII>`: the low seven bits of each unit, one byte each. */
export function asciiWriteStatic(buf: Uint8Array, string: string, offset = 0, length = buf.byteLength - offset): number {
  const room = Math.min(length, buf.byteLength - offset, string.length);
  for (let index = 0; index < room; index += 1) buf[offset + index] = string.charCodeAt(index) & 0x7f;
  return room < 0 ? 0 : room;
}

/** Node's `StringWrite<LATIN1>`: the low eight bits of each unit. */
export function latin1WriteStatic(buf: Uint8Array, string: string, offset = 0, length = buf.byteLength - offset): number {
  const room = Math.min(length, buf.byteLength - offset, string.length);
  for (let index = 0; index < room; index += 1) buf[offset + index] = string.charCodeAt(index) & 0xff;
  return room < 0 ? 0 : room;
}

/** Node's `StringWrite<UCS2>`: whole 16-bit units, little-endian. */
export function ucs2Write(this: Uint8Array, string: string, offset = 0, length = this.byteLength - offset): number {
  const room = Math.min(length, this.byteLength - offset);
  const units = Math.min(string.length, Math.floor(room / 2));
  for (let index = 0; index < units; index += 1) {
    const code = string.charCodeAt(index);
    this[offset + index * 2] = code & 0xff;
    this[offset + index * 2 + 1] = code >>> 8;
  }
  return units * 2;
}

/** Node's `StringWrite<HEX>`: whole byte pairs, stopping at the first that is not one. */
export function hexWrite(this: Uint8Array, string: string, offset = 0, length = this.byteLength - offset): number {
  const room = Math.min(length, this.byteLength - offset);
  const pairs = Math.min(Math.floor(string.length / 2), room);
  let written = 0;
  for (let index = 0; index < pairs; index += 1) {
    const high = hexValue(string.charCodeAt(index * 2));
    const low = hexValue(string.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0) break;
    this[offset + index] = (high << 4) | low;
    written += 1;
  }
  return written;
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The bytes a base64 string stands for. Node reads either alphabet under
 * either name -- `Buffer.from('+/', 'base64')` and
 * `Buffer.from('-_', 'base64url')` are the same two bytes -- stops at the
 * first `=`, and ignores anything that is a digit of neither.
 */
function base64Bytes(string: string): Uint8Array {
  let cleaned = '';
  for (let index = 0; index < string.length; index += 1) {
    const ch = string[index] as string;
    if (ch === '=') break;
    if (ch === '-') { cleaned += '+'; continue; }
    if (ch === '_') { cleaned += '/'; continue; }
    if (BASE64_ALPHABET.indexOf(ch) >= 0) cleaned += ch;
  }
  // A group of one digit stands for no byte at all and is dropped, as Node
  // drops it; every other tail contributes what its bits carry.
  const usable = cleaned.length - (cleaned.length % 4 === 1 ? 1 : 0);
  const bytes: number[] = [];
  let bits = 0;
  let held = 0;
  for (let index = 0; index < usable; index += 1) {
    const value = BASE64_ALPHABET.indexOf(cleaned[index] as string);
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((held >> bits) & 0xff); }
  }
  return new Uint8Array(bytes);
}

/** Node's `StringWrite<BASE64>`. */
export function base64Write(this: Uint8Array, string: string, offset = 0, length = this.byteLength - offset): number {
  const bytes = base64Bytes(string);
  const room = Math.min(length, this.byteLength - offset, bytes.length);
  if (room <= 0) return 0;
  this.set(bytes.subarray(0, room), offset);
  return room;
}

/** Node's `StringWrite<BASE64URL>`. */
export function base64urlWrite(this: Uint8Array, string: string, offset = 0, length = this.byteLength - offset): number {
  const bytes = base64Bytes(string);
  const room = Math.min(length, this.byteLength - offset, bytes.length);
  if (room <= 0) return 0;
  this.set(bytes.subarray(0, room), offset);
  return room;
}

// ── Decoding a buffer into a string ────────────────────────────────────────

export function utf8Slice(this: Uint8Array, start?: number, end?: number): string {
  const [from, to] = clamp(this, start as number, end as number);
  return utf8Decoder.decode(this.subarray(from, to));
}

export function asciiSlice(this: Uint8Array, start?: number, end?: number): string {
  const [from, to] = clamp(this, start as number, end as number);
  let out = '';
  for (let index = from; index < to; index += 1) out += String.fromCharCode((this[index] as number) & 0x7f);
  return out;
}

export function latin1Slice(this: Uint8Array, start?: number, end?: number): string {
  const [from, to] = clamp(this, start as number, end as number);
  return latin1Decoder.decode(this.subarray(from, to));
}

export function ucs2Slice(this: Uint8Array, start?: number, end?: number): string {
  const [from, to] = clamp(this, start as number, end as number);
  // A trailing odd byte is dropped, as Node drops it.
  const whole = to - ((to - from) % 2);
  const bytes = this.subarray(from, whole);
  // A view whose offset is odd cannot be a `Uint16Array`; copy that one.
  const aligned = (bytes.byteOffset % 2) === 0 ? bytes : new Uint8Array(bytes);
  return ucs2Decoder.decode(aligned);
}

export function hexSlice(this: Uint8Array, start?: number, end?: number): string {
  const [from, to] = clamp(this, start as number, end as number);
  let out = '';
  for (let index = from; index < to; index += 1) {
    const byte = this[index] as number;
    out += HEX_DIGITS[byte >>> 4] as string;
    out += HEX_DIGITS[byte & 0x0f] as string;
  }
  return out;
}

/** The engine's own encoder where it has one (`Uint8Array.prototype.toBase64`): one string, no garbage. */
const nativeBase64 = typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 === 'function';

function base64Text(bytes: Uint8Array, url: boolean): string {
  // Built a character at a time, a sourcemap's base64 was ropes of garbage:
  // 600 MB of a Vite session's 1.4 GB allocated in its first 20 s in a tab.
  if (nativeBase64) {
    return (bytes as Uint8Array & { toBase64(options: { alphabet: string; omitPadding: boolean }): string })
      .toBase64({ alphabet: url ? 'base64url' : 'base64', omitPadding: url });
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = index + 1 < bytes.length ? bytes[index + 1] as number : -1;
    const c = index + 2 < bytes.length ? bytes[index + 2] as number : -1;
    out += alphabet[a >>> 2] as string;
    out += alphabet[((a & 0x03) << 4) | (b < 0 ? 0 : b >>> 4)] as string;
    out += b < 0 ? '=' : alphabet[((b & 0x0f) << 2) | (c < 0 ? 0 : c >>> 6)] as string;
    out += c < 0 ? '=' : alphabet[c & 0x3f] as string;
  }
  if (!url) return out;
  return out.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64Slice(this: Uint8Array, start?: number, end?: number): string {
  const [from, to] = clamp(this, start as number, end as number);
  return base64Text(this.subarray(from, to), false);
}

export function base64urlSlice(this: Uint8Array, start?: number, end?: number): string {
  const [from, to] = clamp(this, start as number, end as number);
  return base64Text(this.subarray(from, to), true);
}

// ── The rest of what `buffer.js` asks for ──────────────────────────────────

/** Node's `ByteLengthUtf8`. */
export function byteLengthUtf8(string: string): number {
  // Counted, not encoded: encoding the whole string to read its length
  // allocated every Buffer.from(string) twice.
  let length = 0;
  for (let index = 0; index < string.length; index += 1) {
    const code = string.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code < 0xdc00 && index + 1 < string.length) {
      const next = string.charCodeAt(index + 1);
      if (next >= 0xdc00 && next < 0xe000) { length += 4; index += 1; } else length += 3;
    } else length += 3;
  }
  return length;
}

/** Node's `Compare`: two buffers whole, as `memcmp` orders them. */
export function compare(a: Uint8Array, b: Uint8Array): number {
  return compareRanges(asBytes(a), 0, a.length, asBytes(b), 0, b.length);
}

/** Node's `CompareOffset`: a range of one against a range of the other. */
export function compareOffset(
  source: Uint8Array, target: Uint8Array,
  targetStart = 0, sourceStart = 0, targetEnd = target.length, sourceEnd = source.length,
): number {
  return compareRanges(source, sourceStart, sourceEnd, target, targetStart, targetEnd);
}

function compareRanges(
  a: Uint8Array, aStart: number, aEnd: number,
  b: Uint8Array, bStart: number, bEnd: number,
): number {
  const aLength = aEnd - aStart;
  const bLength = bEnd - bStart;
  const shared = Math.min(aLength, bLength);
  for (let index = 0; index < shared; index += 1) {
    const left = a[aStart + index] as number;
    const right = b[bStart + index] as number;
    if (left !== right) return left < right ? -1 : 1;
  }
  if (aLength === bLength) return 0;
  return aLength < bLength ? -1 : 1;
}

/**
 * Node's `Copy(source, target, targetStart, sourceStart, toCopy)`. The last
 * argument is a LENGTH, not an end offset: `buffer.js`'s `_copyActual` has
 * already clamped the range and hands over how many bytes to move.
 */
export function copy(source: Uint8Array, target: Uint8Array, targetStart = 0, sourceStart = 0, toCopy = source.length - sourceStart): number {
  const room = Math.min(toCopy, source.length - sourceStart, target.length - targetStart);
  if (room <= 0) return 0;
  target.set(source.subarray(sourceStart, sourceStart + room), targetStart);
  return room;
}

/**
 * Node's `Fill` for a value that is not a number: a string in some encoding,
 * or another buffer, repeated over the range. -1 says the value stands for no
 * bytes at all, which is what `buffer.js` turns into ERR_INVALID_ARG_VALUE.
 */
export function fill(buf: Uint8Array, value: unknown, start: number, end: number, encoding?: string): number {
  const [from, to] = clamp(buf, start, end);
  if (to <= from) return 0;
  let pattern: Uint8Array;
  if (typeof value === 'string') {
    pattern = bytesOfString(value, encoding ?? 'utf8');
  } else if (value instanceof Uint8Array) {
    pattern = value;
  } else {
    return -1;
  }
  if (pattern.length === 0) return -1;
  for (let index = from; index < to; index += 1) {
    buf[index] = pattern[(index - from) % pattern.length] as number;
  }
  return to - from;
}

/** The bytes a string stands for in one of Node's encodings. */
export function bytesOfString(value: string, encoding: string): Uint8Array {
  switch (encoding) {
    case 'ascii': { const out = new Uint8Array(value.length); asciiWriteStatic(out, value, 0, out.length); return out; }
    case 'latin1': case 'binary': { const out = new Uint8Array(value.length); latin1WriteStatic(out, value, 0, out.length); return out; }
    case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': {
      const out = new Uint8Array(value.length * 2);
      ucs2Write.call(out, value, 0, out.length);
      return out;
    }
    case 'hex': { const out = new Uint8Array(Math.floor(value.length / 2)); const written = hexWrite.call(out, value, 0, out.length); return out.subarray(0, written); }
    case 'base64': case 'base64url': return base64Bytes(value);
    default: return encoder.encode(value);
  }
}

/** Node's `IndexOfNumber`. */
export function indexOfNumber(buffer: Uint8Array, value: number, byteOffset: number, isForward: boolean): number {
  const byte = value & 0xff;
  if (isForward) {
    let from = byteOffset < 0 ? buffer.length + byteOffset : byteOffset;
    if (from < 0) from = 0;
    for (let index = from; index < buffer.length; index += 1) if (buffer[index] === byte) return index;
    return -1;
  }
  let from = byteOffset < 0 ? buffer.length + byteOffset : Math.min(byteOffset, buffer.length - 1);
  if (from >= buffer.length) from = buffer.length - 1;
  for (let index = from; index >= 0; index -= 1) if (buffer[index] === byte) return index;
  return -1;
}

/** Node's `IndexOfBuffer`. */
export function indexOfBuffer(buffer: Uint8Array, value: Uint8Array, byteOffset: number, encoding: number, isForward: boolean): number {
  // A 16-bit encoding searches on even boundaries only, as Node's does.
  const step = encoding === UCS2 ? 2 : 1;
  return searchBytes(buffer, value, byteOffset, isForward, step);
}

/** Node's `IndexOfString`. */
export function indexOfString(buffer: Uint8Array, value: string, byteOffset: number, encoding: number, isForward: boolean): number {
  const name = encoding === UCS2 ? 'utf16le' : encoding === LATIN1 ? 'latin1' : encoding === ASCII ? 'ascii'
    : encoding === HEX ? 'hex' : encoding === BASE64 ? 'base64' : encoding === BASE64URL ? 'base64url' : 'utf8';
  return indexOfBuffer(buffer, bytesOfString(value, name), byteOffset, encoding, isForward);
}

function searchBytes(buffer: Uint8Array, needle: Uint8Array, byteOffset: number, isForward: boolean, step: number): number {
  const length = buffer.length;
  if (needle.length === 0) {
    if (isForward) return byteOffset > length ? length : (byteOffset < 0 ? Math.max(0, length + byteOffset) : byteOffset);
    return byteOffset > length ? length : (byteOffset < 0 ? Math.max(0, length + byteOffset) : byteOffset);
  }
  if (needle.length > length) return -1;
  const matches = (at: number): boolean => {
    for (let index = 0; index < needle.length; index += 1) if (buffer[at + index] !== needle[index]) return false;
    return true;
  };
  if (isForward) {
    let from = byteOffset < 0 ? length + byteOffset : byteOffset;
    if (from < 0) from = 0;
    if (step === 2 && (from % 2) !== 0) from += 1;
    for (let index = from; index + needle.length <= length; index += step) if (matches(index)) return index;
    return -1;
  }
  let from = byteOffset < 0 ? length + byteOffset : byteOffset;
  if (from > length - needle.length) from = length - needle.length;
  if (from < 0) return -1;
  if (step === 2 && (from % 2) !== 0) from -= 1;
  for (let index = from; index >= 0; index -= step) if (matches(index)) return index;
  return -1;
}

/** Node's `Swap16`/`Swap32`/`Swap64`, in place, answering the same buffer. */
export function swap16(buf: Uint8Array): Uint8Array {
  for (let index = 0; index < buf.length; index += 2) {
    const a = buf[index] as number;
    buf[index] = buf[index + 1] as number;
    buf[index + 1] = a;
  }
  return buf;
}
export function swap32(buf: Uint8Array): Uint8Array {
  for (let index = 0; index < buf.length; index += 4) {
    for (let at = 0; at < 2; at += 1) {
      const a = buf[index + at] as number;
      buf[index + at] = buf[index + 3 - at] as number;
      buf[index + 3 - at] = a;
    }
  }
  return buf;
}
export function swap64(buf: Uint8Array): Uint8Array {
  for (let index = 0; index < buf.length; index += 8) {
    for (let at = 0; at < 4; at += 1) {
      const a = buf[index + at] as number;
      buf[index + at] = buf[index + 7 - at] as number;
      buf[index + 7 - at] = a;
    }
  }
  return buf;
}

/** Node's `IsUtf8`: whether the bytes decode without a replacement. */
export function isUtf8(buf: Uint8Array): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** Node's `IsAscii`: every byte under 128. */
export function isAscii(buf: Uint8Array): boolean {
  for (let index = 0; index < buf.length; index += 1) if ((buf[index] as number) > 0x7f) return false;
  return true;
}

/** Node's `Atob`: the string a base64 one stands for, -1 for one that is not. */
export function atob(input: string): string | number {
  try { return globalThis.atob(input); } catch { return -1; }
}

/** Node's `Btoa`: the base64 of a latin1 string, -1 for a character outside it. */
export function btoa(input: string): string | number {
  try { return globalThis.btoa(input); } catch { return -1; }
}

/**
 * Node's zero-fill toggle: `Buffer.allocUnsafe` reads it to decide whether the
 * memory it takes is cleared. A realm's `new Uint8Array(n)` is always zeroed
 * and there is no uncleared memory to hand out, so the toggle stays 0 and
 * "unsafe" costs nothing and hides nothing.
 */
const zeroFillToggle = new Uint32Array(1);
export function getZeroFillToggle(): Uint32Array {
  return zeroFillToggle;
}

/**
 * Node's `DetachArrayBuffer` and `CopyArrayBuffer`, which `Blob` and the
 * worker's message port use. A realm can detach through `structuredClone`'s
 * transfer list, and that is the only detach there is here.
 */
export function detachArrayBuffer(buffer: ArrayBuffer): void {
  try { structuredClone(buffer, { transfer: [buffer] }); } catch { /* a realm that refuses leaves it attached */ }
}
export function copyArrayBuffer(dest: ArrayBuffer, destOffset: number, source: ArrayBuffer, sourceOffset: number, length: number): void {
  new Uint8Array(dest).set(new Uint8Array(source, sourceOffset, length), destOffset);
}

/** Node's `SetBufferPrototype`: C++ keeps it to build buffers; nothing here does. */
export function setBufferPrototype(_proto: object): void {}

/** Node's `CreateFromString`: `buffer.js` has its own and never calls this. */
export function createFromString(string: string, encoding: number): Uint8Array {
  return bytesOfString(string, encoding === UCS2 ? 'utf16le' : encoding === LATIN1 ? 'latin1' : 'utf8');
}

export default {
  byteLengthUtf8, compare, compareOffset, copy, fill,
  isAscii, isUtf8, indexOfBuffer, indexOfNumber, indexOfString,
  swap16, swap32, swap64, kMaxLength, kStringMaxLength, atob, btoa,
  asciiSlice, base64Slice, base64urlSlice, latin1Slice, hexSlice, ucs2Slice, utf8Slice,
  asciiWriteStatic, base64Write, base64urlWrite, latin1WriteStatic, hexWrite, ucs2Write, utf8WriteStatic,
  getZeroFillToggle, detachArrayBuffer, copyArrayBuffer, setBufferPrototype, createFromString,
};
