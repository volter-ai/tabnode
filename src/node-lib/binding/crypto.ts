/**
 * `internalBinding('crypto')`, as far as Node's own `tls` reaches it (ADR-0016 §4): `SecureContext`, an `SSL_CTX` of
 * the OpenSSL in the process's `libnode.so`, and the root-certificate and cipher calls of `lib/tls.js`. Each method is
 * the V8 half of Node's `src/crypto/crypto_context.cc` over its OpenSSL half in the program
 * (native/node/crypto_context.cc, crypto_cipher.cc), and names the lines it carries; the keys', hashes', HMACs' and
 * randomness's parts are their files' (crypto_keys.ts, crypto_hash.ts, crypto_hmac.ts, crypto_random.ts), each call
 * answered by the engine device or by OpenSSL as ADR-0018 §5 routes it.
 *
 * The root store is the image's bundle (`/etc/ssl/certs/ca-certificates.crt`, where an image lays its World's CA)
 * and the file `NODE_EXTRA_CA_CERTS` names, as Node's `--use-openssl-ca` makes it (ADR-0016 §4), read once for the
 * process. `getBundledRootCertificates()` is Node's own list, compiled into the program.
 */
import { Buffer } from '../buffer-module';
import { nodeLibInternalRequire, nodeLibProcessOf } from '../load';
import { setCryptoCallbacks } from './libnode';
import { copyOut, cString, openssl, opensslError, withBytes, withScratch } from './openssl';
import {
  bufferSource, checked, cryptoJobDone, glue, kCryptoJobAsync, kCryptoJobSync, kCryptoJobWebCrypto, takeThrown,
} from './crypto_util';
import { engineReady } from './engine_device';
import { keysBinding, opensslBindingValues } from './crypto_keys';
import { hashBinding } from './crypto_hash';
import { hmacBinding } from './crypto_hmac';
import { randomBinding } from './crypto_random';
import { sigBinding } from './crypto_sig';
import { x509Binding } from './x509_object';

type Bytes = Uint8Array | string;

/** Node's `LoadBIO` (crypto_util.cc): a string as UTF-8, an `ArrayBufferView` as its bytes. */
function bioBytes(value: unknown): Bytes {
  if (typeof value === 'string') return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('The argument must be a string or an ArrayBufferView');
}

/** Node's `internal/errors` codes, for the errors Node's JavaScript-facing bindings throw. */
export function errorCodes(): any {
  return (nodeLibInternalRequire('internal/errors') as { codes: unknown }).codes;
}

/** An error as Node's C++ `THROW_ERR_*` makes it (node_errors.h): the message as given, with its `code`. */
function cppError(Kind: ErrorConstructor, code: string, message: string): Error {
  const error = new Kind(message) as Error & { code?: string };
  error.code = code;
  return error;
}

/** A refusal by name, for what the engine's TLS does not carry (ADR-0016 §4). */
export function refusal(what: string): Error {
  const { ERR_FEATURE_UNAVAILABLE_ON_PLATFORM } = errorCodes();
  return new ERR_FEATURE_UNAVAILABLE_ON_PLATFORM(what);
}

/**
 * A context's `SSL_CTX` reference, released when the `SecureContext` is collected, as Node's `SecureContext` frees its
 * `ctx_` when the object goes; `close()` releases it at once. A connection holding the context keeps the `SSL_CTX`
 * itself (the export layer's `FreeTnContext`).
 */
const contexts = new FinalizationRegistry<number>((ctx) => openssl().tabnode_ctx_free(ctx));

const SYSTEM_CA_FILE = '/etc/ssl/certs/ca-certificates.crt';
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

let roots: { system: string[]; extra: string[]; extraFile: string } | undefined;
/** The image's bundle and NODE_EXTRA_CA_CERTS, read through the process's files on the first ask. */
function rootCertificates() {
  if (roots) return roots;
  const fs = nodeLibInternalRequire('fs') as { readFileSync(path: string, encoding: string): string };
  // The realm's running process (the guest whose TLS first needs the roots), whose NODE_EXTRA_CA_CERTS names the file:
  // the library's own process carries no image's environment.
  const process = ((globalThis as { process?: unknown }).process ?? nodeLibProcessOf()) as { env?: Record<string, string | undefined>; emitWarning?(message: string): void };
  const split = (pem: string) => (pem.match(PEM_CERTIFICATE) ?? []).map((certificate) => `${certificate}\n`);
  let system: string[] = [];
  try { system = split(fs.readFileSync(SYSTEM_CA_FILE, 'latin1')); } catch { /* an image with no bundle has no roots */ }
  const extraFile = process.env?.NODE_EXTRA_CA_CERTS ?? '';
  let extra: string[] = [];
  if (extraFile) {
    // Node's UseExtraCaCerts warning (crypto_context.cc): the file is ignored, with the reason, once.
    try { extra = split(fs.readFileSync(extraFile, 'latin1')); }
    catch (error) {
      process.emitWarning?.(`Ignoring extra certs from \`${extraFile}\`, load failed: ${(error as Error).message}`);
    }
  }
  return roots = { system, extra, extraFile };
}

/** The certificates tls.setDefaultCACertificates() gave (ResetRootCertStore, 1260-1321); null: never reset. */
let userRoots: string[] | null = null;
let storeLoaded = false;
/** Fills the process's root store, once (GetOrCreateRootCertStore). */
function ensureRootStore(): void {
  if (storeLoaded) return;
  storeLoaded = true;
  const deps = openssl();
  const pems = userRoots ?? [...rootCertificates().system, ...rootCertificates().extra];
  for (const pem of pems) withBytes(pem, (at, length) => deps.tabnode_root_add_pem(at, length));
}

/** Node's `SecureContext` (crypto_context.cc), an `SSL_CTX` in the process's memory. */
export class SecureContext {
  /** The `TnContext*` in the process's memory; 0 once closed. */
  _ctx = 0;

  /** SecureContext::Init, 1534-1686. */
  init(secureProtocol: unknown, minVersion: number, maxVersion: number): void {
    const invalidMethod = (message: string) => cppError(TypeError, 'ERR_TLS_INVALID_PROTOCOL_METHOD', message);
    const TLS1_VERSION = 0x301, TLS1_1_VERSION = 0x302, TLS1_2_VERSION = 0x303, kMaxSupportedVersion = 0x304;
    let method = 0;
    if (maxVersion === 0) maxVersion = kMaxSupportedVersion;
    if (typeof secureProtocol === 'string') {
      const named: Record<string, [number, number | null, number | null]> = {
        SSLv23_method: [0, null, TLS1_2_VERSION], SSLv23_server_method: [1, null, TLS1_2_VERSION],
        SSLv23_client_method: [2, null, TLS1_2_VERSION],
        TLS_method: [0, 0, kMaxSupportedVersion], TLS_server_method: [1, 0, kMaxSupportedVersion],
        TLS_client_method: [2, 0, kMaxSupportedVersion],
        TLSv1_method: [0, TLS1_VERSION, TLS1_VERSION], TLSv1_server_method: [1, TLS1_VERSION, TLS1_VERSION],
        TLSv1_client_method: [2, TLS1_VERSION, TLS1_VERSION],
        TLSv1_1_method: [0, TLS1_1_VERSION, TLS1_1_VERSION], TLSv1_1_server_method: [1, TLS1_1_VERSION, TLS1_1_VERSION],
        TLSv1_1_client_method: [2, TLS1_1_VERSION, TLS1_1_VERSION],
        TLSv1_2_method: [0, TLS1_2_VERSION, TLS1_2_VERSION], TLSv1_2_server_method: [1, TLS1_2_VERSION, TLS1_2_VERSION],
        TLSv1_2_client_method: [2, TLS1_2_VERSION, TLS1_2_VERSION],
      };
      if (/^SSLv2_(server_|client_)?method$/.test(secureProtocol)) {
        throw invalidMethod('SSLv2 methods disabled');
      }
      if (/^SSLv3_(server_|client_)?method$/.test(secureProtocol)) {
        throw invalidMethod('SSLv3 methods disabled');
      }
      const entry = Object.prototype.hasOwnProperty.call(named, secureProtocol) ? named[secureProtocol] : undefined;
      if (!entry) throw invalidMethod(`Unknown method: ${secureProtocol}`);
      method = entry[0];
      if (entry[1] !== null) minVersion = entry[1];
      if (entry[2] !== null) maxVersion = entry[2];
    }
    const deps = openssl();
    const ctx = deps.tabnode_ctx_new(method) >>> 0;
    if (!ctx) throw opensslError('SSL_CTX_new');
    this._ctx = ctx;
    contexts.register(this, ctx, this);
    if (!deps.tabnode_ctx_init(ctx, minVersion, maxVersion)) {
      throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Error generating ticket keys');
    }
  }

  /** SecureContext::SetKey, 1719-1750: a passphrase is taken only as a string. */
  setKey(key: unknown, passphrase?: unknown): void {
    const deps = openssl();
    const pass = typeof passphrase === 'string' ? passphrase : '';
    const result = withBytes(bioBytes(key), (at, length) =>
      withBytes(pass, (passAt, passLength) =>
        deps.tabnode_ctx_set_key(this._ctx, at, length, passAt, passLength, typeof passphrase === 'string' ? 1 : 0)));
    if (result === 0) throw opensslError('PEM_read_bio_PrivateKey');
    if (result < 0) throw opensslError('SSL_CTX_use_PrivateKey');
  }

  /** SecureContext::SetCert, 1833-1844, through Node's SSL_CTX_use_certificate_chain. */
  setCert(cert: unknown): void {
    const deps = openssl();
    if (!withBytes(bioBytes(cert), (at, length) => deps.tabnode_ctx_set_cert(this._ctx, at, length))) {
      throw opensslError('SSL_CTX_use_certificate_chain');
    }
  }

  /** SecureContext::AddCACert, 1882-1893. */
  addCACert(cert: unknown): void {
    const deps = openssl();
    withBytes(bioBytes(cert), (at, length) => deps.tabnode_ctx_add_ca_cert(this._ctx, at, length));
  }

  /** SecureContext::AddCRL, 1916-1926. */
  addCRL(crl: unknown): void {
    const deps = openssl();
    if (!withBytes(bioBytes(crl), (at, length) => deps.tabnode_ctx_add_crl(this._ctx, at, length))) {
      throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Failed to parse CRL');
    }
  }

  /** SecureContext::AddRootCerts, 1938-1942. */
  addRootCerts(): void {
    ensureRootStore();
    openssl().tabnode_ctx_add_root_certs(this._ctx);
  }

  /** SecureContext::SetAllowPartialTrustChain, 1864-1869. */
  setAllowPartialTrustChain(): void {
    openssl().tabnode_ctx_set_allow_partial_trust_chain(this._ctx);
  }

  /** SecureContext::SetCipherSuites, 1944-1957. */
  setCipherSuites(suites: string): void {
    const deps = openssl();
    try {
      if (!withBytes(String(suites), (at) => deps.tabnode_ctx_set_cipher_suites(this._ctx, at))) {
        throw opensslError('Failed to set ciphers');
      }
    } finally { deps.tabnode_err_clear(); }
  }

  /** SecureContext::SetCiphers, 1959-1981. */
  setCiphers(ciphers: string): void {
    const deps = openssl();
    try {
      if (!withBytes(String(ciphers), (at) => deps.tabnode_ctx_set_ciphers(this._ctx, at))) {
        throw opensslError('Failed to set ciphers');
      }
    } finally { deps.tabnode_err_clear(); }
  }

  /** SecureContext::SetSigalgs, 1752-1766. */
  setSigalgs(sigalgs: string): void {
    const deps = openssl();
    try {
      if (!withBytes(String(sigalgs), (at) => deps.tabnode_ctx_set_sigalgs(this._ctx, at))) throw opensslError('');
    } finally { deps.tabnode_err_clear(); }
  }

  /** SecureContext::SetECDHCurve, 1983-1996. */
  setECDHCurve(curve: string): void {
    const deps = openssl();
    if (!withBytes(String(curve), (at) => deps.tabnode_ctx_set_ecdh_curve(this._ctx, at))) {
      deps.tabnode_err_clear();
      throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Failed to set ECDH curve');
    }
  }

  /** SecureContext::SetDHParam, 1998-2061: `true` is "auto"; answers the warning Node answers, if any. */
  setDHParam(dh: unknown): string | undefined {
    const deps = openssl();
    const result = dh === true
      ? deps.tabnode_ctx_set_dh_param(this._ctx, 0, 0)
      : withBytes(bioBytes(dh), (at, length) => deps.tabnode_ctx_set_dh_param(this._ctx, at, length));
    if (result === -1) throw cppError(TypeError, 'ERR_INVALID_ARG_VALUE', 'DH parameter is less than 1024 bits');
    if (result === -2) throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Error setting temp DH parameter');
    return result === 2 ? 'DH parameter is less than 2048 bits' : undefined;
  }

  /** SecureContext::SetMinProto/SetMaxProto/GetMinProto/GetMaxProto, 2063-2107. */
  setMinProto(version: number): void { openssl().tabnode_ctx_set_min_proto(this._ctx, version); }
  setMaxProto(version: number): void { openssl().tabnode_ctx_set_max_proto(this._ctx, version); }
  getMinProto(): number { return openssl().tabnode_ctx_get_min_proto(this._ctx) >>> 0; }
  getMaxProto(): number { return openssl().tabnode_ctx_get_max_proto(this._ctx) >>> 0; }

  /** SecureContext::SetOptions, 2109-2121 (the whole 64-bit value; see the export layer). */
  setOptions(options: number): void {
    openssl().tabnode_ctx_set_options(this._ctx, BigInt(Math.trunc(Number(options))));
  }

  /** SecureContext::SetSessionIdContext, 2123-2153: a failure is a TypeError of OpenSSL's printed errors. */
  setSessionIdContext(id: string): void {
    const deps = openssl();
    if (withBytes(String(id), (at, length) => deps.tabnode_ctx_set_session_id_context(this._ctx, at, length))) return;
    const at = deps.tabnode_err_print() >>> 0;
    const message = at ? cString(at) : null;
    if (at) deps.tabnode_free(at);
    throw new TypeError(message || 'SSL_CTX_set_session_id_context error');
  }

  /** SecureContext::SetSessionTimeout, 2155-2165. */
  setSessionTimeout(timeout: number): void { openssl().tabnode_ctx_set_session_timeout(this._ctx, timeout | 0); }

  /** SecureContext::GetTicketKeys/SetTicketKeys, 2424-2456. */
  getTicketKeys(): Buffer {
    const deps = openssl();
    return withScratch(48, (at) => {
      deps.tabnode_ctx_get_ticket_keys(this._ctx, at);
      return Buffer.from(copyOut(at, 48));
    });
  }
  setTicketKeys(keys: Uint8Array): boolean {
    const deps = openssl();
    withBytes(new Uint8Array(keys.buffer, keys.byteOffset, 48), (at) => deps.tabnode_ctx_set_ticket_keys(this._ctx, at));
    return true;
  }

  /**
   * SecureContext::SetCertificateCompression, 2167-2243: libnode.so's OpenSSL is built without zlib, brotli and zstd
   * (ADR-0016 §1), so a preference is refused by name. The TLS 1.3 check is Node's, first.
   */
  setCertificateCompression(_packed: number): void {
    const max = this.getMaxProto();
    if (max !== 0 && max < 0x304) {
      throw cppError(TypeError, 'ERR_INVALID_ARG_VALUE',
        'certificateCompression requires a TLS protocol range that includes TLSv1.3');
    }
    throw refusal('TLS certificate compression (libnode.so has no zlib, brotli or zstd yet)');
  }

  /** SecureContext::LoadPKCS12, 2265-2376: not yet carried, so refused by name. */
  loadPKCS12(): void {
    throw refusal('A PKCS#12 `pfx` (not yet carried by the engine\'s OpenSSL binding)');
  }

  /** The certificate and issuer an OCSPRequest listener is given (2633-2655): not yet carried. */
  getCertificate(): never { throw refusal('OCSP stapling'); }
  getIssuer(): never { throw refusal('OCSP stapling'); }

  /** SecureContext::EnableTicketKeyCallback: a test hook of Node's suite (2458-2470), refused by name. */
  enableTicketKeyCallback(): never { throw refusal('A TLS ticket key callback'); }

  /** SecureContext::Close, 2258-2263. */
  close(): void {
    if (!this._ctx) return;
    contexts.unregister(this);
    openssl().tabnode_ctx_free(this._ctx);
    this._ctx = 0;
  }
}

/** GetBundledRootCertificates, 1155-1170: Node's own list (src/node_root_certs.h), compiled into the program. */
function getBundledRootCertificates(): string[] {
  const deps = openssl();
  const count = deps.tabnode_bundled_root_count() >>> 0;
  const out: string[] = [];
  for (let index = 0; index < count; index++) out.push(cString(deps.tabnode_bundled_root(index)) ?? '');
  return out;
}

/** GetSystemCACertificates, 1323-1331: the system store is the image's bundle. */
function getSystemCACertificates(): string[] { return [...rootCertificates().system]; }

/** GetExtraCACertificates, 1333-1345. */
function getExtraCACertificates(): string[] {
  const read = rootCertificates();
  return read.extraFile ? [...read.extra] : [];
}

/** GetUserRootCertificates, 1247-1258. */
function getUserRootCertificates(): string[] { return [...(userRoots ?? [])]; }

/**
 * ResetRootCertStore, 1260-1321: the user's certificates replace the store's, which the next context builds anew;
 * a context made before keeps the store it holds, as in Node.
 */
function resetRootCertStore(certificates: string[]): void {
  if (certificates.length === 0) {
    userRoots = [];
  } else {
    const found = certificates.flatMap((pem) => String(pem).match(PEM_CERTIFICATE) ?? []);
    if (found.length === 0) {
      throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'No valid certificates found in the provided array');
    }
    userRoots = [...new Set(found.map((certificate) => `${certificate}\n`))];
  }
  openssl().tabnode_root_reset();
  storeLoaded = false;
}

/** StartLoadingCertificatesOffThread, 975-1030: Node's optimisation; the store is read on first use here. */
function startLoadingCertificatesOffThread(): void {}

/** GetCertificateCompressionAlgorithms, 2245-2256: none, libnode.so's OpenSSL having no zlib, brotli or zstd (ADR-0016 §1). */
function getCertificateCompressionAlgorithms(): string[] { return []; }

/** CipherBase::GetSSLCiphers (crypto_cipher.cc:166-188): the default context's cipher names. */
function getSSLCiphers(): string[] {
  const deps = openssl();
  const count = deps.tabnode_ssl_cipher_count();
  const out: string[] = [];
  for (let index = 0; index < count; index++) out.push(cString(deps.tabnode_ssl_cipher_at(index)) ?? '');
  return out;
}

/** GetFipsCrypto, SetFipsCrypto, TestFipsCrypto (crypto_util.cc:207-242). */
function getFipsCrypto(): number { return glue().tabnode_get_fips_crypto(); }
function testFipsCrypto(): number { return glue().tabnode_test_fips_crypto(); }
function setFipsCrypto(enable: unknown): void {
  if (glue().tabnode_set_fips_crypto(enable ? 1 : 0)) return;
  const error = takeThrown();
  if (error) throw error;
}

/** GetOpenSSLSecLevelCrypto (crypto_util.cc:244-253). */
function getOpenSSLSecLevelCrypto(): number { return checked(glue().tabnode_get_openssl_sec_level()); }

/** SetEngine (crypto_util.cc:683-701): the engine's flags as a uint32. */
function setEngine(id: string, flags: unknown): boolean {
  const exports = glue();
  return withBytes(String(id), (at) => exports.tabnode_set_engine(at, Number(flags) >>> 0)) !== 0;
}

/** TimingSafeEqual (crypto_timing.cc:19-76). */
function timingSafeEqual(a: unknown, b: unknown): boolean {
  const exports = glue();
  return checked(withBytes(bufferSource(a), (aAt, aLength) => withBytes(bufferSource(b), (bAt, bLength) =>
    exports.tabnode_timing_safe_equal(aAt, aLength, bAt, bLength)))) === 1;
}

// The binding's callbacks of libuv's threadpool and of the engine device (engine.h crypto_job_done, engine_ready).
setCryptoCallbacks({ jobDone: cryptoJobDone, engineReady });

/**
 * `internalBinding('crypto')` (src/node_crypto.cc InitCryptoOnce's targets): TLS's, the keys', hashes', HMACs' and
 * randomness's (ADR-0018 item 7), each the V8 half of its Node file. The OpenSSL values its initializers define are
 * the program's (opensslBindingValues), read on the first ask of one.
 */
const binding: Record<string, unknown> = {
  SecureContext,
  getBundledRootCertificates,
  getSystemCACertificates,
  getExtraCACertificates,
  getUserRootCertificates,
  resetRootCertStore,
  startLoadingCertificatesOffThread,
  getCertificateCompressionAlgorithms,
  getSSLCiphers,
  getFipsCrypto,
  setFipsCrypto,
  testFipsCrypto,
  getOpenSSLSecLevelCrypto,
  setEngine,
  timingSafeEqual,
  kCryptoJobAsync,
  kCryptoJobSync,
  kCryptoJobWebCrypto,
  ...keysBinding,
  ...hashBinding,
  ...hmacBinding,
  ...randomBinding,
  ...sigBinding,
  ...x509Binding,
};

/** The OpenSSL-valued names its initializers define (EVP_PKEY_*, RSA_PKCS1_PSS_PADDING, OPENSSL_EC_*, X509_CHECK_FLAG_*). */
const OPENSSL_VALUE_NAMES = [
  'EVP_PKEY_ED25519', 'EVP_PKEY_ED448', 'EVP_PKEY_X25519', 'EVP_PKEY_X448',
  'EVP_PKEY_ML_DSA_44', 'EVP_PKEY_ML_DSA_65', 'EVP_PKEY_ML_DSA_87',
  'EVP_PKEY_ML_KEM_512', 'EVP_PKEY_ML_KEM_768', 'EVP_PKEY_ML_KEM_1024',
  'EVP_PKEY_SLH_DSA_SHA2_128F', 'EVP_PKEY_SLH_DSA_SHA2_128S', 'EVP_PKEY_SLH_DSA_SHA2_192F', 'EVP_PKEY_SLH_DSA_SHA2_192S',
  'EVP_PKEY_SLH_DSA_SHA2_256F', 'EVP_PKEY_SLH_DSA_SHA2_256S', 'EVP_PKEY_SLH_DSA_SHAKE_128F',
  'EVP_PKEY_SLH_DSA_SHAKE_128S', 'EVP_PKEY_SLH_DSA_SHAKE_192F', 'EVP_PKEY_SLH_DSA_SHAKE_192S',
  'EVP_PKEY_SLH_DSA_SHAKE_256F', 'EVP_PKEY_SLH_DSA_SHAKE_256S',
  'RSA_PKCS1_PSS_PADDING', 'OPENSSL_EC_NAMED_CURVE', 'OPENSSL_EC_EXPLICIT_CURVE',
  'X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT', 'X509_CHECK_FLAG_NO_WILDCARDS', 'X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS',
  'X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS', 'X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS',
  'X509_CHECK_FLAG_NEVER_CHECK_SUBJECT',
];
// Each read from the program when first asked (an OpenSSL without one, as Node's #if, answers undefined).
for (const name of OPENSSL_VALUE_NAMES) {
  Object.defineProperty(binding, name, { get: () => opensslBindingValues()[name], enumerable: true, configurable: true });
}

export default binding;
