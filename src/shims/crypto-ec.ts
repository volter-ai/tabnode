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

export type EcCurveName = 'P-256' | 'P-384' | 'P-521';
/** `secret` is the private scalar (EC, at the field's width) or the seed (Ed25519); absent in a public key. */
export type AsymmetricKey =
  | { kind: 'ec'; curve: EcCurveName; point: Uint8Array; secret?: Uint8Array }
  | { kind: 'ed25519'; point: Uint8Array; secret?: Uint8Array };

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
function element(bytes: Uint8Array, at: number): Element {
  const tag = bytes[at];
  let length = bytes[at + 1];
  if (tag === undefined || length === undefined) throw new Error('truncated');
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 3) throw new Error('length');
    length = 0;
    for (let index = 0; index < count; index += 1) length = (length << 8) | (bytes[start + index] ?? 0);
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
  return key.kind === 'ec' ? { kind: 'ec', curve: key.curve, point: key.point } : { kind: 'ed25519', point: key.point };
}

function ecFromSecret(curve: EcCurveName, secret: Uint8Array, point?: Uint8Array): AsymmetricKey {
  const { curve: math, bytes } = CURVES[curve];
  const scalar = padded(secret, bytes);
  return { kind: 'ec', curve, secret: scalar, point: point ?? math.getPublicKey(scalar, false) };
}
/** The curve an OID element (tag, length and value) names. */
function curveOfOid(oid: Uint8Array): EcCurveName | undefined {
  const hex = hexOf(oid);
  return (Object.keys(CURVES) as EcCurveName[]).find((name) => CURVES[name].oid === hex);
}
/** A SEC1 ECPrivateKey: its curve from its own parameters, or the one its container named. */
function fromSec1(der: Uint8Array, named?: EcCurveName): AsymmetricKey {
  const parts = children(only(der, 0x30));
  const secret = parts[1];
  if (parts[0]?.tag !== 0x02 || secret?.tag !== 0x04) throw new Error('shape');
  let curve = named, point: Uint8Array | undefined;
  for (const part of parts.slice(2)) {
    if (part.tag === 0xa0) curve = curveOfOid(part.content) ?? curve;
    if (part.tag === 0xa1) point = only(part.content, 0x03).subarray(1);
  }
  if (!curve) throw new Error('curve');
  return ecFromSecret(curve, secret.content, point);
}
function fromSpki(der: Uint8Array): AsymmetricKey {
  const [algorithm, bits] = children(only(der, 0x30));
  if (algorithm?.tag !== 0x30 || bits?.tag !== 0x03) throw new Error('shape');
  const ids = children(algorithm.content).map((id) => hexOf(concat(Uint8Array.from([id.tag, id.content.length]), id.content)));
  const point = bits.content.subarray(1);
  if (ids[0] === OID_ED25519) return { kind: 'ed25519', point: point.slice() };
  const curve = ids[0] === OID_EC_PUBLIC_KEY ? (Object.keys(CURVES) as EcCurveName[]).find((name) => CURVES[name].oid === ids[1]) : undefined;
  if (!curve) throw new Error('algorithm');
  return { kind: 'ec', curve, point: point.slice() };
}
function fromPkcs8(der: Uint8Array): AsymmetricKey {
  const [version, algorithm, inner] = children(only(der, 0x30));
  if (version?.tag !== 0x02 || algorithm?.tag !== 0x30 || inner?.tag !== 0x04) throw new Error('shape');
  const ids = children(algorithm.content).map((id) => hexOf(concat(Uint8Array.from([id.tag, id.content.length]), id.content)));
  if (ids[0] === OID_ED25519) {
    const secret = only(inner.content, 0x04).slice();
    return { kind: 'ed25519', secret, point: ed25519.getPublicKey(secret) };
  }
  const curve = ids[0] === OID_EC_PUBLIC_KEY ? (Object.keys(CURVES) as EcCurveName[]).find((name) => CURVES[name].oid === ids[1]) : undefined;
  if (!curve) throw new Error('algorithm');
  return fromSec1(inner.content, curve);
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
    try { return read(der); } catch { /* not this encoding */ }
  }
  return undefined;
}
/** The same from PEM, by its label. Undefined for another label or another kind of key. */
export function keyFromPem(pem: string): AsymmetricKey | undefined {
  const found = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!found) return undefined;
  const type: KeyEncodingType | undefined = found[1] === 'PUBLIC KEY' ? 'spki' : found[1] === 'PRIVATE KEY' ? 'pkcs8' : found[1] === 'EC PRIVATE KEY' ? 'sec1' : undefined;
  return type ? keyFromDer(base64Bytes(found[2]!), type) : undefined;
}
export function keyFromJwk(jwk: Record<string, unknown>): AsymmetricKey | undefined {
  const bytes = (value: unknown): Uint8Array | undefined => typeof value === 'string' ? base64Bytes(value) : undefined;
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    const point = bytes(jwk.x), secret = bytes(jwk.d);
    if (!point || point.length !== 32) return undefined;
    return secret ? { kind: 'ed25519', secret, point } : { kind: 'ed25519', point };
  }
  const curve = jwk.kty === 'EC' ? curveNamed(jwk.crv) : undefined;
  if (!curve) return undefined;
  const width = CURVES[curve].bytes, x = bytes(jwk.x), y = bytes(jwk.y), secret = bytes(jwk.d);
  if (!x || !y) return undefined;
  const point = concat(Uint8Array.from([4]), padded(x, width), padded(y, width));
  return secret ? ecFromSecret(curve, secret, point) : { kind: 'ec', curve, point };
}

function spkiOf(key: AsymmetricKey): Uint8Array {
  const algorithm = key.kind === 'ed25519' ? tlv(0x30, fromHex(OID_ED25519)) : tlv(0x30, fromHex(OID_EC_PUBLIC_KEY), fromHex(CURVES[key.curve].oid));
  return tlv(0x30, algorithm, tlv(0x03, Uint8Array.from([0]), key.point));
}
function sec1Of(key: AsymmetricKey & { kind: 'ec' }, withParameters: boolean): Uint8Array {
  return tlv(0x30, fromHex('020101'), tlv(0x04, key.secret!),
    ...(withParameters ? [tlv(0xa0, fromHex(CURVES[key.curve].oid))] : []),
    tlv(0xa1, tlv(0x03, Uint8Array.from([0]), key.point)));
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

/** ECDSA over the digest the caller made, or Ed25519 over the message itself (`digest` undefined). */
export function signWith(key: AsymmetricKey, message: Uint8Array, digest: Uint8Array | undefined, encoding: DsaEncoding): Uint8Array {
  if (key.kind === 'ed25519') return ed25519.sign(message, key.secret!);
  return CURVES[key.curve].curve.sign(digest!, key.secret!, { prehash: false, lowS: false, format: encoding === 'der' ? 'der' : 'compact' });
}
export function verifyWith(key: AsymmetricKey, message: Uint8Array, digest: Uint8Array | undefined, signature: Uint8Array, encoding: DsaEncoding): boolean {
  try {
    if (key.kind === 'ed25519') return ed25519.verify(signature, message, key.point);
    return CURVES[key.curve].curve.verify(signature, digest!, key.point, { prehash: false, lowS: false, format: encoding === 'der' ? 'der' : 'compact' });
  } catch { return false; }
}
