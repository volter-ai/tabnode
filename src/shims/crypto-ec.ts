/**
 * Elliptic-curve keys held as their own numbers, so everything about them is synchronous: generation, the
 * encodings Node reads and writes (SPKI, PKCS#8 and SEC1 as DER or PEM, and JWK), ECDSA over P-256, P-384 and
 * P-521, and Ed25519. WebCrypto has every one of these and none synchronously, and a program's
 * `generateKeyPairSync`, `createSign(...).sign(key)` or `key.export()` cannot wait.
 *
 * The curve arithmetic is @noble/curves; the encodings below are written out against what Node v24.21.0 emits,
 * byte for byte (an EC PKCS#8 carries the SEC1 key with its public point and without its parameters, as OpenSSL
 * writes it). This file knows no Buffer and no engine: bytes in, bytes out.
 */
import { p256, p384, p521 } from '@noble/curves/nist.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';

export type EcCurveName = 'P-256' | 'P-384' | 'P-521';
/** `secret` is the private scalar (EC, at the field's width) or the seed (Ed25519); absent in a public key. */
export type AsymmetricKey =
  | { kind: 'ec'; curve: EcCurveName; point: Uint8Array; secret?: Uint8Array; /** Read from a private key that stated no public half: written back without one, as OpenSSL writes it. */ bare?: true;
      /** A public key read with its point in compressed or hybrid form: those bytes, which its SubjectPublicKeyInfo is written back with, as OpenSSL keeps the form it read. `point` is uncompressed always. */ written?: Uint8Array }
  | { kind: 'ed25519'; point: Uint8Array; secret?: Uint8Array };

/**
 * A key this file reads (an EC or Ed25519 key, by its own algorithm identifier, label or `kty`) that it refuses,
 * and why. Distinct from "not one of these keys", which the readers answer with undefined so the caller's other
 * readers can have the bytes. `reason`: `encrypted` (the text says the key is encrypted; this engine decrypts none),
 * `curve` (a curve this file does not carry), `jwk` (a JWK whose members are not a key), `key` (everything else:
 * malformed DER, a point not on its curve, a scalar out of range, halves that are not one key).
 */
export class KeyRefused extends Error {
  constructor(readonly reason: 'encrypted' | 'curve' | 'jwk' | 'key', message: string) { super(message); }
}
const refuse = (message: string): never => { throw new KeyRefused('key', message); };
/** Raised inside a reader for bytes that are not this encoding of one of these keys at all. */
class NotThisKey extends Error {}

type Curve = typeof p256;
const CURVES: Record<EcCurveName, { curve: Curve; bytes: number; oid: string; node: string }> = {
  'P-256': { curve: p256, bytes: 32, oid: '06082a8648ce3d030107', node: 'prime256v1' },
  'P-384': { curve: p384, bytes: 48, oid: '06052b81040022', node: 'secp384r1' },
  'P-521': { curve: p521, bytes: 66, oid: '06052b81040023', node: 'secp521r1' },
};
/** The names Node takes for a curve, lower-cased. */
const CURVE_NAMES: Record<string, EcCurveName> = {
  'prime256v1': 'P-256', 'p-256': 'P-256', 'secp256r1': 'P-256',
  'secp384r1': 'P-384', 'p-384': 'P-384',
  'secp521r1': 'P-521', 'p-521': 'P-521',
};
const OID_EC_PUBLIC_KEY = '06072a8648ce3d0201';
const OID_ED25519 = '06032b6570';

export function curveNamed(name: unknown): EcCurveName | undefined {
  return typeof name === 'string' ? CURVE_NAMES[name.toLowerCase()] : undefined;
}
/** OpenSSL's name for the curve: what `asymmetricKeyDetails.namedCurve` says. */
export function nodeCurveName(curve: EcCurveName): string { return CURVES[curve].node; }

// ---------------------------------------------------------------- bytes

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
function concat(...parts: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.length; }
  return whole;
}
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64Of(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at]!, b = bytes[at + 1], c = bytes[at + 2];
    text += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
      + (b === undefined ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? '=' : BASE64[c & 63]!);
  }
  return text;
}
export function base64Bytes(text: string): Uint8Array {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let bits = 0, held = 0, at = 0;
  for (const letter of clean) {
    held = (held << 6) | BASE64.indexOf(letter); bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (held >> bits) & 0xff; }
  }
  return out.subarray(0, at);
}
const base64UrlOf = (bytes: Uint8Array): string => base64Of(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------- DER

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const content = concat(...parts), length = content.length;
  const head = length < 0x80 ? [tag, length] : length < 0x100 ? [tag, 0x81, length] : [tag, 0x82, length >> 8, length & 0xff];
  return concat(Uint8Array.from(head), content);
}
interface Element { tag: number; content: Uint8Array; end: number }
/**
 * One DER element. DER, not BER: a length is in its shortest form (no long form for a length under 128, no leading
 * zero byte), and never indefinite. OpenSSL reads the looser forms (Node v24.21.0 takes a SubjectPublicKeyInfo whose
 * outer length is written `81 59` or `82 00 59`); no tool writes a key that way, and a reader of keys that takes
 * two spellings of one key is the looser thing to be.
 */
function element(bytes: Uint8Array, at: number): Element {
  const tag = bytes[at];
  let length = bytes[at + 1];
  if (tag === undefined || length === undefined) throw new Error('truncated');
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 3) throw new Error('length');
    if (start + count > bytes.length) throw new Error('truncated');
    if (bytes[start] === 0) throw new Error('a length with a leading zero');
    length = 0;
    for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[start + index]!;
    if (count === 1 && length < 0x80) throw new Error('a long-form length for a short one');
    start += count;
  }
  if (start + length > bytes.length) throw new Error('truncated');
  return { tag, content: bytes.subarray(start, start + length), end: start + length };
}
function children(bytes: Uint8Array): Element[] {
  const found: Element[] = [];
  for (let at = 0; at < bytes.length;) { const next = element(bytes, at); found.push(next); at = next.end; }
  return found;
}
/** The one element `bytes` is, of the tag asked; throws where it is another or has bytes after it. */
function only(bytes: Uint8Array, tag: number): Uint8Array {
  const found = element(bytes, 0);
  if (found.tag !== tag || found.end !== bytes.length) throw new Error('shape');
  return found.content;
}
function padded(bytes: Uint8Array, width: number): Uint8Array {
  if (bytes.length === width) return bytes;
  if (bytes.length > width) {
    const extra = bytes.length - width;
    if (bytes.subarray(0, extra).some((byte) => byte !== 0)) throw new Error('scalar too wide');
    return bytes.subarray(extra);
  }
  const out = new Uint8Array(width);
  out.set(bytes, width - bytes.length);
  return out;
}

// ---------------------------------------------------------------- keys

export function generateKey(kind: 'ec' | 'ed25519', curve?: EcCurveName): AsymmetricKey {
  if (kind === 'ed25519') {
    const secret = ed25519.utils.randomSecretKey();
    return { kind, secret, point: ed25519.getPublicKey(secret) };
  }
  const { curve: math } = CURVES[curve!];
  const secret = math.utils.randomSecretKey();
  return { kind: 'ec', curve: curve!, secret, point: math.getPublicKey(secret, false) };
}

export function publicOf(key: AsymmetricKey): AsymmetricKey {
  return key.kind === 'ec' ? { kind: 'ec', curve: key.curve, point: key.point, ...(key.written ? { written: key.written } : {}) } : { kind: 'ed25519', point: key.point };
}

/**
 * The point as uncompressed bytes, checked: its form, its length and that it is on its curve. A copy. Both forms a
 * tool writes are read: uncompressed (04, x, y) and compressed (02 or 03, x) and hybrid (06 or 07, x, y), which `openssl ec -conv_form`
 * writes and Node reads.
 */
function ecPoint(curve: EcCurveName, point: Uint8Array): Uint8Array {
  const { curve: math, bytes } = CURVES[curve];
  const uncompressed = point.length === 1 + 2 * bytes && point[0] === 4, compressed = point.length === 1 + bytes && (point[0] === 2 || point[0] === 3);
  // Hybrid: both coordinates, and y's parity in the first byte, which must agree with y.
  const hybrid = point.length === 1 + 2 * bytes && (point[0] === 6 || point[0] === 7) && (point[0]! & 1) === (point[point.length - 1]! & 1);
  if (!uncompressed && !compressed && !hybrid) return refuse(`an ${curve} public key is 04 with two ${bytes}-byte coordinates, 02 or 03 with one, or 06 or 07 with two`);
  try { return math.Point.fromBytes(hybrid ? concat(Uint8Array.from([4]), point.subarray(1)) : point).toBytes(false); } catch { return refuse(`the public key is not a point on ${curve}`); }
}
/**
 * A private key from its scalar. The scalar is copied (a caller that zeroes its buffer afterwards does not change
 * the key), must be in the curve's range, and its public point is derived from it. A public half the key states is
 * compared with the derived one: OpenSSL keeps whichever point is stated (Node v24.21.0 then signs with one key and
 * exports another's public half), which is two keys in one object; here that is refused.
 */
function ecFromSecret(curve: EcCurveName, secret: Uint8Array, stated?: Uint8Array): AsymmetricKey {
  const { curve: math, bytes } = CURVES[curve];
  let scalar: Uint8Array;
  try { scalar = padded(secret, bytes).slice(); } catch { return refuse(`the private value is wider than ${curve}'s`); }
  if (!math.utils.isValidSecretKey(scalar)) return refuse(`the private value is not in ${curve}'s range`);
  const point = math.getPublicKey(scalar, false);
  if (stated && (stated.length !== point.length || stated.some((byte, at) => byte !== point[at]))) return refuse('the public half the key states is not the public key of its private value');
  return { kind: 'ec', curve, secret: scalar, point, ...(stated ? {} : { bare: true as const }) };
}
/** The curve an OID element (tag, length and value) names. */
function curveOfOid(oid: Uint8Array): EcCurveName | undefined {
  const hex = hexOf(oid);
  return (Object.keys(CURVES) as EcCurveName[]).find((name) => CURVES[name].oid === hex);
}
/** A BIT STRING's bytes: no unused bits, as a key's is. */
function bitString(content: Uint8Array): Uint8Array {
  if (content[0] !== 0) return refuse('a key\'s bit string has no unused bits');
  return content.subarray(1);
}
const idsOf = (algorithm: Uint8Array): string[] => children(algorithm).map((id) => hexOf(concat(Uint8Array.from([id.tag, id.content.length]), id.content)));
/**
 * A SEC1 ECPrivateKey: version 1, the private value, then optionally its curve ([0]) and its public key ([1]), in
 * that order and nothing else. Its curve is its own parameters' or the one its container named; both, and they
 * differ, is two curves for one key and is refused.
 */
function fromSec1(der: Uint8Array, named?: EcCurveName): AsymmetricKey {
  let parts: Element[];
  try { parts = children(only(der, 0x30)); } catch (cause) { if (named) return refuse(`the key's ECPrivateKey is not DER: ${(cause as Error).message}`); throw new NotThisKey(); }
  const version = parts[0], secret = parts[1];
  if (version?.tag !== 0x02 || secret?.tag !== 0x04) { if (named) return refuse('the key\'s ECPrivateKey has no version and private value'); throw new NotThisKey(); }
  if (version.content.length !== 1 || version.content[0] !== 1) return refuse('an ECPrivateKey\'s version is 1');
  let curve = named, stated: Uint8Array | undefined, last = 0;
  for (const part of parts.slice(2)) {
    const order = part.tag === 0xa0 ? 1 : part.tag === 0xa1 ? 2 : 0;
    if (order === 0 || order <= last) return refuse('an ECPrivateKey holds its curve and then its public key, once each, and nothing else');
    last = order;
    if (part.tag === 0xa0) {
      const own = curveOfOid(part.content);
      if (!own) throw new KeyRefused('curve', 'the key names a curve this engine does not carry (it carries P-256, P-384 and P-521)');
      if (curve && own !== curve) return refuse(`the key names two curves, ${curve} and ${own}`);
      curve = own;
    } else stated = bitString(only(part.content, 0x03));
  }
  if (!curve) return refuse('the key names no curve');
  return ecFromSecret(curve, secret.content, stated ? ecPoint(curve, stated) : undefined);
}
/** The algorithm of a SubjectPublicKeyInfo or PKCS#8 key, or NotThisKey for another's (RSA, X25519, anything else). */
function algorithmOf(algorithm: Uint8Array): { kind: 'ed25519' } | { kind: 'ec'; curve: EcCurveName } {
  const ids = idsOf(algorithm);
  if (ids[0] === OID_ED25519) { if (ids.length !== 1) return refuse('an Ed25519 key\'s algorithm has no parameters'); return { kind: 'ed25519' }; }
  if (ids[0] !== OID_EC_PUBLIC_KEY) throw new NotThisKey();
  if (ids.length !== 2) return refuse('an EC key\'s algorithm is its type and its curve');
  const curve = (Object.keys(CURVES) as EcCurveName[]).find((name) => CURVES[name].oid === ids[1]);
  if (!curve) throw new KeyRefused('curve', 'the key names a curve this engine does not carry (it carries P-256, P-384 and P-521)');
  return { kind: 'ec', curve };
}
function fromSpki(der: Uint8Array): AsymmetricKey {
  let parts: Element[];
  try { parts = children(only(der, 0x30)); } catch { throw new NotThisKey(); }
  const [algorithm, bits] = parts;
  if (algorithm?.tag !== 0x30 || bits?.tag !== 0x03) throw new NotThisKey();
  const named = algorithmOf(algorithm.content);
  if (parts.length !== 2) return refuse('a SubjectPublicKeyInfo is an algorithm and a key, and nothing else');
  const point = bitString(bits.content);
  if (named.kind === 'ed25519') { if (point.length !== 32) return refuse('an Ed25519 public key is 32 bytes'); return { kind: 'ed25519', point: point.slice() }; }
  return { kind: 'ec', curve: named.curve, point: ecPoint(named.curve, point), ...(point[0] === 4 ? {} : { written: point.slice() }) };
}
function fromPkcs8(der: Uint8Array): AsymmetricKey {
  let parts: Element[];
  try { parts = children(only(der, 0x30)); } catch { throw new NotThisKey(); }
  const [version, algorithm, inner] = parts;
  if (version?.tag !== 0x02 || algorithm?.tag !== 0x30 || inner?.tag !== 0x04) throw new NotThisKey();
  const named = algorithmOf(algorithm.content);
  if (version.content.length !== 1 || version.content[0]! > 1) return refuse('a PKCS#8 key\'s version is 0 or 1');
  // After the key: its attributes ([0]) and, in version 1, its public key ([1]); nothing else.
  if (parts.slice(3).some((part) => part.tag !== 0xa0 && part.tag !== 0x81 && part.tag !== 0xa1)) return refuse('a PKCS#8 key holds its version, algorithm, key and attributes, and nothing else');
  if (named.kind === 'ed25519') {
    let seed: Uint8Array;
    try { seed = only(inner.content, 0x04); } catch { return refuse('an Ed25519 private key is an octet string'); }
    if (seed.length !== 32) return refuse('an Ed25519 private key is 32 bytes');
    const secret = seed.slice();
    return { kind: 'ed25519', secret, point: ed25519.getPublicKey(secret) };
  }
  return fromSec1(inner.content, named.curve);
}

export type KeyEncodingType = 'spki' | 'pkcs8' | 'sec1';
/**
 * An EC or Ed25519 key from DER in the encoding named, or in whichever of the three it is where none is named.
 * Undefined where the bytes are not one of these keys (an RSA key, a certificate, not DER): the caller's other
 * readers have them.
 */
export function keyFromDer(der: Uint8Array, type?: KeyEncodingType): AsymmetricKey | undefined {
  const readers: Array<[KeyEncodingType, (bytes: Uint8Array) => AsymmetricKey]> = [['spki', fromSpki], ['pkcs8', fromPkcs8], ['sec1', (bytes) => fromSec1(bytes)]];
  for (const [name, read] of readers) {
    if (type !== undefined && type !== name) continue;
    // Not this encoding of one of these keys: the next reader, then the caller's. One of these keys that is wrong
    // (KeyRefused) is the caller's error to raise, never a reason to try the bytes as something else.
    try { return read(der); } catch (cause) { if (!(cause instanceof NotThisKey)) throw cause; }
  }
  return undefined;
}
/**
 * The same from PEM, by its label. Undefined for another label or another kind of key. A PEM that says it is
 * encrypted (`ENCRYPTED PRIVATE KEY`, or the older `Proc-Type: 4,ENCRYPTED` header, whatever key is inside) is
 * refused as that: this engine decrypts no key, and its bytes must not be read as anything.
 */
export function keyFromPem(pem: string): AsymmetricKey | undefined {
  // The first block that is a key. Text around the blocks, and an `EC PARAMETERS` block before the key (the two
  // blocks `openssl ecparam -genkey` writes), are passed over, as OpenSSL passes over them.
  for (const found of pem.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)) {
    const label = found[1]!, body = found[2]!;
    if (label === 'EC PARAMETERS') continue;
    if (label === 'ENCRYPTED PRIVATE KEY' || /^\s*Proc-Type:\s*4,\s*ENCRYPTED/mi.test(body)) throw new KeyRefused('encrypted', 'the key is encrypted');
    const type: KeyEncodingType | undefined = label === 'PUBLIC KEY' ? 'spki' : label === 'PRIVATE KEY' ? 'pkcs8' : label === 'EC PRIVATE KEY' ? 'sec1' : undefined;
    if (!type) return undefined;
    if (/[^A-Za-z0-9+/=\s]/.test(body)) return refuse('the key\'s text is not base64');
    const der = base64Bytes(body);
    // The label says which key this is, so an EC PRIVATE KEY that does not read is a refusal, not another key.
    if (type === 'sec1') { try { return fromSec1(der); } catch (cause) { if (cause instanceof NotThisKey) return refuse('the EC PRIVATE KEY is not an ECPrivateKey'); throw cause; } }
    return keyFromDer(der, type);
  }
  return undefined;
}
/**
 * A key from a JWK. Undefined where the object is another kind of key (`kty` RSA, oct). An EC or Ed25519 JWK whose
 * members are not a key is KeyRefused('jwk'): coordinates of the wrong length, a point off its curve, a private
 * value of the wrong length or not the private value of the public key beside it.
 */
export function keyFromJwk(jwk: Record<string, unknown>): AsymmetricKey | undefined {
  const invalid = (): never => { throw new KeyRefused('jwk', 'Invalid JWK data'); };
  // Either base64 alphabet, padded or not: Node reads both, and which letters a value has depends on the value.
  const bytes = (value: unknown): Uint8Array => typeof value === 'string' && /^[A-Za-z0-9_+/-]+={0,2}$/.test(value) ? base64Bytes(value) : invalid();
  // A member at the curve's width. One written without its leading zero bytes is that number, as Node reads it (an
  // encoder that drops them does so for one key in 128 a coordinate); one wider than the curve is not a member.
  const member = (value: unknown, width: number): Uint8Array => { try { return padded(bytes(value), width); } catch { return invalid(); } };
  if (jwk.kty === 'OKP') {
    if (jwk.crv !== 'Ed25519') return undefined;
    const point = bytes(jwk.x);
    if (point.length !== 32) return invalid();
    if (jwk.d === undefined) return { kind: 'ed25519', point: point.slice() };
    const secret = bytes(jwk.d);
    if (secret.length !== 32) return invalid();
    const derived = ed25519.getPublicKey(secret);
    if (derived.some((byte, at) => byte !== point[at])) return invalid();
    return { kind: 'ed25519', secret: secret.slice(), point: derived };
  }
  if (jwk.kty !== 'EC') return undefined;
  const curve = curveNamed(jwk.crv);
  if (!curve) throw new KeyRefused('curve', 'Invalid JWK EC key');
  const width = CURVES[curve].bytes, x = member(jwk.x, width), y = member(jwk.y, width);
  try {
    const point = ecPoint(curve, concat(Uint8Array.from([4]), x, y));
    if (jwk.d === undefined) return { kind: 'ec', curve, point };
    return { ...ecFromSecret(curve, member(jwk.d, width), point), kind: 'ec', curve } as AsymmetricKey;
  } catch (cause) { if (cause instanceof KeyRefused && cause.reason === 'key') return invalid(); throw cause; }
}

function spkiOf(key: AsymmetricKey): Uint8Array {
  const algorithm = key.kind === 'ed25519' ? tlv(0x30, fromHex(OID_ED25519)) : tlv(0x30, fromHex(OID_EC_PUBLIC_KEY), fromHex(CURVES[key.curve].oid));
  const point = key.kind === 'ec' && key.written ? key.written : key.point;
  return tlv(0x30, algorithm, tlv(0x03, Uint8Array.from([0]), point));
}
function sec1Of(key: AsymmetricKey & { kind: 'ec' }, withParameters: boolean): Uint8Array {
  return tlv(0x30, fromHex('020101'), tlv(0x04, key.secret!),
    ...(withParameters ? [tlv(0xa0, fromHex(CURVES[key.curve].oid))] : []),
    ...(key.bare ? [] : [tlv(0xa1, tlv(0x03, Uint8Array.from([0]), key.point))]));
}
function pkcs8Of(key: AsymmetricKey): Uint8Array {
  if (key.kind === 'ed25519') return tlv(0x30, fromHex('020100'), tlv(0x30, fromHex(OID_ED25519)), tlv(0x04, tlv(0x04, key.secret!)));
  return tlv(0x30, fromHex('020100'), tlv(0x30, fromHex(OID_EC_PUBLIC_KEY), fromHex(CURVES[key.curve].oid)), tlv(0x04, sec1Of(key, false)));
}
/** The key's DER in the encoding named. The caller has checked the encoding suits the key (a public key is SPKI). */
export function derOf(key: AsymmetricKey, type: KeyEncodingType): Uint8Array {
  if (type === 'spki') return spkiOf(key);
  if (type === 'sec1') return sec1Of(key as AsymmetricKey & { kind: 'ec' }, true);
  return pkcs8Of(key);
}
export function pemOf(der: Uint8Array, type: KeyEncodingType): string {
  const label = type === 'spki' ? 'PUBLIC KEY' : type === 'sec1' ? 'EC PRIVATE KEY' : 'PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${base64Of(der).match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}
/** The key as a JWK, its members in the order Node writes them. */
export function jwkOf(key: AsymmetricKey, withSecret: boolean): Record<string, string> {
  if (key.kind === 'ed25519') {
    return { crv: 'Ed25519', ...(withSecret ? { d: base64UrlOf(key.secret!) } : {}), x: base64UrlOf(key.point), kty: 'OKP' };
  }
  const width = CURVES[key.curve].bytes;
  return { kty: 'EC', x: base64UrlOf(key.point.subarray(1, 1 + width)), y: base64UrlOf(key.point.subarray(1 + width)), crv: key.curve,
    ...(withSecret ? { d: base64UrlOf(key.secret!) } : {}) };
}

// ---------------------------------------------------------------- signatures

export type DsaEncoding = 'der' | 'ieee-p1363';

/**
 * Ed25519 verification as OpenSSL does it, and Node therefore: RFC 8032's check without the cofactor. S must be
 * below the group's order; the public key must decode canonically; R' = S·B − k·A is computed and its ENCODING is
 * compared with the signature's R, byte for byte (so a non-canonical R is refused without being decoded). The
 * library's own verify multiplies by the cofactor (and under ZIP-215 takes non-canonical encodings too), which
 * accepts signatures OpenSSL refuses: of the twelve vectors of "Taming the many EdDSAs" Node v24.21.0 accepts one
 * (number 3), and so does this.
 */
function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  const Point = ed25519.Point, order = Point.Fn.ORDER;
  const little = (bytes: Uint8Array): bigint => { let value = 0n; for (let at = bytes.length - 1; at >= 0; at -= 1) value = (value << 8n) | BigInt(bytes[at]!); return value; };
  const r = signature.subarray(0, 32), s = little(signature.subarray(32));
  if (s >= order) return false;
  let a: InstanceType<typeof Point>;
  try { a = Point.fromBytes(publicKey, false); } catch { return false; }
  // OpenSSL 3.5 (Node v24.21.0's) also refuses a public key or an R of small order: vectors 0, 1 and 2 are those,
  // and pass the equation above. A signature under a small-order key holds for many messages.
  if (a.isSmallOrder()) return false;
  try { if (Point.fromBytes(r, false).isSmallOrder()) return false; } catch { return false; }
  const k = little(sha512(concat(r, publicKey, message))) % order;
  const calculated = Point.BASE.multiplyUnsafe(s).add(a.multiplyUnsafe(k).negate()).toBytes();
  return calculated.every((byte, at) => byte === r[at]);
}

/** ECDSA over the digest the caller made, or Ed25519 over the message itself (`digest` undefined). */
export function signWith(key: AsymmetricKey, message: Uint8Array, digest: Uint8Array | undefined, encoding: DsaEncoding): Uint8Array {
  if (key.kind === 'ed25519') return ed25519.sign(message, key.secret!);
  return CURVES[key.curve].curve.sign(digest!, key.secret!, { prehash: false, lowS: false, format: encoding === 'der' ? 'der' : 'compact' });
}
export function verifyWith(key: AsymmetricKey, message: Uint8Array, digest: Uint8Array | undefined, signature: Uint8Array, encoding: DsaEncoding): boolean {
  try {
    if (key.kind === 'ed25519') return verifyEd25519(signature, message, key.point);
    return CURVES[key.curve].curve.verify(signature, digest!, key.point, { prehash: false, lowS: false, format: encoding === 'der' ? 'der' : 'compact' });
  } catch { return false; }
}
