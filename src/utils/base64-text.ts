/**
 * HTML's `atob` and `btoa` (forgiving-base64 decode and encode over a binary string), the engine's own: a kernel's host
 * program's realm holds no window or worker functions (ADR-0017; browser-substrate ADR-0227 §4), so the engine's own
 * code takes these from here. A guest's `atob` and `btoa` are its `buffer` module's, as in Node (ADR-0015).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE = new Int16Array(128).fill(-1);
for (let at = 0; at < ALPHABET.length; at++) VALUE[ALPHABET.charCodeAt(at)] = at;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { name: 'InvalidCharacterError', code: 5 });
}

export function btoa(data: string): string {
  const text = String(data);
  let out = '';
  for (let at = 0; at < text.length; at += 3) {
    const a = text.charCodeAt(at), b = text.charCodeAt(at + 1), c = text.charCodeAt(at + 2);
    if (a > 255 || b > 255 || c > 255) throw invalid('The string to be encoded contains characters outside of the Latin1 range.');
    const bits = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += ALPHABET[bits >> 18]! + ALPHABET[(bits >> 12) & 63]!
      + (at + 1 < text.length ? ALPHABET[(bits >> 6) & 63]! : '=') + (at + 2 < text.length ? ALPHABET[bits & 63]! : '=');
  }
  return out;
}

export function atob(data: string): string {
  let text = String(data).replace(/[\t\n\f\r ]/gu, '');
  if (text.length % 4 === 0) text = text.replace(/==?$/u, '');
  if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/u.test(text)) throw invalid('The string to be decoded is not correctly encoded.');
  let out = '';
  let buffer = 0, bits = 0;
  for (let at = 0; at < text.length; at++) {
    buffer = (buffer << 6) | VALUE[text.charCodeAt(at)]!;
    bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 255); }
  }
  return out;
}
