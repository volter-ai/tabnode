/**
 * `crypto.X509Certificate`: Node v24.21.0's lib/internal/crypto/x509.js, its class as written, over the binding's
 * handle (src/node-lib/binding/x509_certificate.ts, the V8 half of src/crypto/crypto_x509.cc over node-deps.wasm's
 * OpenSSL). The `crypto` module's keys are the engine's own (ADR-0016 §5), so where Node's class passes a key's
 * `KeyObjectHandle` this one passes the key's DER, and `publicKey` is the engine's `createPublicKey` of the
 * certificate's SubjectPublicKeyInfo. A certificate is not transferable between realms (`markTransferMode`): each
 * realm's OpenSSL holds its own.
 */
import { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, validateBoolean, validateObject, validateString } from '../node-internals';
import type { Buffer } from '../node-lib/buffer-module';
import { nodeLibInternalRequire } from '../node-lib/load';
import { parseX509, x509CheckFlags, type X509CertificateHandle } from '../node-lib/binding/x509_certificate';

const kInspect = Symbol.for('nodejs.util.inspect.custom');

export interface EngineKey { readonly type: string; export(options: { format: 'der'; type: 'pkcs8' | 'spki' }): unknown }

/** The class, given the engine's `KeyObject` and `createPublicKey` (crypto.ts), as crypto-cipher.ts's are made. */
export function createX509Certificate(engine: {
  KeyObject: abstract new (...args: never[]) => EngineKey;
  createPublicKey(key: { key: Buffer; format: 'der'; type: 'spki' }): EngineKey;
  BufferFrom(value: string): Buffer;
}) {
  const isKeyObject = (value: unknown): value is EngineKey => value instanceof engine.KeyObject;
  const der = (key: EngineKey, type: 'pkcs8' | 'spki'): Uint8Array => key.export({ format: 'der', type }) as Uint8Array;

  function getFlags(options: Record<string, unknown> = {}): number {
    const flags = x509CheckFlags();
    validateObject(options, 'options');
    const {
      subject = 'default',  // Can be 'default', 'always', or 'never'
      wildcards = true,
      partialWildcards = true,
      multiLabelWildcards = false,
      singleLabelSubdomains = false,
    } = { ...options };
    let result = 0;
    validateString(subject, 'options.subject');
    validateBoolean(wildcards, 'options.wildcards');
    validateBoolean(partialWildcards, 'options.partialWildcards');
    validateBoolean(multiLabelWildcards, 'options.multiLabelWildcards');
    validateBoolean(singleLabelSubdomains, 'options.singleLabelSubdomains');
    switch (subject) {
      case 'default': /* Matches OpenSSL's default, no flags. */ break;
      case 'always': result |= flags.X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT!; break;
      case 'never': result |= flags.X509_CHECK_FLAG_NEVER_CHECK_SUBJECT!; break;
      default:
        throw new ERR_INVALID_ARG_VALUE('options.subject', subject);
    }
    if (!wildcards) result |= flags.X509_CHECK_FLAG_NO_WILDCARDS!;
    if (!partialWildcards) result |= flags.X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS!;
    if (multiLabelWildcards) result |= flags.X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS!;
    if (singleLabelSubdomains) result |= flags.X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS!;
    return result;
  }

  // Node's kInternalState and kHandle are the class's private fields: its state is the instance's alone, and
  // isX509Certificate is the brand check on them.
  let isX509Certificate: (value: unknown) => value is X509Certificate;
  class X509Certificate {
    static {
      isX509Certificate = (value): value is X509Certificate => typeof value === 'object' && value !== null && #state in value;
    }
    #state = new Map<string, unknown>();
    #handle: X509CertificateHandle;

    constructor(buffer: unknown) {
      if (typeof buffer === 'string')
        buffer = engine.BufferFrom(buffer);
      if (!ArrayBuffer.isView(buffer)) {
        throw new ERR_INVALID_ARG_TYPE(
          'buffer',
          ['string', 'Buffer', 'TypedArray', 'DataView'],
          buffer);
      }
      this.#handle = parseX509(buffer);
    }

    /** Each getter's value read once from the handle and kept, as Node's are. */
    #kept<T>(name: string, read: () => T): T {
      let value = this.#state.get(name) as T | undefined;
      if (value === undefined) {
        value = read();
        this.#state.set(name, value);
      }
      return value;
    }

    get subject() { return this.#kept('subject', () => this.#handle.subject()); }
    get subjectAltName() { return this.#kept('subjectAltName', () => this.#handle.subjectAltName()); }
    get issuer() { return this.#kept('issuer', () => this.#handle.issuer()); }
    get issuerCertificate() {
      // A certificate parsed alone has none (the handle's getIssuerCert).
      return this.#kept('issuerCertificate', () => this.#handle.getIssuerCert());
    }
    get infoAccess() { return this.#kept('infoAccess', () => this.#handle.infoAccess()); }
    get validFrom() { return this.#kept('validFrom', () => this.#handle.validFrom()); }
    get validTo() { return this.#kept('validTo', () => this.#handle.validTo()); }
    get validFromDate() { return this.#kept('validFromDate', () => this.#handle.validFromDate()); }
    get validToDate() { return this.#kept('validToDate', () => this.#handle.validToDate()); }
    get fingerprint() { return this.#kept('fingerprint', () => this.#handle.fingerprint()); }
    get fingerprint256() { return this.#kept('fingerprint256', () => this.#handle.fingerprint256()); }
    get fingerprint512() { return this.#kept('fingerprint512', () => this.#handle.fingerprint512()); }
    get keyUsage() { return this.#kept('keyUsage', () => this.#handle.keyUsage()); }
    get serialNumber() { return this.#kept('serialNumber', () => this.#handle.serialNumber()); }
    get signatureAlgorithm() { return this.#kept('signatureAlgorithm', () => this.#handle.signatureAlgorithm()); }
    get signatureAlgorithmOid() { return this.#kept('signatureAlgorithmOid', () => this.#handle.signatureAlgorithmOid()); }
    get raw() { return this.#kept('raw', () => this.#handle.raw()); }
    get publicKey() {
      return this.#kept('publicKey', () => engine.createPublicKey({ key: this.#handle.publicKey(), format: 'der', type: 'spki' }));
    }

    toString() { return this.#kept('pem', () => this.#handle.pem()); }

    // There's no standardized JSON encoding for X509 certs so we
    // fallback to providing the PEM encoding as a string.
    toJSON() { return this.toString(); }

    get ca() { return this.#kept('ca', () => this.#handle.checkCA()); }

    checkHost(name: string, options?: Record<string, unknown>) {
      validateString(name, 'name');
      return this.#handle.checkHost(name, getFlags(options));
    }

    checkEmail(email: string, options?: Record<string, unknown>) {
      validateString(email, 'email');
      return this.#handle.checkEmail(email, getFlags(options));
    }

    checkIP(ip: string, options?: Record<string, unknown>) {
      validateString(ip, 'ip');
      // The options argument is currently undocumented since none of the options
      // have any effect on the behavior of this function. However, we still parse
      // the options argument in case OpenSSL adds flags in the future that do
      // affect the behavior of X509_check_ip. This ensures that no invalid values
      // are passed as the second argument in the meantime.
      return this.#handle.checkIP(ip, getFlags(options));
    }

    checkIssued(otherCert: unknown) {
      if (!isX509Certificate(otherCert))
        throw new ERR_INVALID_ARG_TYPE('otherCert', 'X509Certificate', otherCert);
      return this.#handle.checkIssued(otherCert.#handle);
    }

    checkPrivateKey(pkey: unknown) {
      if (!isKeyObject(pkey))
        throw new ERR_INVALID_ARG_TYPE('pkey', 'KeyObject', pkey);
      if (pkey.type !== 'private')
        throw new ERR_INVALID_ARG_VALUE('pkey', pkey);
      return this.#handle.checkPrivateKey(der(pkey, 'pkcs8'));
    }

    verify(pkey: unknown) {
      if (!isKeyObject(pkey))
        throw new ERR_INVALID_ARG_TYPE('pkey', 'KeyObject', pkey);
      if (pkey.type !== 'public')
        throw new ERR_INVALID_ARG_VALUE('pkey', pkey);
      return this.#handle.verify(der(pkey, 'spki'));
    }

    toLegacyObject() {
      const { translatePeerCertificate } = nodeLibInternalRequire('internal/tls/common') as
        { translatePeerCertificate(object: Record<string, unknown>): Record<string, unknown> };
      return translatePeerCertificate(this.#handle.toLegacy());
    }
  }

  // [kInspect] (x509.js:131-159), on the prototype as Node's class defines it.
  Object.defineProperty(X509Certificate.prototype, kInspect, {
    configurable: true,
    writable: true,
    value: function (this: X509Certificate, depth: number, options: { depth?: number | null },
      inspect: (value: unknown, options: unknown) => string) {
      if (depth < 0)
        return this;

      const opts = {
        ...options,
        depth: options.depth == null ? null : options.depth - 1,
      };

      return `X509Certificate ${inspect({
        subject: this.subject,
        subjectAltName: this.subjectAltName,
        issuer: this.issuer,
        infoAccess: this.infoAccess,
        validFrom: this.validFrom,
        validTo: this.validTo,
        validFromDate: this.validFromDate,
        validToDate: this.validToDate,
        fingerprint: this.fingerprint,
        fingerprint256: this.fingerprint256,
        fingerprint512: this.fingerprint512,
        keyUsage: this.keyUsage,
        serialNumber: this.serialNumber,
        signatureAlgorithm: this.signatureAlgorithm,
        signatureAlgorithmOid: this.signatureAlgorithmOid,
      }, opts)}`;
    },
  });

  return X509Certificate;
}
