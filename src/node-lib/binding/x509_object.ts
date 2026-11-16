/**
 * A certificate as the object `getPeerCertificate()` answers: the V8 half of Node's `X509ToObject`
 * (src/crypto/crypto_x509.cc:720-855) and of `GetPeerCert`'s issuer walk (src/crypto/crypto_common.cc:80-171), over
 * their OpenSSL half in the program (native/node/crypto_x509.cc), over ncrypto's X509View in the program. ADR-0016 §3.
 */
import { Buffer } from '../buffer-module';
import { address } from './program';
import { mallocAnswer as answer, openssl, outAnswer, withBytes, withScratch, word, copyOut } from './openssl';
import { bufferSource, checked, glue, rethrow } from './crypto_util';
import { handleFromKeyData, handleOf } from './crypto_keys';

type Certificate = Record<string, unknown>;
const latin1 = (bytes: Uint8Array | null): string | undefined =>
  bytes === null ? undefined : new TextDecoder('latin1').decode(bytes);
const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** GetX509NameObject (crypto_x509.cc:611-667): a null-prototype object, an array where a key repeats. */
function nameObject(x: number, issuer: boolean): Record<string, unknown> | undefined {
  const bytes = answer((lengthAt) => openssl().tabnode_x509_name(x, issuer ? 1 : 0, lengthAt));
  if (bytes === null) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  const parts = utf8(bytes).split('\0');
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const key = parts[index]!;
    const value = parts[index + 1]!;
    if (key in result) {
      const accumulated = result[key];
      if (Array.isArray(accumulated)) accumulated.push(value);
      else result[key] = [accumulated, value];
      continue;
    }
    result[key] = value;
  }
  return result;
}

/** X509ToObject (crypto_x509.cc:720-855) of the certificate `x` (an `X509*` in the process's memory). */
export function x509ToObject(x: number): Certificate {
  const deps = openssl();
  const text = (field: number) => latin1(answer((lengthAt) => deps.tabnode_x509_text(x, field, lengthAt)));
  const usage = answer((lengthAt) => deps.tabnode_x509_key_usage(x, lengthAt));
  const pubkey = answer((lengthAt) => deps.tabnode_x509_pubkey(x, lengthAt));
  const bits = deps.tabnode_x509_bits(x);
  const raw = outAnswer((outAt) => deps.tabnode_x509_der(x, outAt))!;
  return {
    subject: nameObject(x, false),
    issuer: nameObject(x, true),
    subjectaltname: text(0),
    infoAccess: text(1),
    ca: deps.tabnode_x509_is_ca(x) !== 0,
    modulus: text(8),
    exponent: text(9),
    pubkey: pubkey === null ? undefined : Buffer.from(pubkey),
    bits: bits < 0 ? undefined : bits,
    valid_from: text(2),
    valid_to: text(3),
    fingerprint: text(4),
    fingerprint256: text(5),
    fingerprint512: text(6),
    ext_key_usage: usage === null ? undefined : latin1(usage)!.split('\0').slice(0, -1),
    serialNumber: text(7),
    raw: Buffer.from(raw),
    asn1Curve: text(10),
    nistCurve: text(11),
  };
}

/** A DER certificate copied into the process's memory, parsed into a new `X509*` there (freed by the caller). */
function x509FromDer(der: Uint8Array): number {
  return withBytes(der, (at, length) => openssl().tabnode_x509_from_der(at, length)) >>> 0;
}

/**
 * GetPeerCert (crypto_common.cc:289-345): the peer's certificate, or, `detailed`, with `issuerCertificate` linked
 * through the peer's chain (AddIssuerChainToObject) and then the context's store (GetLastIssuedCert), the last one
 * pointing at itself when self-signed. On a client the chain holds the leaf; on a server it does not.
 */
export function peerCertificate(ssl: number, abbreviated: boolean, isServer: boolean): Certificate | undefined {
  const deps = openssl();
  const ders: Uint8Array[] = [];
  if (isServer) {
    const leaf = outAnswer((outAt) => deps.tabnode_ssl_peer_certificate(ssl, outAt));
    if (leaf) ders.push(leaf);
  }
  const chainLength = deps.tabnode_ssl_peer_chain_length(ssl);
  for (let index = 0; index < chainLength; index++) {
    const der = outAnswer((outAt) => deps.tabnode_ssl_peer_chain_certificate(ssl, index, outAt));
    if (der) ders.push(der);
  }
  if (ders.length === 0) return undefined;
  const certs = ders.map(x509FromDer);
  try {
    const first = x509ToObject(certs[0]!);
    if (abbreviated) return first;
    // AddIssuerChainToObject (crypto_common.cc:103-137).
    let cert = certs.shift()!;
    let object = first;
    const owned = [cert];
    for (;;) {
      const index = certs.findIndex((ca) => deps.tabnode_x509_issued_by(cert, ca) !== 0);
      if (index < 0) break;
      const caInfo = x509ToObject(certs[index]!);
      object.issuerCertificate = caInfo;
      object = caInfo;
      cert = certs.splice(index, 1)[0]!;
      owned.push(cert);
    }
    // GetLastIssuedCert (crypto_common.cc:139-171).
    while (deps.tabnode_x509_issued_by(cert, cert) === 0) {
      const ca = deps.tabnode_ssl_issuer_from_store(ssl, cert) >>> 0;
      if (!ca) break;
      const caInfo = x509ToObject(ca);
      object.issuerCertificate = caInfo;
      object = caInfo;
      if (ca === cert) { deps.tabnode_x509_free(ca); break; }
      owned.push(ca);
      cert = ca;
    }
    if (deps.tabnode_x509_issued_by(cert, cert) !== 0) object.issuerCertificate = object;
    for (const x of owned) deps.tabnode_x509_free(x);
    return first;
  } finally {
    for (const x of certs) deps.tabnode_x509_free(x);
  }
}

/** GetCert (crypto_common.cc:76-84): this end's own certificate, or undefined. */
export function ownCertificate(ssl: number): Certificate | undefined {
  const der = outAnswer((outAt) => openssl().tabnode_ssl_certificate(ssl, outAt));
  if (!der) return undefined;
  const x = x509FromDer(der);
  try { return x509ToObject(x); } finally { openssl().tabnode_x509_free(x); }
}

const certificates = new FinalizationRegistry<number>((x) => openssl().tabnode_x509_free(x));

/**
 * X509Certificate (crypto_x509.cc:805-920), the handle `internal/crypto/x509`'s X509Certificate holds: an `X509*` in
 * the process's memory, freed with the object, and the certificate that issued it where a TLS peer's chain gave one
 * (`getIssuerCert`). Every answer is OpenSSL's: WebCrypto has no certificate (ADR-0018 §5).
 */
export class X509Certificate {
  private readonly x: number;
  private readonly issuerCert: X509Certificate | undefined;
  constructor(x: number, issuer?: X509Certificate) {
    this.x = x;
    this.issuerCert = issuer;
    certificates.register(this, x);
  }

  private text(field: number): string | undefined {
    const bytes = answer((lengthAt) => openssl().tabnode_x509_text(this.x, field, lengthAt));
    return bytes === null ? undefined : new TextDecoder('latin1').decode(bytes);
  }

  /** Subject, SubjectAltName, Issuer, InfoAccess, ValidFrom, ValidTo (297-356). */
  subject(): string | undefined { return this.text(15); }
  subjectAltName(): string | undefined { return this.text(0); }
  issuer(): string | undefined { return this.text(16); }
  infoAccess(): string | undefined { return this.text(1); }
  validFrom(): string | undefined { return this.text(2); }
  validTo(): string | undefined { return this.text(3); }
  /** ValidFromDate, ValidToDate (357-376): a Date of the time. */
  validFromDate(): Date { return new Date(openssl().tabnode_x509_valid_time(this.x, 0) * 1000); }
  validToDate(): Date { return new Date(openssl().tabnode_x509_valid_time(this.x, 1) * 1000); }
  /** Fingerprint (90-98) of SHA-1, SHA-256, SHA-512. */
  fingerprint(): string | undefined { return this.text(4); }
  fingerprint256(): string | undefined { return this.text(5); }
  fingerprint512(): string | undefined { return this.text(6); }
  /** SignatureAlgorithm, SignatureAlgorithmOID (377-396). */
  signatureAlgorithm(): string | undefined { return this.text(13); }
  signatureAlgorithmOid(): string | undefined { return this.text(14); }
  /** SerialNumber (397-405). */
  serialNumber(): string | undefined { return this.text(7); }
  /** KeyUsage (428-436): the usages, or undefined. */
  keyUsage(): string[] | undefined {
    const usage = answer((lengthAt) => openssl().tabnode_x509_key_usage(this.x, lengthAt));
    return usage === null ? undefined : new TextDecoder('latin1').decode(usage).split('\0').slice(0, -1);
  }
  /** Pem (277-285), Der (287-295). */
  pem(): string | undefined { return this.text(12); }
  raw(): Buffer { return Buffer.from(outAnswer((outAt) => openssl().tabnode_x509_der(this.x, outAt))!); }
  /** PublicKey (407-426): a KeyObjectHandle of the certificate's key. */
  publicKey(): unknown {
    const key = address(openssl().tabnode_x509_public_key(this.x));
    rethrow();
    return handleFromKeyData(key);
  }
  /** CheckCA (438-442), CheckIssued (444-453). */
  checkCA(): boolean { return openssl().tabnode_x509_is_ca(this.x) !== 0; }
  checkIssued(other: X509Certificate): boolean { return openssl().tabnode_x509_issued_by(this.x, other.x) !== 0; }
  /** CheckPrivateKey (455-464), CheckPublicKey as `verify` (466-479). */
  checkPrivateKey(key: unknown): boolean {
    return openssl().tabnode_x509_check_private_key(this.x, handleOf(key).opensslKey()) !== 0;
  }
  verify(key: unknown): boolean {
    return openssl().tabnode_x509_check_public_key(this.x, handleOf(key).opensslKey()) !== 0;
  }
  /** CheckHost, CheckEmail, CheckIP (481-538): the subject (or the name OpenSSL matched), undefined for none. */
  checkHost(name: string, flags: number): string | undefined { return this.check(0, name, flags); }
  checkEmail(name: string, flags: number): string | undefined { return this.check(1, name, flags); }
  checkIP(name: string, flags: number): string | undefined { return this.check(2, name, flags); }
  private check(which: number, name: string, flags: number): string | undefined {
    const exports = glue();
    return withScratch(8, (out) => withBytes(String(name), (at, length) => {
      const result = checked(exports.tabnode_x509_check_subject(this.x, which, at, length, flags >>> 0, out, out + 4));
      if (result !== 1) return undefined;
      const matched = word(out);
      if (!matched) return name;
      const text = new TextDecoder('latin1').decode(copyOut(matched, word(out + 4)));
      exports.tabnode_free(matched);
      return text;
    }));
  }
  /** ToLegacy (567-576): the object getPeerCertificate() answers. */
  toLegacy(): Record<string, unknown> { return x509ToObject(this.x); }
  /** GetIssuerCert (540-545). */
  getIssuerCert(): X509Certificate | undefined { return this.issuerCert; }
}

/** Parse (547-565): `parseX509` of the binding. */
function parseX509(buffer: unknown): X509Certificate {
  const x = withBytes(bufferSource(buffer), (at, length) => address(openssl().tabnode_x509_parse(at, length)));
  rethrow();
  return new X509Certificate(x);
}

/** A certificate's handle of DER bytes (a TLS peer's chain), its issuer's handle beside it. */
export function x509CertificateOf(der: Uint8Array, issuer?: X509Certificate): X509Certificate {
  return new X509Certificate(x509FromDer(der), issuer);
}

export const x509Binding = { parseX509 };
