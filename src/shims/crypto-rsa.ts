/**
 * RSA signatures made and checked on the caller's own thread: RSASSA-PKCS1-v1_5 (RFC 8017, section 8.2), which is
 * what `createSign('RSA-SHA256').sign(pem)`, `crypto.sign('sha256', data, pem)` and a JWT's RS256 ask for.
 *
 * WebCrypto signs RSA and answers a promise, and Node's `sign` returns its bytes. A caller that signs in the middle
 * of a synchronous function (jsonwebtoken, a twin minting an OAuth token) cannot wait, so the arithmetic is done
 * here, in BigInt: the key's numbers read from its DER (PKCS#8, PKCS#1 or SPKI), the digest wrapped as EMSA-PKCS1-v1_5,
 * and the private operation by the Chinese remainder theorem with the result checked against the public exponent
 * before it leaves (a fault in one half would otherwise give the key away).
 *
 * What this is not: constant time. BigInt's multiplication takes time that depends on its operands, so this does
 * not resist an attacker who measures signing times; a key that must resist one is not a key to sign with in a
 * tab. RSASSA-PSS and OAEP are not here and are refused by name where they are asked for (crypto.ts).
 */

export interface RsaPublicKey { n: bigint; e: bigint }
export interface RsaPrivateKey extends RsaPublicKey { d: bigint; p: bigint; q: bigint; dp: bigint; dq: bigint; qi: bigint }

export class RsaKeyRefused extends Error {}

/** One DER element at `at`: its tag, and where its content starts and ends. */
function element(der: Uint8Array, at: number): { tag: number; start: number; end: number } {
  if (at + 2 > der.byteLength) throw new RsaKeyRefused('the key ends inside an element');
  const tag = der[at]!;
  let length = der[at + 1]!, start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > der.byteLength) throw new RsaKeyRefused('the key has a length this reader does not read');
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + der[start + index]!;
    start += count;
  }
  if (start + length > der.byteLength) throw new RsaKeyRefused('the key ends inside an element');
  return { tag, start, end: start + length };
}

/** The elements of a SEQUENCE's content. */
function children(der: Uint8Array, start: number, end: number): Array<{ tag: number; start: number; end: number }> {
  const found: Array<{ tag: number; start: number; end: number }> = [];
  for (let at = start; at < end;) { const next = element(der, at); found.push(next); at = next.end; }
  return found;
}

function integer(der: Uint8Array, part: { tag: number; start: number; end: number } | undefined): bigint {
  if (!part || part.tag !== 0x02) throw new RsaKeyRefused('the key holds something other than a number where a number is');
  let value = 0n;
  for (let at = part.start; at < part.end; at += 1) value = (value << 8n) | BigInt(der[at]!);
  return value;
}

const RSA_ENCRYPTION = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
function isRsaAlgorithm(der: Uint8Array, algorithm: { tag: number; start: number; end: number }): boolean {
  if (algorithm.tag !== 0x30) return false;
  const oid = children(der, algorithm.start, algorithm.end)[0];
  return oid !== undefined && oid.tag === 0x06 && oid.end - oid.start === RSA_ENCRYPTION.length && RSA_ENCRYPTION.every((byte, index) => der[oid.start + index] === byte);
}

/** An RSA private key's numbers, from PKCS#8 (`PRIVATE KEY`) or PKCS#1 (`RSA PRIVATE KEY`) DER. */
export function rsaPrivateKeyFromDer(der: Uint8Array): RsaPrivateKey {
  const top = element(der, 0);
  if (top.tag !== 0x30) throw new RsaKeyRefused('the key is not a DER sequence');
  const parts = children(der, top.start, top.end);
  // PKCS#8: version, the algorithm, and the PKCS#1 key inside an OCTET STRING.
  if (parts[1]?.tag === 0x30) {
    if (!isRsaAlgorithm(der, parts[1])) throw new RsaKeyRefused('the key is not an RSA key');
    const inner = parts[2];
    if (!inner || inner.tag !== 0x04) throw new RsaKeyRefused('the key holds no private key');
    return rsaPrivateKeyFromDer(der.subarray(inner.start, inner.end));
  }
  if (parts.length < 9) throw new RsaKeyRefused('the key is not an RSA private key');
  if (integer(der, parts[0]) !== 0n) throw new RsaKeyRefused('an RSA key of more than two primes is not read');
  const [n, e, d, p, q, dp, dq, qi] = parts.slice(1, 9).map((part) => integer(der, part)) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  if (n <= 0n || e <= 0n || p <= 1n || q <= 1n || p * q !== n) throw new RsaKeyRefused('the key\'s numbers are not an RSA key\'s');
  return { n, e, d, p, q, dp, dq, qi };
}

/** An RSA public key's numbers, from SPKI (`PUBLIC KEY`) or PKCS#1 (`RSA PUBLIC KEY`) DER. */
export function rsaPublicKeyFromDer(der: Uint8Array): RsaPublicKey {
  const top = element(der, 0);
  if (top.tag !== 0x30) throw new RsaKeyRefused('the key is not a DER sequence');
  const parts = children(der, top.start, top.end);
  if (parts[0]?.tag === 0x30) {
    if (!isRsaAlgorithm(der, parts[0])) throw new RsaKeyRefused('the key is not an RSA key');
    const bits = parts[1];
    // A BIT STRING: one byte of unused bits, then the PKCS#1 key.
    if (!bits || bits.tag !== 0x03 || der[bits.start] !== 0) throw new RsaKeyRefused('the key holds no public key');
    return rsaPublicKeyFromDer(der.subarray(bits.start + 1, bits.end));
  }
  if (parts.length !== 2) throw new RsaKeyRefused('the key is not an RSA public key');
  const n = integer(der, parts[0]), e = integer(der, parts[1]);
  if (n <= 0n || e <= 0n) throw new RsaKeyRefused('the key\'s numbers are not an RSA key\'s');
  return { n, e };
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let left = length; left > 0; left = Math.floor(left / 256)) bytes.unshift(left % 256);
  return [0x80 | bytes.length, ...bytes];
}
function derOf(tag: number, content: readonly number[]): number[] { return [tag, ...derLength(content.length), ...content]; }
function derInteger(value: bigint): number[] {
  const bytes: number[] = [];
  for (let left = value; left > 0n; left >>= 8n) bytes.unshift(Number(left & 0xffn));
  if (bytes.length === 0 || bytes[0]! & 0x80) bytes.unshift(0);
  return derOf(0x02, bytes);
}
/** A public key as SPKI DER (`PUBLIC KEY`): what a private key's public half is exported as. */
export function rsaSpkiOf(key: RsaPublicKey): Uint8Array {
  const pkcs1 = derOf(0x30, [...derInteger(key.n), ...derInteger(key.e)]);
  return Uint8Array.from(derOf(0x30, [...derOf(0x30, [...derOf(0x06, RSA_ENCRYPTION), 0x05, 0x00]), ...derOf(0x03, [0x00, ...pkcs1])]));
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n, power = base % modulus;
  for (let left = exponent; left > 0n; left >>= 1n) {
    if (left & 1n) result = (result * power) % modulus;
    power = (power * power) % modulus;
  }
  return result;
}

function byteLength(n: bigint): number { return Math.ceil(n.toString(2).length / 8); }
function toBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let left = value;
  for (let at = length - 1; at >= 0; at -= 1) { bytes[at] = Number(left & 0xffn); left >>= 8n; }
  return bytes;
}
function fromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** RFC 8017, section 9.2, note 1: the DigestInfo each digest's hash is prefixed with. */
const DIGEST_INFO: Record<string, number[]> = {
  md5: [0x30, 0x20, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05, 0x05, 0x00, 0x04, 0x10],
  sha1: [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14],
  sha224: [0x30, 0x2d, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x04, 0x05, 0x00, 0x04, 0x1c],
  sha256: [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20],
  sha384: [0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0x05, 0x00, 0x04, 0x30],
  sha512: [0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0x05, 0x00, 0x04, 0x40],
};

/** Whether this module signs with the digest of that name. */
export function rsaSignsWith(digest: string): boolean { return Object.hasOwn(DIGEST_INFO, digest); }

/** EMSA-PKCS1-v1_5: 00 01 FF.. 00 DigestInfo hash, as long as the modulus. */
function encoded(digest: string, hash: Uint8Array, length: number): Uint8Array {
  const info = DIGEST_INFO[digest];
  if (!info) throw new RsaKeyRefused(`no RSA signature is made with the digest ${digest}`);
  if (hash.byteLength !== info[info.length - 1]) throw new RsaKeyRefused('the digest is not the length its name gives');
  const total = info.length + hash.byteLength;
  if (length < total + 11) throw new RsaKeyRefused('the key is too short for this digest');
  const message = new Uint8Array(length);
  message[1] = 0x01;
  message.fill(0xff, 2, length - total - 1);
  message.set(info, length - total);
  message.set(hash, length - hash.byteLength);
  return message;
}

/** The signature over `hash`, the `digest`'s hash of the message. */
export function rsaSign(digest: string, hash: Uint8Array, key: RsaPrivateKey): Uint8Array {
  const length = byteLength(key.n);
  const message = fromBytes(encoded(digest, hash, length));
  const first = modPow(message % key.p, key.dp, key.p), second = modPow(message % key.q, key.dq, key.q);
  const lifted = (key.qi * ((first - second) % key.p + key.p)) % key.p;
  const signature = second + lifted * key.q;
  if (modPow(signature, key.e, key.n) !== message) throw new RsaKeyRefused('the signature did not check against the key\'s public half');
  return toBytes(signature, length);
}

/** Whether `signature` is this key's over `hash`. */
export function rsaVerify(digest: string, hash: Uint8Array, key: RsaPublicKey, signature: Uint8Array): boolean {
  const length = byteLength(key.n);
  if (signature.byteLength !== length) return false;
  const given = fromBytes(signature);
  if (given >= key.n) return false;
  let expected: Uint8Array;
  try { expected = encoded(digest, hash, length); } catch { return false; }
  const opened = toBytes(modPow(given, key.e, key.n), length);
  let difference = 0;
  for (let at = 0; at < length; at += 1) difference |= opened[at]! ^ expected[at]!;
  return difference === 0;
}
