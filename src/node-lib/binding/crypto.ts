/**
 * `internalBinding('crypto')`, as far as Node's own `tls` reaches it (ADR-0016 §4): `SecureContext`, an `SSL_CTX` in
 * the realm's node-deps.wasm, and the root-certificate and cipher calls of `lib/tls.js`. Each method is the V8 half
 * of Node's `src/crypto/crypto_context.cc` over the export layer's OpenSSL half (scripts/node-deps/tabnode_deps.cc),
 * and names the lines it carries. The `crypto` module is the engine's own (BUILTINS.md, Kind 2); its binding names
 * that Node's `crypto` files read are not here (ADR-0016 §5).
 *
 * The root store is the image's bundle (`/etc/ssl/certs/ca-certificates.crt`, where an image lays its World's CA)
 * and the file `NODE_EXTRA_CA_CERTS` names, as Node's `--use-openssl-ca` makes it (ADR-0016 §4), read once for the
 * realm's instance. `getBundledRootCertificates()` is Node's own list, compiled into the module.
 */
import { Buffer } from '../buffer-module';
import { nodeLibInternalRequire, nodeLibProcessOf } from '../load';
import { copyOut, cString, nodeDeps, opensslError, withBytes, withScratch } from './node-deps';

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
const contexts = new FinalizationRegistry<number>((ctx) => nodeDeps().tn_ctx_free(ctx));

const SYSTEM_CA_FILE = '/etc/ssl/certs/ca-certificates.crt';
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

let roots: { system: string[]; extra: string[]; extraFile: string } | undefined;
/** The image's bundle and NODE_EXTRA_CA_CERTS, read through the process's files on the first ask. */
function rootCertificates() {
  if (roots) return roots;
  const fs = nodeLibInternalRequire('fs') as { readFileSync(path: string, encoding: string): string };
  const process = nodeLibProcessOf() as { env?: Record<string, string | undefined>; emitWarning?(message: string): void };
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
/** Fills the module's root store, once (GetOrCreateRootCertStore). */
function ensureRootStore(): void {
  if (storeLoaded) return;
  storeLoaded = true;
  const deps = nodeDeps();
  const pems = userRoots ?? [...rootCertificates().system, ...rootCertificates().extra];
  for (const pem of pems) withBytes(pem, (at, length) => deps.tn_root_add_pem(at, length));
}

/** Node's `SecureContext` (crypto_context.cc), an `SSL_CTX` of the realm's module. */
export class SecureContext {
  /** The `TnContext*` in the module; 0 once closed. */
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
    const deps = nodeDeps();
    const ctx = deps.tn_ctx_new(method) >>> 0;
    if (!ctx) throw opensslError('SSL_CTX_new');
    this._ctx = ctx;
    contexts.register(this, ctx, this);
    if (!deps.tn_ctx_init(ctx, minVersion, maxVersion)) {
      throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Error generating ticket keys');
    }
  }

  /** SecureContext::SetKey, 1719-1750: a passphrase is taken only as a string. */
  setKey(key: unknown, passphrase?: unknown): void {
    const deps = nodeDeps();
    const pass = typeof passphrase === 'string' ? passphrase : '';
    const result = withBytes(bioBytes(key), (at, length) =>
      withBytes(pass, (passAt, passLength) =>
        deps.tn_ctx_set_key(this._ctx, at, length, passAt, passLength, typeof passphrase === 'string' ? 1 : 0)));
    if (result === 0) throw opensslError('PEM_read_bio_PrivateKey');
    if (result < 0) throw opensslError('SSL_CTX_use_PrivateKey');
  }

  /** SecureContext::SetCert, 1833-1844, through Node's SSL_CTX_use_certificate_chain. */
  setCert(cert: unknown): void {
    const deps = nodeDeps();
    if (!withBytes(bioBytes(cert), (at, length) => deps.tn_ctx_set_cert(this._ctx, at, length))) {
      throw opensslError('SSL_CTX_use_certificate_chain');
    }
  }

  /** SecureContext::AddCACert, 1882-1893. */
  addCACert(cert: unknown): void {
    const deps = nodeDeps();
    withBytes(bioBytes(cert), (at, length) => deps.tn_ctx_add_ca_cert(this._ctx, at, length));
  }

  /** SecureContext::AddCRL, 1916-1926. */
  addCRL(crl: unknown): void {
    const deps = nodeDeps();
    if (!withBytes(bioBytes(crl), (at, length) => deps.tn_ctx_add_crl(this._ctx, at, length))) {
      throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Failed to parse CRL');
    }
  }

  /** SecureContext::AddRootCerts, 1938-1942. */
  addRootCerts(): void {
    ensureRootStore();
    nodeDeps().tn_ctx_add_root_certs(this._ctx);
  }

  /** SecureContext::SetAllowPartialTrustChain, 1864-1869. */
  setAllowPartialTrustChain(): void {
    nodeDeps().tn_ctx_set_allow_partial_trust_chain(this._ctx);
  }

  /** SecureContext::SetCipherSuites, 1944-1957. */
  setCipherSuites(suites: string): void {
    const deps = nodeDeps();
    try {
      if (!withBytes(String(suites), (at) => deps.tn_ctx_set_cipher_suites(this._ctx, at))) {
        throw opensslError('Failed to set ciphers');
      }
    } finally { deps.tn_err_clear(); }
  }

  /** SecureContext::SetCiphers, 1959-1981. */
  setCiphers(ciphers: string): void {
    const deps = nodeDeps();
    try {
      if (!withBytes(String(ciphers), (at) => deps.tn_ctx_set_ciphers(this._ctx, at))) {
        throw opensslError('Failed to set ciphers');
      }
    } finally { deps.tn_err_clear(); }
  }

  /** SecureContext::SetSigalgs, 1752-1766. */
  setSigalgs(sigalgs: string): void {
    const deps = nodeDeps();
    try {
      if (!withBytes(String(sigalgs), (at) => deps.tn_ctx_set_sigalgs(this._ctx, at))) throw opensslError('');
    } finally { deps.tn_err_clear(); }
  }

  /** SecureContext::SetECDHCurve, 1983-1996. */
  setECDHCurve(curve: string): void {
    const deps = nodeDeps();
    if (!withBytes(String(curve), (at) => deps.tn_ctx_set_ecdh_curve(this._ctx, at))) {
      deps.tn_err_clear();
      throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Failed to set ECDH curve');
    }
  }

  /** SecureContext::SetDHParam, 1998-2061: `true` is "auto"; answers the warning Node answers, if any. */
  setDHParam(dh: unknown): string | undefined {
    const deps = nodeDeps();
    const result = dh === true
      ? deps.tn_ctx_set_dh_param(this._ctx, 0, 0)
      : withBytes(bioBytes(dh), (at, length) => deps.tn_ctx_set_dh_param(this._ctx, at, length));
    if (result === -1) throw cppError(TypeError, 'ERR_INVALID_ARG_VALUE', 'DH parameter is less than 1024 bits');
    if (result === -2) throw cppError(Error, 'ERR_CRYPTO_OPERATION_FAILED', 'Error setting temp DH parameter');
    return result === 2 ? 'DH parameter is less than 2048 bits' : undefined;
  }

  /** SecureContext::SetMinProto/SetMaxProto/GetMinProto/GetMaxProto, 2063-2107. */
  setMinProto(version: number): void { nodeDeps().tn_ctx_set_min_proto(this._ctx, version); }
  setMaxProto(version: number): void { nodeDeps().tn_ctx_set_max_proto(this._ctx, version); }
  getMinProto(): number { return nodeDeps().tn_ctx_get_min_proto(this._ctx) >>> 0; }
  getMaxProto(): number { return nodeDeps().tn_ctx_get_max_proto(this._ctx) >>> 0; }

  /** SecureContext::SetOptions, 2109-2121 (the whole 64-bit value; see the export layer). */
  setOptions(options: number): void {
    nodeDeps().tn_ctx_set_options(this._ctx, BigInt(Math.trunc(Number(options))));
  }

  /** SecureContext::SetSessionIdContext, 2123-2153: a failure is a TypeError of OpenSSL's printed errors. */
  setSessionIdContext(id: string): void {
    const deps = nodeDeps();
    if (withBytes(String(id), (at, length) => deps.tn_ctx_set_session_id_context(this._ctx, at, length))) return;
    const at = deps.tn_err_print() >>> 0;
    const message = at ? cString(at) : null;
    if (at) deps.tn_free(at);
    throw new TypeError(message || 'SSL_CTX_set_session_id_context error');
  }

  /** SecureContext::SetSessionTimeout, 2155-2165. */
  setSessionTimeout(timeout: number): void { nodeDeps().tn_ctx_set_session_timeout(this._ctx, timeout | 0); }

  /** SecureContext::GetTicketKeys/SetTicketKeys, 2424-2456. */
  getTicketKeys(): Buffer {
    const deps = nodeDeps();
    return withScratch(48, (at) => {
      deps.tn_ctx_get_ticket_keys(this._ctx, at);
      return Buffer.from(copyOut(at, 48));
    });
  }
  setTicketKeys(keys: Uint8Array): boolean {
    const deps = nodeDeps();
    withBytes(new Uint8Array(keys.buffer, keys.byteOffset, 48), (at) => deps.tn_ctx_set_ticket_keys(this._ctx, at));
    return true;
  }

  /**
   * SecureContext::SetCertificateCompression, 2167-2243: the module is built without zlib, brotli and zstd
   * (ADR-0016 §1), so a preference is refused by name. The TLS 1.3 check is Node's, first.
   */
  setCertificateCompression(_packed: number): void {
    const max = this.getMaxProto();
    if (max !== 0 && max < 0x304) {
      throw cppError(TypeError, 'ERR_INVALID_ARG_VALUE',
        'certificateCompression requires a TLS protocol range that includes TLSv1.3');
    }
    throw refusal('TLS certificate compression (node-deps.wasm has no zlib, brotli or zstd yet)');
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
    nodeDeps().tn_ctx_free(this._ctx);
    this._ctx = 0;
  }
}

/** GetBundledRootCertificates, 1155-1170: Node's own list (src/node_root_certs.h), compiled into the module. */
function getBundledRootCertificates(): string[] {
  const deps = nodeDeps();
  const count = deps.tn_bundled_root_count() >>> 0;
  const out: string[] = [];
  for (let index = 0; index < count; index++) out.push(cString(deps.tn_bundled_root(index)) ?? '');
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
  nodeDeps().tn_root_reset();
  storeLoaded = false;
}

/** StartLoadingCertificatesOffThread, 975-1030: Node's optimisation; the store is read on first use here. */
function startLoadingCertificatesOffThread(): void {}

/** GetCertificateCompressionAlgorithms, 2245-2256: none, the module having no zlib, brotli or zstd (ADR-0016 §1). */
function getCertificateCompressionAlgorithms(): string[] { return []; }

/** CipherBase::GetSSLCiphers (crypto_cipher.cc:166-188): the default context's cipher names. */
function getSSLCiphers(): string[] {
  const deps = nodeDeps();
  const count = deps.tn_ssl_cipher_count();
  const out: string[] = [];
  for (let index = 0; index < count; index++) out.push(cString(deps.tn_ssl_cipher_at(index)) ?? '');
  return out;
}

export default {
  SecureContext,
  getBundledRootCertificates,
  getSystemCACertificates,
  getExtraCACertificates,
  getUserRootCertificates,
  resetRootCertStore,
  startLoadingCertificatesOffThread,
  getCertificateCompressionAlgorithms,
  getSSLCiphers,
};
