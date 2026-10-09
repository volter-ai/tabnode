/**
 * RSA keys held as their own numbers, so everything about them is synchronous: the encodings Node reads and writes
 * (PKCS#8, PKCS#1 and SPKI, as DER), RSASSA-PKCS1-v1_5 and RSASSA-PSS signatures, RSAES-OAEP and RSAES-PKCS1-v1_5
 * encryption, and key generation. WebCrypto has these and none synchronously, and a program's
 * `crypto.sign('sha256', data, key)`, `createSign('RSA-SHA256').sign(key)` or `jsonwebtoken.sign(…, { algorithm:
 * 'RS256' })` cannot wait: each is one synchronous call in Node, and a server makes it per request.
 *
 * The arithmetic is BigInt modular exponentiation, the private operation by the Chinese remainder theorem
 * (RFC 8017 section 5.1.2). A PKCS #1 v1.5 signature is a function of the key and the bytes, so what this file
 * signs is byte for byte what OpenSSL signs. This file knows no Buffer and no engine: bytes in, bytes out; the
 * digest and the random bytes are the caller's.
 *
 * NOT CONSTANT TIME. BigInt arithmetic takes time that depends on its operands, as every pure-JavaScript RSA
 * does. A key used here signs in a tab, for the page that holds it; it is not a defence against an attacker who
 * can time the private operation.
 */

export interface RsaKey {
  n: bigint; e: bigint;
  /** The private half: absent in a public key. */
  d?: bigint; p?: bigint; q?: bigint; dp?: bigint; dq?: bigint; qi?: bigint;
}
export type RsaEncoding = 'pkcs1' | 'pkcs8' | 'spki';
export type Digest = (name: string, bytes: Uint8Array) => Uint8Array;
export type RandomBytes = (length: number) => Uint8Array;

// ---------------------------------------------------------------------------------------------------------------
// DER, as much of it as an RSA key is written in.

const OID_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_RSA_PSS = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a];

interface Tlv { tag: number; value: Uint8Array; end: number }
function tlv(bytes: Uint8Array, at: number): Tlv | undefined {
  if (at + 2 > bytes.length) return undefined;
  const tag = bytes[at]!;
  let length = bytes[at + 1]!, offset = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + count > bytes.length) return undefined;
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + bytes[offset + index]!;
    offset += count;
  }
  if (offset + length > bytes.length) return undefined;
  return { tag, value: bytes.subarray(offset, offset + length), end: offset + length };
}
/** The members of a SEQUENCE's value, or undefined where the bytes are not whole members. */
function members(value: Uint8Array): Tlv[] | undefined {
  const found: Tlv[] = [];
  let at = 0;
  while (at < value.length) {
    const next = tlv(value, at);
    if (!next) return undefined;
    found.push(next);
    at = next.end;
  }
  return found;
}
function integer(part: Tlv | undefined): bigint | undefined {
  if (!part || part.tag !== 0x02 || part.value.length === 0) return undefined;
  let value = 0n;
  for (const byte of part.value) value = (value << 8n) | BigInt(byte);
  return value;
}
function sameBytes(a: Uint8Array, b: readonly number[]): boolean {
  return a.length === b.length && b.every((byte, index) => a[index] === byte);
}
function rsaAlgorithm(part: Tlv | undefined): boolean {
  if (!part || part.tag !== 0x30) return false;
  const oid = members(part.value)?.[0];
  return oid !== undefined && oid.tag === 0x06 && (sameBytes(oid.value, OID_RSA) || sameBytes(oid.value, OID_RSA_PSS));
}
function privateFrom(sequence: Tlv | undefined): RsaKey | undefined {
  if (!sequence || sequence.tag !== 0x30) return undefined;
  const parts = members(sequence.value);
  if (!parts || parts.length < 9) return undefined;
  const numbers = parts.slice(0, 9).map(integer);
  if (numbers.some((value) => value === undefined) || numbers[0] !== 0n) return undefined;
  const [, n, e, d, p, q, dp, dq, qi] = numbers as bigint[];
  return { n: n!, e: e!, d: d!, p: p!, q: q!, dp: dp!, dq: dq!, qi: qi! };
}
function publicFrom(sequence: Tlv | undefined): RsaKey | undefined {
  if (!sequence || sequence.tag !== 0x30) return undefined;
  const parts = members(sequence.value);
  if (!parts || parts.length !== 2) return undefined;
  const n = integer(parts[0]), e = integer(parts[1]);
  return n === undefined || e === undefined ? undefined : { n, e };
}

/**
 * An RSA key from DER in any of the four forms it is written in: PKCS#8 (`PRIVATE KEY`), PKCS#1 private
 * (`RSA PRIVATE KEY`), SubjectPublicKeyInfo (`PUBLIC KEY`) and PKCS#1 public (`RSA PUBLIC KEY`). Undefined where
 * the bytes are not an RSA key, so the caller's other readers can have them.
 */
export function keyFromDer(der: Uint8Array): RsaKey | undefined {
  const outer = tlv(der, 0);
  if (!outer || outer.tag !== 0x30) return undefined;
  const parts = members(outer.value);
  if (!parts || parts.length < 2) return undefined;
  // PKCS#8: version, algorithm, OCTET STRING of the PKCS#1 key.
  if (parts.length >= 3 && parts[0]!.tag === 0x02 && rsaAlgorithm(parts[1]) && parts[2]!.tag === 0x04) return privateFrom(tlv(parts[2]!.value, 0));
  // SubjectPublicKeyInfo: algorithm, BIT STRING of the PKCS#1 public key behind its count of unused bits.
  if (parts.length === 2 && rsaAlgorithm(parts[0]) && parts[1]!.tag === 0x03 && parts[1]!.value[0] === 0) return publicFrom(tlv(parts[1]!.value.subarray(1), 0));
  if (parts.length >= 9 && parts.every((part) => part.tag === 0x02)) return privateFrom(outer);
  if (parts.length === 2 && parts.every((part) => part.tag === 0x02)) return publicFrom(outer);
  return undefined;
}

function encodeLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}
function encode(tag: number, ...contents: Array<Uint8Array | readonly number[]>): Uint8Array {
  const length = contents.reduce((sum, part) => sum + part.length, 0);
  const head = [tag, ...encodeLength(length)];
  const out = new Uint8Array(head.length + length);
  out.set(head, 0);
  let at = head.length;
  for (const part of contents) { out.set(part, at); at += part.length; }
  return out;
}
/** A number's big-endian bytes at exactly `length`, or at its own width. */
export function bytesOf(value: bigint, length?: number): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const own = new Uint8Array(hex.length / 2);
  for (let index = 0; index < own.length; index += 1) own[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  if (length === undefined || own.length === length) return own;
  if (own.length > length) throw new RangeError('integer too long');
  const out = new Uint8Array(length);
  out.set(own, length - own.length);
  return out;
}
function numberOf(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}
function encodeInteger(value: bigint): Uint8Array {
  const own = bytesOf(value);
  return own[0]! & 0x80 ? encode(0x02, [0], own) : encode(0x02, own);
}
const ALGORITHM = encode(0x30, encode(0x06, OID_RSA), [0x05, 0x00]);

/** The key in the encoding asked, as DER, written as OpenSSL writes it. A public key has no PKCS#8. */
export function derOf(key: RsaKey, type: RsaEncoding): Uint8Array {
  const publicKey = encode(0x30, encodeInteger(key.n), encodeInteger(key.e));
  if (type === 'spki') return encode(0x30, ALGORITHM, encode(0x03, [0], publicKey));
  if (key.d === undefined) {
    if (type === 'pkcs1') return publicKey;
    throw new TypeError('A public key has no PKCS#8 encoding');
  }
  const privateKey = encode(0x30, encodeInteger(0n), encodeInteger(key.n), encodeInteger(key.e), encodeInteger(key.d), encodeInteger(key.p!), encodeInteger(key.q!), encodeInteger(key.dp!), encodeInteger(key.dq!), encodeInteger(key.qi!));
  return type === 'pkcs1' ? privateKey : encode(0x30, encodeInteger(0n), ALGORITHM, encode(0x04, privateKey));
}
export function publicOf(key: RsaKey): RsaKey { return { n: key.n, e: key.e }; }
export function modulusBits(key: RsaKey): number { return key.n.toString(2).length; }
function modulusBytes(key: RsaKey): number { return Math.ceil(modulusBits(key) / 8); }

// ---------------------------------------------------------------------------------------------------------------
// The two primitives.

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n, power = base % modulus, rest = exponent;
  while (rest > 0n) {
    if (rest & 1n) result = (result * power) % modulus;
    power = (power * power) % modulus;
    rest >>= 1n;
  }
  return result;
}
function publicOperation(key: RsaKey, value: bigint): bigint {
  if (value >= key.n) throw new RangeError('message representative out of range');
  return modPow(value, key.e, key.n);
}
function privateOperation(key: RsaKey, value: bigint): bigint {
  if (key.d === undefined) throw new TypeError('Invalid key object type public, expected private.');
  if (value >= key.n) throw new RangeError('message representative out of range');
  const { p, q, dp, dq, qi } = key;
  if (p === undefined || q === undefined || dp === undefined || dq === undefined || qi === undefined) return modPow(value, key.d, key.n);
  const m1 = modPow(value % p, dp, p), m2 = modPow(value % q, dq, q);
  const h = (qi * ((m1 - m2) % p + p)) % p;
  return m2 + q * h;
}

// ---------------------------------------------------------------------------------------------------------------
// Signatures.

/** The DigestInfo each digest is wrapped in before it is padded (RFC 8017 section 9.2, note 1). */
const DIGEST_INFO: Readonly<Record<string, { prefix: readonly number[]; length: number }>> = {
  sha1: { prefix: [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14], length: 20 },
  sha224: { prefix: [0x30, 0x2d, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x04, 0x05, 0x00, 0x04, 0x1c], length: 28 },
  sha256: { prefix: [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20], length: 32 },
  sha384: { prefix: [0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0x05, 0x00, 0x04, 0x30], length: 48 },
  sha512: { prefix: [0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0x05, 0x00, 0x04, 0x40], length: 64 },
};
/** The digest a signature algorithm's name asks for (`RSA-SHA256`, `sha256`, `SHA-256`), or undefined. */
export function digestNamed(algorithm: string): string | undefined {
  const name = algorithm.toLowerCase().replace(/^rsa-/u, '').replace(/[^a-z0-9]/gu, '');
  return DIGEST_INFO[name] ? name : undefined;
}

function pkcs1Encoded(digestName: string, hash: Uint8Array, length: number): Uint8Array {
  const info = DIGEST_INFO[digestName]!;
  const padding = length - info.prefix.length - hash.length - 3;
  if (padding < 8) throw new RangeError('intended encoded message length too short');
  const out = new Uint8Array(length).fill(0xff);
  out[0] = 0x00; out[1] = 0x01; out[2 + padding] = 0x00;
  out.set(info.prefix, 3 + padding);
  out.set(hash, 3 + padding + info.prefix.length);
  return out;
}
export function signPkcs1(key: RsaKey, digestName: string, data: Uint8Array, digest: Digest): Uint8Array {
  const length = modulusBytes(key);
  return bytesOf(privateOperation(key, numberOf(pkcs1Encoded(digestName, digest(digestName, data), length))), length);
}
export function verifyPkcs1(key: RsaKey, digestName: string, data: Uint8Array, signature: Uint8Array, digest: Digest): boolean {
  const length = modulusBytes(key);
  if (signature.length !== length) return false;
  let made: Uint8Array;
  try { made = bytesOf(publicOperation(key, numberOf(signature)), length); } catch { return false; }
  // The expected encoding is made again and compared whole: nothing of the signature's own padding is parsed.
  const expected = pkcs1Encoded(digestName, digest(digestName, data), length);
  let difference = 0;
  for (let index = 0; index < length; index += 1) difference |= made[index]! ^ expected[index]!;
  return difference === 0;
}

function mgf1(seed: Uint8Array, length: number, digestName: string, digest: Digest): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (let counter = 0; at < length; counter += 1) {
    const input = new Uint8Array(seed.length + 4);
    input.set(seed, 0);
    input.set([(counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff], seed.length);
    const block = digest(digestName, input);
    out.set(block.subarray(0, Math.min(block.length, length - at)), at);
    at += block.length;
  }
  return out;
}
/** RSASSA-PSS (RFC 8017 section 8.1), MGF1 over the same digest. A salt length of -1 is the digest's, -2 the largest that fits. */
export function signPss(key: RsaKey, digestName: string, data: Uint8Array, saltLength: number, digest: Digest, random: RandomBytes): Uint8Array {
  const bits = modulusBits(key) - 1, length = Math.ceil(bits / 8), hashLength = DIGEST_INFO[digestName]!.length;
  const saltBytes = saltLength === -1 ? hashLength : saltLength < 0 ? length - hashLength - 2 : saltLength;
  if (length < hashLength + saltBytes + 2) throw new RangeError('encoding error');
  const hash = digest(digestName, data), salt = random(saltBytes);
  const first = new Uint8Array(8 + hashLength + saltBytes);
  first.set(hash, 8); first.set(salt, 8 + hashLength);
  const h = digest(digestName, first);
  const db = new Uint8Array(length - hashLength - 1);
  db[db.length - saltBytes - 1] = 0x01;
  db.set(salt, db.length - saltBytes);
  const mask = mgf1(h, db.length, digestName, digest);
  for (let index = 0; index < db.length; index += 1) db[index]! ^= mask[index]!;
  db[0]! &= 0xff >>> (8 * length - bits);
  const encoded = new Uint8Array(length);
  encoded.set(db, 0); encoded.set(h, db.length); encoded[length - 1] = 0xbc;
  return bytesOf(privateOperation(key, numberOf(encoded)), modulusBytes(key));
}
export function verifyPss(key: RsaKey, digestName: string, data: Uint8Array, signature: Uint8Array, saltLength: number, digest: Digest): boolean {
  const bits = modulusBits(key) - 1, length = Math.ceil(bits / 8), hashLength = DIGEST_INFO[digestName]!.length;
  if (signature.length !== modulusBytes(key)) return false;
  let whole: Uint8Array;
  try { whole = bytesOf(publicOperation(key, numberOf(signature)), modulusBytes(key)); } catch { return false; }
  const encoded = whole.subarray(whole.length - length);
  if (whole.subarray(0, whole.length - length).some((byte) => byte !== 0)) return false;
  if (length < hashLength + 2 || encoded[length - 1] !== 0xbc) return false;
  const db = encoded.slice(0, length - hashLength - 1), h = encoded.subarray(length - hashLength - 1, length - 1);
  if (db[0]! & ~(0xff >>> (8 * length - bits)) & 0xff) return false;
  const mask = mgf1(h, db.length, digestName, digest);
  for (let index = 0; index < db.length; index += 1) db[index]! ^= mask[index]!;
  db[0]! &= 0xff >>> (8 * length - bits);
  // The salt is what follows the 0x01 that ends the zeros; a caller that names its length is held to it.
  let at = 0;
  while (at < db.length && db[at] === 0) at += 1;
  if (at === db.length || db[at] !== 0x01) return false;
  const salt = db.subarray(at + 1);
  if (saltLength >= 0 && salt.length !== saltLength) return false;
  if (saltLength === -1 && salt.length !== hashLength) return false;
  const first = new Uint8Array(8 + hashLength + salt.length);
  first.set(digest(digestName, data), 8); first.set(salt, 8 + hashLength);
  const expected = digest(digestName, first);
  let difference = 0;
  for (let index = 0; index < hashLength; index += 1) difference |= expected[index]! ^ h[index]!;
  return difference === 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Encryption.

export function encryptOaep(key: RsaKey, message: Uint8Array, digestName: string, label: Uint8Array, digest: Digest, random: RandomBytes): Uint8Array {
  const length = modulusBytes(key), hashLength = DIGEST_INFO[digestName]!.length;
  if (message.length > length - 2 * hashLength - 2) throw new RangeError('data too large for key size');
  const db = new Uint8Array(length - hashLength - 1);
  db.set(digest(digestName, label), 0);
  db[db.length - message.length - 1] = 0x01;
  db.set(message, db.length - message.length);
  const seed = random(hashLength);
  const dbMask = mgf1(seed, db.length, digestName, digest);
  for (let index = 0; index < db.length; index += 1) db[index]! ^= dbMask[index]!;
  const seedMask = mgf1(db, hashLength, digestName, digest);
  const encoded = new Uint8Array(length);
  for (let index = 0; index < hashLength; index += 1) encoded[1 + index] = seed[index]! ^ seedMask[index]!;
  encoded.set(db, 1 + hashLength);
  return bytesOf(publicOperation(key, numberOf(encoded)), length);
}
export function decryptOaep(key: RsaKey, ciphertext: Uint8Array, digestName: string, label: Uint8Array, digest: Digest): Uint8Array {
  const length = modulusBytes(key), hashLength = DIGEST_INFO[digestName]!.length;
  const refused = (): never => { throw new Error('error:02000079:rsa routines::oaep decoding error'); };
  if (ciphertext.length !== length || length < 2 * hashLength + 2) refused();
  const encoded = bytesOf(privateOperation(key, numberOf(ciphertext)), length);
  const seed = encoded.slice(1, 1 + hashLength), db = encoded.slice(1 + hashLength);
  const seedMask = mgf1(db, hashLength, digestName, digest);
  for (let index = 0; index < hashLength; index += 1) seed[index]! ^= seedMask[index]!;
  const dbMask = mgf1(seed, db.length, digestName, digest);
  for (let index = 0; index < db.length; index += 1) db[index]! ^= dbMask[index]!;
  const labelHash = digest(digestName, label);
  let difference = encoded[0]!;
  for (let index = 0; index < hashLength; index += 1) difference |= db[index]! ^ labelHash[index]!;
  let at = hashLength;
  while (at < db.length && db[at] === 0) at += 1;
  if (difference !== 0 || at === db.length || db[at] !== 0x01) refused();
  return db.slice(at + 1);
}
export function encryptPkcs1(key: RsaKey, message: Uint8Array, random: RandomBytes): Uint8Array {
  const length = modulusBytes(key);
  if (message.length > length - 11) throw new RangeError('data too large for key size');
  const encoded = new Uint8Array(length);
  encoded[1] = 0x02;
  const padding = length - message.length - 3;
  // Each padding byte is nonzero: a zero drawn is drawn again.
  let filled = 0;
  while (filled < padding) for (const byte of random(padding - filled)) if (byte !== 0 && filled < padding) { encoded[2 + filled] = byte; filled += 1; }
  encoded.set(message, length - message.length);
  return bytesOf(publicOperation(key, numberOf(encoded)), length);
}
export function decryptPkcs1(key: RsaKey, ciphertext: Uint8Array): Uint8Array {
  const length = modulusBytes(key);
  const refused = (): never => { throw new Error('error:02000084:rsa routines::data too large for modulus'); };
  if (ciphertext.length !== length) refused();
  const encoded = bytesOf(privateOperation(key, numberOf(ciphertext)), length);
  let at = 2;
  while (at < length && encoded[at] !== 0) at += 1;
  if (encoded[0] !== 0 || encoded[1] !== 0x02 || at < 10 || at === length) throw new Error('error:0200009F:rsa routines::pkcs decoding error');
  return encoded.slice(at + 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Generation.

const SMALL_PRIMES: readonly bigint[] = (() => {
  const found: bigint[] = [];
  for (let candidate = 3; found.length < 400; candidate += 2) if (found.every((prime) => candidate % Number(prime) !== 0)) found.push(BigInt(candidate));
  return found;
})();
function probablyPrime(candidate: bigint, rounds: number, random: RandomBytes): boolean {
  for (const prime of SMALL_PRIMES) { if (candidate === prime) return true; if (candidate % prime === 0n) return false; }
  let odd = candidate - 1n, twos = 0;
  while ((odd & 1n) === 0n) { odd >>= 1n; twos += 1; }
  const width = Math.ceil(candidate.toString(2).length / 8);
  for (let round = 0; round < rounds; round += 1) {
    const witness = 2n + numberOf(random(width)) % (candidate - 3n);
    let value = modPow(witness, odd, candidate);
    if (value === 1n || value === candidate - 1n) continue;
    let composite = true;
    for (let step = 1; step < twos; step += 1) {
      value = (value * value) % candidate;
      if (value === candidate - 1n) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
}
function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a; }
function inverse(value: bigint, modulus: bigint): bigint {
  let [oldR, r, oldS, s] = [value % modulus, modulus, 1n, 0n];
  while (r) { const quotient = oldR / r; [oldR, r] = [r, oldR - quotient * r]; [oldS, s] = [s, oldS - quotient * s]; }
  return ((oldS % modulus) + modulus) % modulus;
}
function prime(bits: number, e: bigint, random: RandomBytes): bigint {
  const width = Math.ceil(bits / 8);
  for (;;) {
    const bytes = random(width);
    // The two top bits set, so the product of two such primes has exactly twice the bits; odd.
    bytes[0] = (bytes[0]! & (0xff >>> (8 * width - bits))) | (0xc0 >>> (8 * width - bits));
    bytes[width - 1]! |= 1;
    const candidate = numberOf(bytes);
    // Five rounds leave an error under 2^-100 for a 1024-bit candidate (FIPS 186-5, table B.1).
    if (gcd(candidate - 1n, e) === 1n && probablyPrime(candidate, bits >= 1024 ? 5 : 16, random)) return candidate;
  }
}
/** A key pair made here and now. Two primes of half the modulus each are searched for: on the order of a second for 2048 bits. */
export function generateKey(bits: number, publicExponent: bigint, random: RandomBytes): RsaKey {
  if (!Number.isInteger(bits) || bits < 512 || bits % 2 !== 0) throw new RangeError('Invalid modulus length');
  if (publicExponent < 3n || (publicExponent & 1n) === 0n) throw new RangeError('Invalid public exponent');
  for (;;) {
    let p = prime(bits / 2, publicExponent, random), q = prime(bits / 2, publicExponent, random);
    if (p === q) continue;
    if (p < q) [p, q] = [q, p];
    const n = p * q;
    if (n.toString(2).length !== bits) continue;
    const d = inverse(publicExponent, (p - 1n) * (q - 1n) / gcd(p - 1n, q - 1n));
    return { n, e: publicExponent, d, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qi: inverse(q, p) };
  }
}
