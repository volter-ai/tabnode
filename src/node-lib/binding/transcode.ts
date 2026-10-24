/**
 * `buffer.transcode(source, fromEncoding, toEncoding)`.
 *
 * Node defines it only where it is built with ICU (lib/buffer.js, under `internalBinding('config').hasIntl`), and
 * this engine carries no ICU, so the lib left the export undefined and a program that called it read "is not a
 * function". This is the one function, for the encodings Node documents (utf8, ucs2/utf16le, latin1/binary,
 * ascii), written against what Node v24.21.0 answers for every pair of them, the odd answers included: a byte
 * above 0x7f read as ASCII becomes U+FFFD going to UTF-8, the same byte's value going to UCS-2, and `?` going to a
 * single-byte encoding; malformed input is replaced going to a single-byte encoding or to its own encoding, and
 * refused (U_INVALID_CHAR_FOUND) between UTF-8 and UCS-2. Any other encoding is ICU's U_ILLEGAL_ARGUMENT_ERROR.
 */
import { ERR_INVALID_ARG_TYPE } from '../../node-internals';

type Encoding = 'utf8' | 'ucs2' | 'latin1' | 'ascii';
const NAMES: Record<string, Encoding> = {
  'utf8': 'utf8', 'utf-8': 'utf8', 'ucs2': 'ucs2', 'ucs-2': 'ucs2', 'utf16le': 'ucs2', 'utf-16le': 'ucs2',
  'latin1': 'latin1', 'binary': 'latin1', 'ascii': 'ascii',
};
/** ICU's own numbers for the two refusals (unicode/utypes.h). */
const ICU_ERRORS = { U_ILLEGAL_ARGUMENT_ERROR: 1, U_INVALID_CHAR_FOUND: 10 } as const;
function refuse(code: keyof typeof ICU_ERRORS): never {
  throw Object.assign(new Error(`Unable to transcode Buffer [${code}]`), { code, errno: ICU_ERRORS[code] });
}

const QUESTION = 0x3f;
/** The string's code points as single bytes; what does not fit, a lone surrogate included, is `?`. */
function singleByte(text: string, most: number): Uint8Array {
  const out: number[] = [];
  for (const char of text) { const point = char.codePointAt(0)!; out.push(point > most ? QUESTION : point); }
  return Uint8Array.from(out);
}
function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let at = 0; at < text.length; at += 1) { const unit = text.charCodeAt(at); out[at * 2] = unit & 0xff; out[at * 2 + 1] = unit >> 8; }
  return out;
}
/** Whole code units; a trailing odd byte is not one. */
function unitsOf(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at + 1 < bytes.length; at += 2) text += String.fromCharCode(bytes[at]! | (bytes[at + 1]! << 8));
  return text;
}
function wellFormed(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = text.charCodeAt(at + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; at += 1; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function replaceLone(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += text[at]! + text[at + 1]!; at += 1; } else out += '�';
    } else out += unit >= 0xdc00 && unit <= 0xdfff ? '�' : text[at]!;
  }
  return out;
}
const fromLatin1 = (bytes: Uint8Array): string => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return text; };

function convert(bytes: Uint8Array, from: Encoding, to: Encoding): Uint8Array {
  if (from === 'utf8') {
    if (to === 'ucs2') {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return refuse('U_INVALID_CHAR_FOUND'); }
      return utf16le(text);
    }
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    return to === 'utf8' ? new TextEncoder().encode(text) : singleByte(text, to === 'latin1' ? 0xff : 0x7f);
  }
  if (from === 'ucs2') {
    const text = unitsOf(bytes);
    if (to === 'utf8') return wellFormed(text) ? new TextEncoder().encode(text) : refuse('U_INVALID_CHAR_FOUND');
    if (to === 'ucs2') return utf16le(replaceLone(text) + (bytes.length % 2 ? '�' : ''));
    return singleByte(text, to === 'latin1' ? 0xff : 0x7f);
  }
  // A single-byte source. To UCS-2 each byte is its own code unit, for ASCII as for Latin-1.
  if (to === 'ucs2') return utf16le(fromLatin1(bytes));
  if (to === 'utf8') return new TextEncoder().encode(from === 'latin1' ? fromLatin1(bytes) : fromLatin1(bytes).replace(/[\u0080-ÿ]/g, '�'));
  if (from === 'latin1' && to === 'latin1') return Uint8Array.from(bytes);
  return Uint8Array.from(bytes, (byte) => byte > 0x7f ? QUESTION : byte);
}

export function transcodeFor(toBuffer: (bytes: Uint8Array) => unknown): (source: unknown, fromEncoding: unknown, toEncoding: unknown) => unknown {
  return function transcode(source: unknown, fromEncoding: unknown, toEncoding: unknown): unknown {
    if (!(source instanceof Uint8Array)) throw new ERR_INVALID_ARG_TYPE('source', ['Buffer', 'Uint8Array'], source);
    if (source.length === 0) return toBuffer(new Uint8Array(0));
    const from = NAMES[String(fromEncoding).toLowerCase()], to = NAMES[String(toEncoding).toLowerCase()];
    if (!from || !to) return refuse('U_ILLEGAL_ARGUMENT_ERROR');
    return toBuffer(convert(source, from, to));
  };
}
