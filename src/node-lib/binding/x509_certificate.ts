/**
 * The `crypto` binding's X509Certificate handle, as `parseX509` answers it: the V8 half of Node's
 * src/crypto/crypto_x509.cc (277-567, and Initialize's constants, 979-987) over the export layer's OpenSSL half
 * (scripts/node-deps/tabnode_deps.cc, "X509Certificate"). ADR-0016 §3. Each method names the lines it carries.
 *
 * A key crosses as its DER, the engine's `KeyObject` being the engine's own (ADR-0016 §5): `publicKey` answers the
 * certificate's SubjectPublicKeyInfo, which the `crypto` module makes its `KeyObject` of, and `checkPrivateKey` and
 * `verify` take a key's PKCS#8 and SubjectPublicKeyInfo DER where Node's take its `KeyObjectHandle`.
 */
import { Buffer } from '../buffer-module';
import { mallocAnswer, nodeDeps, opensslError, outAnswer, withBytes, withScratch } from './node-deps';
import { x509ToObject } from './x509_object';

const utf8 = (bytes: Uint8Array | null): string | undefined => bytes === null ? undefined : new TextDecoder().decode(bytes);

/** Text fields of the export layer's `tn_x509_text` (tabnode_deps.cc lists them). */
const TEXT = { subjectAltName: 0, infoAccess: 1, validFrom: 2, validTo: 3, fingerprint: 4, fingerprint256: 5,
  fingerprint512: 6, serialNumber: 7, pem: 12, signatureAlgorithm: 13, signatureAlgorithmOid: 14, subject: 15,
  issuer: 16 } as const;

/** X509View::CheckMatch (ncrypto.h), the export layer's `tn_x509_check_subject` answer. */
const CHECK = { NO_MATCH: 0, MATCH: 1, INVALID_NAME: 2 } as const;

/** ManagedX509's destructor (crypto_x509.cc:53-66): the `X509*` freed once its handle is collected. */
const certificates = new FinalizationRegistry<number>((x) => nodeDeps().tn_x509_free(x));

export class X509CertificateHandle {
  readonly #x: number;

  constructor(x: number) {
    this.#x = x;
    certificates.register(this, x);
  }

  #text(field: number): string | undefined {
    return utf8(mallocAnswer((lengthAt) => nodeDeps().tn_x509_text(this.#x, field, lengthAt)));
  }

  // Subject, SubjectAltName, Issuer, InfoAccess, ValidFrom, ValidTo (297-355), the Fingerprint templates (90-98),
  // SerialNumber, SignatureAlgorithm and SignatureAlgorithmOID (377-405), Pem (277-285).
  subject(): string | undefined { return this.#text(TEXT.subject); }
  subjectAltName(): string | undefined { return this.#text(TEXT.subjectAltName); }
  issuer(): string | undefined { return this.#text(TEXT.issuer); }
  infoAccess(): string | undefined { return this.#text(TEXT.infoAccess); }
  validFrom(): string | undefined { return this.#text(TEXT.validFrom); }
  validTo(): string | undefined { return this.#text(TEXT.validTo); }
  fingerprint(): string | undefined { return this.#text(TEXT.fingerprint); }
  fingerprint256(): string | undefined { return this.#text(TEXT.fingerprint256); }
  fingerprint512(): string | undefined { return this.#text(TEXT.fingerprint512); }
  serialNumber(): string | undefined { return this.#text(TEXT.serialNumber); }
  signatureAlgorithm(): string | undefined { return this.#text(TEXT.signatureAlgorithm); }
  signatureAlgorithmOid(): string | undefined { return this.#text(TEXT.signatureAlgorithmOid); }
  pem(): string | undefined { return this.#text(TEXT.pem); }

  // ValidFromDate and ValidToDate (357-375, GetValidFromDate 226-234): a Date of the time's seconds.
  validFromDate(): Date { return new Date(Number(nodeDeps().tn_x509_valid_time(this.#x, 0)) * 1000); }
  validToDate(): Date { return new Date(Number(nodeDeps().tn_x509_valid_time(this.#x, 1)) * 1000); }

  // KeyUsage (428-436, GetKeyUsage 268-275): the usages, or undefined.
  keyUsage(): string[] | undefined {
    const usages = utf8(mallocAnswer((lengthAt) => nodeDeps().tn_x509_key_usage(this.#x, lengthAt)));
    return usages === undefined ? undefined : usages.split('\0').slice(0, -1);
  }

  // Der (287-295, GetDer 172-181).
  raw(): Buffer { return Buffer.from(outAnswer((outAt) => nodeDeps().tn_x509_der(this.#x, outAt))!); }

  // PublicKey (407-426): the key's SubjectPublicKeyInfo DER; a refusal is ThrowCryptoError's.
  publicKey(): Buffer {
    return withScratch(4, (errorAt) => {
      const deps = nodeDeps();
      new DataView(deps.memory.buffer).setInt32(errorAt, 0, true);
      const der = outAnswer((outAt) => deps.tn_x509_public_key(this.#x, outAt, errorAt));
      if (der === null) throw opensslError('Failed to get public key', new DataView(deps.memory.buffer).getInt32(errorAt, true) >>> 0);
      return Buffer.from(der);
    });
  }

  // CheckCA (438-442), CheckIssued (444-453).
  checkCA(): boolean { return nodeDeps().tn_x509_is_ca(this.#x) !== 0; }
  checkIssued(issuer: X509CertificateHandle): boolean { return nodeDeps().tn_x509_issued_by(this.#x, issuer.#x) !== 0; }

  // CheckPrivateKey (455-464) and CheckPublicKey (466-476), the key as its DER.
  checkPrivateKey(pkcs8: Uint8Array): boolean { return this.#keyCheck('tn_x509_check_private_key', pkcs8); }
  verify(spki: Uint8Array): boolean { return this.#keyCheck('tn_x509_verify', spki); }
  #keyCheck(name: 'tn_x509_check_private_key' | 'tn_x509_verify', der: Uint8Array): boolean {
    const answer = withBytes(der, (at, length) => nodeDeps()[name](this.#x, at, length));
    if (answer < 0) throw opensslError('Invalid key');
    return answer === 1;
  }

  // CheckHost, CheckEmail and CheckIP (514-538) through CheckX509Subject (481-512): the name given, or the name
  // that matched where the check says one; undefined for no match.
  checkHost(name: string, flags: number): string | undefined { return this.#checkSubject(0, name, flags); }
  checkEmail(email: string, flags: number): string | undefined { return this.#checkSubject(1, email, flags); }
  checkIP(ip: string, flags: number): string | undefined { return this.#checkSubject(2, ip, flags); }
  #checkSubject(kind: number, subject: string, flags: number): string | undefined {
    const deps = nodeDeps();
    const { result, matched } = withBytes(subject, (at, length) => withScratch(8, (out) => {
      const result = deps.tn_x509_check_subject(this.#x, kind, at, length, flags >>> 0, out, out + 4);
      const view = new DataView(deps.memory.buffer);
      const matchedAt = view.getUint32(out, true), matchedLength = view.getUint32(out + 4, true);
      let matched: string | undefined;
      if (matchedAt) {
        matched = new TextDecoder('latin1').decode(new Uint8Array(deps.memory.buffer, matchedAt, matchedLength));
        deps.tn_free(matchedAt);
      }
      return { result, matched };
    }));
    if (result === CHECK.MATCH) return matched ?? subject;
    if (result === CHECK.NO_MATCH) return undefined;
    // THROW_ERR_INVALID_ARG_VALUE(env, "Invalid name") and THROW_ERR_CRYPTO_OPERATION_FAILED(env), as node_errors.h
    // makes them: a TypeError and an Error, the message given or the code's default, and the code.
    if (result === CHECK.INVALID_NAME) throw Object.assign(new TypeError('Invalid name'), { code: 'ERR_INVALID_ARG_VALUE' });
    throw Object.assign(new Error('Operation failed'), { code: 'ERR_CRYPTO_OPERATION_FAILED' });
  }

  // GetIssuerCert (540-545): a certificate parsed alone has no issuer certificate.
  getIssuerCert(): undefined { return undefined; }

  // ToLegacy (567-578): X509ToObject's object.
  toLegacy(): Record<string, unknown> { return x509ToObject(this.#x); }
}

/** Parse (547-565): a PEM or DER certificate's handle; a refusal is ThrowCryptoError's. */
export function parseX509(buffer: ArrayBufferView): X509CertificateHandle {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return withScratch(4, (errorAt) => {
    const deps = nodeDeps();
    new DataView(deps.memory.buffer).setInt32(errorAt, 0, true);
    const x = withBytes(bytes, (at, length) => deps.tn_x509_parse(at, length, errorAt)) >>> 0;
    if (!x) throw opensslError('Failed to parse certificate', new DataView(deps.memory.buffer).getInt32(errorAt, true) >>> 0);
    return new X509CertificateHandle(x);
  });
}

/** The X509_CHECK_FLAG_* constants Initialize defines (979-987), as the built OpenSSL defines them. */
export function x509CheckFlags(): Record<string, number> {
  const deps = nodeDeps();
  const names = ['X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT', 'X509_CHECK_FLAG_NEVER_CHECK_SUBJECT',
    'X509_CHECK_FLAG_NO_WILDCARDS', 'X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS', 'X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS',
    'X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS'];
  return Object.fromEntries(names.map((name, which) => [name, deps.tn_x509_check_flag(which) >>> 0]));
}
