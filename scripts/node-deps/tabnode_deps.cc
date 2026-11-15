// The export layer of node-deps.wasm (ADR-0016 §3): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_context.cc (SecureContext) and src/crypto/crypto_tls.cc (TLSWrap), with the V8 half
// (argument unwrapping, result objects, MakeCallback) removed: that half is the `tls_wrap` and `crypto` bindings'
// JavaScript over src/node-lib/binding/node-deps.ts. Every function names the
// lines it carries. Nothing here is a policy of the engine's own: where a body differs from Node's, the
// difference is said at the site.
//
// Calls into JavaScript are the module's `tabnode` imports, made synchronously inside the OpenSSL call that
// raised them, as Node's callbacks are made inside SSL_read/SSL_do_handshake.

#include <openssl/bio.h>
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/opensslv.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

#include <cctype>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "ncrypto.h"

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))
#define IMPORT(name) extern "C" __attribute__((import_module("tabnode"), import_name(#name)))

// ---- The engine's callbacks (the `tabnode` imports) -------------------------------------------------------

struct TnSsl;
IMPORT(handshake) void tn_host_handshake(TnSsl* s, int done);
IMPORT(keylog) void tn_host_keylog(TnSsl* s, const char* line, size_t length);
IMPORT(new_session) int tn_host_new_session(TnSsl* s, const unsigned char* id, size_t id_length,
                                            const unsigned char* der, size_t der_length);
IMPORT(cert) int tn_host_cert(TnSsl* s, const char* servername, size_t servername_length, int ocsp);
IMPORT(alpn) int tn_host_alpn(TnSsl* s, const unsigned char* in, size_t in_length);

// ---- Memory and the error queue ---------------------------------------------------------------------------

EXPORT(tn_malloc) void* tn_malloc(size_t size) { return malloc(size ? size : 1); }
EXPORT(tn_free) void tn_free(void* p) { free(p); }

EXPORT(tn_err_get) uint32_t tn_err_get() { return static_cast<uint32_t>(ERR_get_error()); }
EXPORT(tn_err_peek) uint32_t tn_err_peek() { return static_cast<uint32_t>(ERR_peek_error()); }
EXPORT(tn_err_clear) void tn_err_clear() { ERR_clear_error(); }
EXPORT(tn_err_set_mark) void tn_err_set_mark() { ERR_set_mark(); }
EXPORT(tn_err_pop_to_mark) void tn_err_pop_to_mark() { ERR_pop_to_mark(); }
EXPORT(tn_err_lib) int tn_err_lib(uint32_t code) { return ERR_GET_LIB(code); }
EXPORT(tn_err_lib_string) const char* tn_err_lib_string(uint32_t code) { return ERR_lib_error_string(code); }
EXPORT(tn_err_reason_string) const char* tn_err_reason_string(uint32_t code) { return ERR_reason_error_string(code); }
// ThrowCryptoError's message (crypto_util.cc): ERR_error_string_n of the code.
EXPORT(tn_err_string) void tn_err_string(uint32_t code, char* buffer, size_t length) {
  ERR_error_string_n(code, buffer, length);
}
// SetSessionIdContext's message (crypto_context.cc:2140-2150): ERR_print_errors into a memory BIO. Answers a
// malloc'd NUL-terminated string the caller frees.
EXPORT(tn_err_print) char* tn_err_print() {
  BIO* bio = BIO_new(BIO_s_mem());
  if (bio == nullptr) return nullptr;
  ERR_print_errors(bio);
  char* data;
  long length = BIO_get_mem_data(bio, &data);
  char* out = static_cast<char*>(malloc(static_cast<size_t>(length) + 1));
  if (out != nullptr) { memcpy(out, data, static_cast<size_t>(length)); out[length] = 0; }
  BIO_free(bio);
  return out;
}

// ---- The root store ---------------------------------------------------------------------------------------

// Node's bundled roots, src/node_root_certs.h, as crypto_context.cc:76-80 includes them.
static const char* const kRootCerts[] = {
#define NODE_WANT_INTERNALS 1
#include "node_root_certs.h"
};
EXPORT(tn_bundled_root_count) size_t tn_bundled_root_count() { return sizeof(kRootCerts) / sizeof(kRootCerts[0]); }
EXPORT(tn_bundled_root) const char* tn_bundled_root(size_t index) { return kRootCerts[index]; }

// The process's root store (Node's GetOrCreateRootCertStore, crypto_context.cc:1040-1100), built from the PEM
// the binding hands in: the root's bundle and NODE_EXTRA_CA_CERTS, as --use-openssl-ca makes it (ADR-0016 §4).
static X509_STORE* root_store = nullptr;
static X509_STORE* RootStore() {
  if (root_store == nullptr) root_store = X509_STORE_new();
  return root_store;
}
// Answers the number of certificates added.
EXPORT(tn_root_add_pem) int tn_root_add_pem(const char* pem, size_t length) {
  BIO* bio = BIO_new_mem_buf(pem, static_cast<int>(length));
  if (bio == nullptr) return 0;
  int added = 0;
  ERR_set_mark();
  while (X509* x509 = PEM_read_bio_X509(bio, nullptr, nullptr, nullptr)) {
    if (X509_STORE_add_cert(RootStore(), x509) == 1) added++;
    X509_free(x509);
  }
  ERR_pop_to_mark();
  BIO_free(bio);
  return added;
}

// ---- SecureContext (crypto_context.cc) ------------------------------------------------------------------

struct TnContext {
  SSL_CTX* ctx = nullptr;
  X509_STORE* own_cert_store = nullptr;
  unsigned char ticket_key_name[16];
  unsigned char ticket_key_hmac[16];
  unsigned char ticket_key_aes[16];
};

// A TnContext lives as long as its SSL_CTX: Node's SecureContext is kept alive by every TLSWrap holding its context
// (`sc_`), so the ticket callback below always finds it. Here the SSL_CTX's own ex_data owns it, and frees it when the
// last SSL holding the SSL_CTX is freed.
static void FreeTnContext(void* parent, void* ptr, CRYPTO_EX_DATA* ad, int idx, long argl, void* argp) {
  delete static_cast<TnContext*>(ptr);
}
static int ContextIndex() {
  static int index = SSL_CTX_get_ex_new_index(0, nullptr, nullptr, nullptr, FreeTnContext);
  return index;
}
static TnContext* ContextOf(const SSL_CTX* ctx) { return static_cast<TnContext*>(SSL_CTX_get_ex_data(ctx, ContextIndex())); }

// InitTicketHmac, crypto_context.cc:2472-2483.
static bool InitTicketHmac(EVP_MAC_CTX* hctx, const unsigned char* key, size_t key_len) {
  const char* md_name = EVP_MD_get0_name(EVP_sha256());
  if (md_name == nullptr) return false;
  OSSL_PARAM params[] = {
      OSSL_PARAM_construct_utf8_string(OSSL_MAC_PARAM_DIGEST, const_cast<char*>(md_name), 0),
      OSSL_PARAM_construct_end(),
  };
  return EVP_MAC_init(hctx, key, key_len, params) == 1;
}

// SecureContext::TicketCompatibilityCallback, crypto_context.cc:2586-2623.
static int TicketCompatibilityCallback(SSL* ssl, unsigned char* name, unsigned char* iv, EVP_CIPHER_CTX* ectx,
                                       EVP_MAC_CTX* hctx, int enc) {
  TnContext* sc = ContextOf(SSL_get_SSL_CTX(ssl));
  if (enc) {
    memcpy(name, sc->ticket_key_name, sizeof(sc->ticket_key_name));
    if (!ncrypto::CSPRNG(iv, 16) ||
        EVP_EncryptInit_ex(ectx, EVP_aes_128_cbc(), nullptr, sc->ticket_key_aes, iv) <= 0 ||
        !InitTicketHmac(hctx, sc->ticket_key_hmac, sizeof(sc->ticket_key_hmac))) {
      return -1;
    }
    return 1;
  }
  if (memcmp(name, sc->ticket_key_name, sizeof(sc->ticket_key_name)) != 0) return 0;
  if (EVP_DecryptInit_ex(ectx, EVP_aes_128_cbc(), nullptr, sc->ticket_key_aes, iv) <= 0 ||
      !InitTicketHmac(hctx, sc->ticket_key_hmac, sizeof(sc->ticket_key_hmac))) {
    return -1;
  }
  return 1;
}

// SecureContext::Init's method choice (crypto_context.cc:1545-1622) is the binding's; it passes 0 for
// TLS_method, 1 for TLS_server_method, 2 for TLS_client_method. Answers null where SSL_CTX_new fails.
EXPORT(tn_ctx_new) TnContext* tn_ctx_new(int method) {
  const SSL_METHOD* m = method == 1 ? TLS_server_method() : method == 2 ? TLS_client_method() : TLS_method();
  SSL_CTX* ctx = SSL_CTX_new(m);
  if (ctx == nullptr) return nullptr;
  TnContext* sc = new TnContext();
  sc->ctx = ctx;
  SSL_CTX_set_ex_data(ctx, ContextIndex(), sc);
  return sc;
}

// SecureContext::Init after SSL_CTX_new, crypto_context.cc:1630-1685. Answers 0 where the ticket keys could not
// be generated ("Error generating ticket keys").
EXPORT(tn_ctx_init) int tn_ctx_init(TnContext* sc, int min_version, int max_version) {
  SSL_CTX* ctx = sc->ctx;
  // NODE_OPENSSL_HAS_CERT_COMP: certificate compression is opt-in (1641-1643).
#ifndef OPENSSL_NO_COMP_ALG
  SSL_CTX_set1_cert_comp_preference(ctx, nullptr, 0);
#endif
  SSL_CTX_set_options(ctx, SSL_OP_NO_SSLv2);
  SSL_CTX_set_options(ctx, SSL_OP_NO_SSLv3);
  SSL_CTX_set_options(ctx, SSL_OP_ALLOW_CLIENT_RENEGOTIATION);
  SSL_CTX_clear_mode(ctx, SSL_MODE_NO_AUTO_CHAIN);
  SSL_CTX_set_session_cache_mode(ctx, SSL_SESS_CACHE_CLIENT | SSL_SESS_CACHE_SERVER | SSL_SESS_CACHE_NO_INTERNAL |
                                          SSL_SESS_CACHE_NO_AUTO_CLEAR);
  if (!SSL_CTX_set_min_proto_version(ctx, min_version)) abort();
  if (!SSL_CTX_set_max_proto_version(ctx, max_version)) abort();
  if (!ncrypto::CSPRNG(sc->ticket_key_name, sizeof(sc->ticket_key_name)) ||
      !ncrypto::CSPRNG(sc->ticket_key_hmac, sizeof(sc->ticket_key_hmac)) ||
      !ncrypto::CSPRNG(sc->ticket_key_aes, sizeof(sc->ticket_key_aes))) {
    return 0;
  }
  SSL_CTX_set_tlsext_ticket_key_evp_cb(ctx, TicketCompatibilityCallback);
  return 1;
}

// SecureContext::Close, crypto_context.cc:2258-2263: this reference to the SSL_CTX goes; the TnContext goes with the
// SSL_CTX's last reference (FreeTnContext).
EXPORT(tn_ctx_free) void tn_ctx_free(TnContext* sc) {
  if (sc == nullptr) return;
  SSL_CTX_free(sc->ctx);
}

// The passphrase redirection of SetKey (crypto_context.cc:1731-1737) and PasswordCallback (crypto_util.cc).
struct Passphrase { const char* data; size_t length; bool given; };
static int PasswordCallback(char* buf, int size, int rwflag, void* u) {
  const Passphrase* pass = static_cast<const Passphrase*>(u);
  if (pass == nullptr || !pass->given) return -1;
  size_t buflen = static_cast<size_t>(size);
  if (buflen < pass->length) return -1;
  memcpy(buf, pass->data, pass->length);
  return static_cast<int>(pass->length);
}

// SecureContext::SetKey, crypto_context.cc:1719-1750. Answers 1, or 0 where PEM_read_bio_PrivateKey failed and
// -1 where SSL_CTX_use_PrivateKey failed (the function name ThrowCryptoError is given).
EXPORT(tn_ctx_set_key) int tn_ctx_set_key(TnContext* sc, const char* pem, size_t length, const char* pass,
                                          size_t pass_length, int has_pass) {
  BIO* bio = BIO_new_mem_buf(pem, static_cast<int>(length));
  if (bio == nullptr) return 0;
  Passphrase passphrase{pass, pass_length, has_pass != 0};
  EVP_PKEY* key = PEM_read_bio_PrivateKey(bio, nullptr, PasswordCallback, &passphrase);
  BIO_free(bio);
  if (key == nullptr) return 0;
  int ok = SSL_CTX_use_PrivateKey(sc->ctx, key);
  EVP_PKEY_free(key);
  return ok ? 1 : -1;
}

// SSL_CTX_use_certificate_chain, crypto_context.cc:156-270 (Node's, not OpenSSL's): the first certificate is
// the context's, the rest its chain. The issuer and certificate copies Node keeps for OCSP stay with the context
// (SSL_CTX_get0_certificate), so they are not duplicated here.
EXPORT(tn_ctx_set_cert) int tn_ctx_set_cert(TnContext* sc, const char* pem, size_t length) {
  BIO* in = BIO_new_mem_buf(pem, static_cast<int>(length));
  if (in == nullptr) return 0;
  ERR_clear_error();
  X509* x = PEM_read_bio_X509_AUX(in, nullptr, ncrypto::NoPasswordCallback, nullptr);
  if (x == nullptr) { BIO_free(in); return 0; }
  STACK_OF(X509)* extra_certs = sk_X509_new_null();
  int ret = extra_certs != nullptr;
  while (ret) {
    X509* extra = PEM_read_bio_X509(in, nullptr, ncrypto::NoPasswordCallback, nullptr);
    if (extra == nullptr) break;
    if (!sk_X509_push(extra_certs, extra)) { X509_free(extra); ret = 0; }
  }
  BIO_free(in);
  if (ret) {
    unsigned long err = ERR_peek_last_error();
    if (ERR_GET_LIB(err) == ERR_LIB_PEM && ERR_GET_REASON(err) == PEM_R_NO_START_LINE) {
      ERR_clear_error();
    } else {
      ret = 0;
    }
  }
  if (ret) ret = SSL_CTX_use_certificate(sc->ctx, x);
  if (ret) {
    SSL_CTX_clear_extra_chain_certs(sc->ctx);
    for (int i = 0; i < sk_X509_num(extra_certs); i++) {
      if (!SSL_CTX_add1_chain_cert(sc->ctx, sk_X509_value(extra_certs, i))) { ret = 0; break; }
    }
  }
  sk_X509_pop_free(extra_certs, X509_free);
  X509_free(x);
  return ret;
}

// SecureContext::GetCertStoreOwnedByThisSecureContext, crypto_context.cc:1851-1862.
static X509_STORE* OwnCertStore(TnContext* sc) {
  if (sc->own_cert_store != nullptr) return sc->own_cert_store;
  X509_STORE* cert_store = SSL_CTX_get_cert_store(sc->ctx);
  if (cert_store == root_store) {
    // NewRootCertStore (crypto_context.cc:1063): a copy of the root store's certificates.
    X509_STORE* copy = X509_STORE_new();
    if (root_store != nullptr) {
      STACK_OF(X509)* certs = X509_STORE_get1_all_certs(root_store);
      for (int i = 0; i < sk_X509_num(certs); i++) X509_STORE_add_cert(copy, sk_X509_value(certs, i));
      sk_X509_pop_free(certs, X509_free);
    }
    SSL_CTX_set_cert_store(sc->ctx, copy);
    cert_store = copy;
  }
  return sc->own_cert_store = cert_store;
}

// SecureContext::SetCACert, crypto_context.cc:1871-1880.
EXPORT(tn_ctx_add_ca_cert) void tn_ctx_add_ca_cert(TnContext* sc, const char* pem, size_t length) {
  ERR_set_mark();
  BIO* bio = BIO_new_mem_buf(pem, static_cast<int>(length));
  if (bio != nullptr) {
    while (X509* x509 = PEM_read_bio_X509_AUX(bio, nullptr, ncrypto::NoPasswordCallback, nullptr)) {
      if (X509_STORE_add_cert(OwnCertStore(sc), x509) != 1) abort();
      if (SSL_CTX_add_client_CA(sc->ctx, x509) != 1) abort();
      X509_free(x509);
    }
    BIO_free(bio);
  }
  ERR_pop_to_mark();
}

// SecureContext::SetCRL, crypto_context.cc:1890-1914. Answers 0 for "Failed to parse CRL".
EXPORT(tn_ctx_add_crl) int tn_ctx_add_crl(TnContext* sc, const char* pem, size_t length) {
  ERR_set_mark();
  BIO* bio = BIO_new_mem_buf(pem, static_cast<int>(length));
  X509_CRL* crl = bio ? PEM_read_bio_X509_CRL(bio, nullptr, ncrypto::NoPasswordCallback, nullptr) : nullptr;
  if (bio) BIO_free(bio);
  ERR_pop_to_mark();
  if (crl == nullptr) return 0;
  X509_STORE* cert_store = OwnCertStore(sc);
  if (X509_STORE_add_crl(cert_store, crl) != 1) abort();
  if (X509_STORE_set_flags(cert_store, X509_V_FLAG_CRL_CHECK | X509_V_FLAG_CRL_CHECK_ALL) != 1) abort();
  X509_CRL_free(crl);
  return 1;
}

// SecureContext::SetRootCerts, crypto_context.cc:1928-1936.
EXPORT(tn_ctx_add_root_certs) void tn_ctx_add_root_certs(TnContext* sc) {
  X509_STORE* store = RootStore();
  X509_STORE_up_ref(store);
  SSL_CTX_set_cert_store(sc->ctx, store);
}

// SecureContext::SetAllowPartialTrustChain, crypto_context.cc:1846-1869.
EXPORT(tn_ctx_set_allow_partial_trust_chain) void tn_ctx_set_allow_partial_trust_chain(TnContext* sc) {
  if (X509_STORE_set_flags(OwnCertStore(sc), X509_V_FLAG_PARTIAL_CHAIN) != 1) abort();
}

// SecureContext::SetCipherSuites, crypto_context.cc:1944-1957.
EXPORT(tn_ctx_set_cipher_suites) int tn_ctx_set_cipher_suites(TnContext* sc, const char* suites) {
  return SSL_CTX_set_ciphersuites(sc->ctx, suites) == 1;
}

// SecureContext::SetCiphers, crypto_context.cc:1959-1981: an empty list's SSL_R_NO_CIPHER_MATCH is not an error.
// Answers 1, or 0 with the error left for the binding to read.
EXPORT(tn_ctx_set_ciphers) int tn_ctx_set_ciphers(TnContext* sc, const char* ciphers) {
  if (SSL_CTX_set_cipher_list(sc->ctx, ciphers)) return 1;
  unsigned long err = ERR_peek_error();
  if (strlen(ciphers) == 0 && ERR_GET_REASON(err) == SSL_R_NO_CIPHER_MATCH) { ERR_clear_error(); return 1; }
  return 0;
}

// SecureContext::SetECDHCurve, crypto_context.cc:1983-1996.
EXPORT(tn_ctx_set_ecdh_curve) int tn_ctx_set_ecdh_curve(TnContext* sc, const char* curve) {
  if (strcmp(curve, "auto") == 0) return 1;
  return SSL_CTX_set1_curves_list(sc->ctx, curve) == 1;
}

// SecureContext::SetSigalgs, crypto_context.cc:1752-1766.
EXPORT(tn_ctx_set_sigalgs) int tn_ctx_set_sigalgs(TnContext* sc, const char* sigalgs) {
  return SSL_CTX_set1_sigalgs_list(sc->ctx, sigalgs) == 1;
}

// SecureContext::SetMinProto/SetMaxProto/GetMinProto/GetMaxProto, crypto_context.cc:2063-2107.
EXPORT(tn_ctx_set_min_proto) void tn_ctx_set_min_proto(TnContext* sc, int v) {
  if (!SSL_CTX_set_min_proto_version(sc->ctx, v)) abort();
}
EXPORT(tn_ctx_set_max_proto) void tn_ctx_set_max_proto(TnContext* sc, int v) {
  if (!SSL_CTX_set_max_proto_version(sc->ctx, v)) abort();
}
EXPORT(tn_ctx_get_min_proto) uint32_t tn_ctx_get_min_proto(TnContext* sc) {
  return static_cast<uint32_t>(SSL_CTX_get_min_proto_version(sc->ctx));
}
EXPORT(tn_ctx_get_max_proto) uint32_t tn_ctx_get_max_proto(TnContext* sc) {
  return static_cast<uint32_t>(SSL_CTX_get_max_proto_version(sc->ctx));
}

// SecureContext::SetOptions, crypto_context.cc:2109-2121. Node casts to `long`, 64 bits on its LP64 hosts;
// OpenSSL 3's options are uint64_t, so the whole value is taken (wasm32's `long` is 32 bits).
EXPORT(tn_ctx_set_options) void tn_ctx_set_options(TnContext* sc, int64_t options) {
  SSL_CTX_set_options(sc->ctx, static_cast<uint64_t>(options));
}

// SecureContext::SetSessionIdContext, crypto_context.cc:2123-2153. Answers 1, or 0 (the binding then reads
// tn_err_print for the TypeError's message).
EXPORT(tn_ctx_set_session_id_context) int tn_ctx_set_session_id_context(TnContext* sc, const unsigned char* id,
                                                                        size_t length) {
  return SSL_CTX_set_session_id_context(sc->ctx, id, static_cast<unsigned int>(length)) == 1;
}

// SecureContext::SetSessionTimeout, crypto_context.cc:2155-2165.
EXPORT(tn_ctx_set_session_timeout) void tn_ctx_set_session_timeout(TnContext* sc, int32_t timeout) {
  SSL_CTX_set_timeout(sc->ctx, timeout);
}

// SecureContext::GetTicketKeys/SetTicketKeys, crypto_context.cc:2424-2456: 48 bytes, name, HMAC key, AES key.
EXPORT(tn_ctx_get_ticket_keys) void tn_ctx_get_ticket_keys(TnContext* sc, unsigned char* out) {
  memcpy(out, sc->ticket_key_name, 16);
  memcpy(out + 16, sc->ticket_key_hmac, 16);
  memcpy(out + 32, sc->ticket_key_aes, 16);
}
EXPORT(tn_ctx_set_ticket_keys) void tn_ctx_set_ticket_keys(TnContext* sc, const unsigned char* in) {
  memcpy(sc->ticket_key_name, in, 16);
  memcpy(sc->ticket_key_hmac, in + 16, 16);
  memcpy(sc->ticket_key_aes, in + 32, 16);
}

// ---- TLSWrap (crypto_tls.cc) ------------------------------------------------------------------------------

struct TnSsl {
  SSL* ssl = nullptr;
  BIO* enc_in = nullptr;
  BIO* enc_out = nullptr;
  TnContext* sc = nullptr;
  bool is_server = false;
  bool session_callbacks = false;
  bool alpn_callback_enabled = false;
  std::vector<unsigned char> alpn_protos;
};

// TLSWrap::SSLInfoCallback, crypto_tls.cc:599-639.
static void SSLInfoCallback(const SSL* ssl_, int where, int ret) {
  if (!(where & (SSL_CB_HANDSHAKE_START | SSL_CB_HANDSHAKE_DONE))) return;
  SSL* ssl = const_cast<SSL*>(ssl_);
  TnSsl* c = static_cast<TnSsl*>(SSL_get_app_data(ssl_));
  if (where & SSL_CB_HANDSHAKE_START) tn_host_handshake(c, 0);
  if ((where & SSL_CB_HANDSHAKE_DONE) && !SSL_renegotiate_pending(ssl)) tn_host_handshake(c, 1);
}

// KeylogCallback, crypto_tls.cc:143-158 (the binding appends the newline).
static void KeylogCallback(const SSL* s, const char* line) {
  tn_host_keylog(static_cast<TnSsl*>(SSL_get_app_data(s)), line, strlen(line));
}

// NewSessionCallback, crypto_tls.cc:160-208. SecureContext::kMaxSessionSize is 10 KiB (crypto_context.h).
static int NewSessionCallback(SSL* s, SSL_SESSION* sess) {
  TnSsl* w = static_cast<TnSsl*>(SSL_get_app_data(s));
  if (!w->session_callbacks) return 0;
  int size = i2d_SSL_SESSION(sess, nullptr);
  if (size > 10 * 1024) return 0;
  std::vector<unsigned char> der(static_cast<size_t>(size));
  unsigned char* p = der.data();
  i2d_SSL_SESSION(sess, &p);
  unsigned int id_length;
  const unsigned char* id = SSL_SESSION_get_id(sess, &id_length);
  tn_host_new_session(w, id, id_length, der.data(), der.size());
  return 0;
}

// SSLCertCallback, crypto_tls.cc:210-247: the binding keeps the "waiting" and "running" state (EnableCertCb) and
// answers 1 to continue or -1 to suspend the handshake (SSL_ERROR_WANT_X509_LOOKUP).
static int SSLCertCallback(SSL* s, void* arg) {
  TnSsl* w = static_cast<TnSsl*>(SSL_get_app_data(s));
  if (!w->is_server) return 1;
  const char* servername = SSL_get_servername(s, TLSEXT_NAMETYPE_host_name);
  return tn_host_cert(w, servername ? servername : "", servername ? strlen(servername) : 0,
                      SSL_get_tlsext_status_type(s) == TLSEXT_STATUSTYPE_ocsp);
}

// SelectALPNCallback, crypto_tls.cc:249-302.
static int SelectALPNCallback(SSL* s, const unsigned char** out, unsigned char* outlen, const unsigned char* in,
                              unsigned int inlen, void* arg) {
  TnSsl* w = static_cast<TnSsl*>(SSL_get_app_data(s));
  if (w->alpn_callback_enabled) {
    int offset = tn_host_alpn(w, in, inlen);
    if (offset < 0) return SSL_TLSEXT_ERR_ALERT_FATAL;
    *outlen = *(in + offset);
    *out = in + offset + 1;
    return SSL_TLSEXT_ERR_OK;
  }
  if (w->alpn_protos.empty()) return SSL_TLSEXT_ERR_NOACK;
  int status = SSL_select_next_proto(const_cast<unsigned char**>(out), outlen, w->alpn_protos.data(),
                                     static_cast<unsigned int>(w->alpn_protos.size()), in, inlen);
  return status == OPENSSL_NPN_NEGOTIATED ? SSL_TLSEXT_ERR_OK : SSL_TLSEXT_ERR_ALERT_FATAL;
}

// VerifyCallback, crypto_tls.cc: "Always allow a connection. We'll reject in javascript."
static int VerifyCallback(int preverify_ok, X509_STORE_CTX* ctx) { return 1; }

// TLSWrap::Wrap's SSL and TLSWrap::InitSSL, crypto_tls.cc:476-527, with BIO_s_mem in place of NodeBIO.
EXPORT(tn_ssl_new) TnSsl* tn_ssl_new(TnContext* sc, int is_server) {
  SSL* ssl = SSL_new(sc->ctx);
  if (ssl == nullptr) return nullptr;
  TnSsl* w = new TnSsl();
  w->ssl = ssl;
  w->sc = sc;
  w->is_server = is_server != 0;
  w->enc_in = BIO_new(BIO_s_mem());
  w->enc_out = BIO_new(BIO_s_mem());
  // NodeBIO answers a read of an empty buffer with "retry" while it is open (crypto_bio.cc); a memory BIO does
  // so when its EOF return is -1.
  BIO_set_mem_eof_return(w->enc_in, -1);
  BIO_set_mem_eof_return(w->enc_out, -1);
  SSL_set_bio(ssl, w->enc_in, w->enc_out);
  SSL_set_verify(ssl, SSL_VERIFY_NONE, VerifyCallback);
  SSL_set_mode(ssl, SSL_MODE_RELEASE_BUFFERS);
  SSL_set_mode(ssl, SSL_MODE_AUTO_RETRY);
  SSL_set_app_data(ssl, w);
  SSL_set_info_callback(ssl, SSLInfoCallback);
  SSL_set_cert_cb(ssl, SSLCertCallback, w);
  if (w->is_server) {
    SSL_set_accept_state(ssl);
  } else {
    SSL_set_connect_state(ssl);
  }
  return w;
}

// TLSWrap::Destroy, crypto_tls.cc:1314-1334.
EXPORT(tn_ssl_free) void tn_ssl_free(TnSsl* w) {
  if (w == nullptr) return;
  SSL_free(w->ssl);  // frees both BIOs
  delete w;
}

// The underlying stream's read, written into enc_in (TLSWrap::OnStreamRead, crypto_tls.cc:1157-1201).
EXPORT(tn_ssl_enc_in) int tn_ssl_enc_in(TnSsl* w, const void* data, size_t length) {
  return BIO_write(w->enc_in, data, static_cast<int>(length));
}

// EncOut's view of enc_out (crypto_tls.cc:641-735): the pending bytes, peeked; the binding writes them to the
// underlying stream and commits them once the write completes (OnStreamAfterWrite, 737-784).
EXPORT(tn_ssl_enc_out_pending) size_t tn_ssl_enc_out_pending(TnSsl* w) { return BIO_pending(w->enc_out); }
EXPORT(tn_ssl_enc_out_peek) const char* tn_ssl_enc_out_peek(TnSsl* w) {
  char* data = nullptr;
  BIO_get_mem_data(w->enc_out, &data);
  return data;
}
EXPORT(tn_ssl_enc_out_commit) void tn_ssl_enc_out_commit(TnSsl* w, size_t length) {
  char scratch[4096];
  while (length > 0) {
    int chunk = static_cast<int>(length < sizeof(scratch) ? length : sizeof(scratch));
    int n = BIO_read(w->enc_out, scratch, chunk);
    if (n <= 0) break;
    length -= static_cast<size_t>(n);
  }
}

// ClearOut's SSL_read and SSL_get_error (crypto_tls.cc:786-911); ClearIn's SSL_write (913-968); DoShutdown's
// SSL_shutdown (1207-1217).
EXPORT(tn_ssl_read) int tn_ssl_read(TnSsl* w, void* out, size_t length) {
  return SSL_read(w->ssl, out, static_cast<int>(length));
}
EXPORT(tn_ssl_write) int tn_ssl_write(TnSsl* w, const void* data, size_t length) {
  return SSL_write(w->ssl, data, static_cast<int>(length));
}
EXPORT(tn_ssl_get_error) int tn_ssl_get_error(TnSsl* w, int ret) { return SSL_get_error(w->ssl, ret); }
EXPORT(tn_ssl_shutdown) int tn_ssl_shutdown(TnSsl* w) { return SSL_shutdown(w->ssl); }

// TLSWrap::SetVerifyMode, crypto_tls.cc:1219-1249.
EXPORT(tn_ssl_set_verify_mode) void tn_ssl_set_verify_mode(TnSsl* w, int request_cert, int reject_unauthorized) {
  int verify_mode;
  if (w->is_server) {
    if (!request_cert) {
      verify_mode = SSL_VERIFY_NONE;
    } else {
      verify_mode = SSL_VERIFY_PEER;
      if (reject_unauthorized) verify_mode |= SSL_VERIFY_FAIL_IF_NO_PEER_CERT;
    }
  } else {
    verify_mode = SSL_VERIFY_NONE;
  }
  SSL_set_verify(w->ssl, verify_mode, VerifyCallback);
}

// TLSWrap::EnableSessionCallbacks, crypto_tls.cc:1251-1265 (the ClientHello parser is not carried: see the
// binding), EnableKeylogCallback 1267-1282, EnableALPNCb 1353-1361 (EnableCertCb is the binding's alone).
EXPORT(tn_ssl_enable_session_callbacks) void tn_ssl_enable_session_callbacks(TnSsl* w) {
  w->session_callbacks = true;
  SSL_CTX_sess_set_new_cb(w->sc->ctx, NewSessionCallback);
}
EXPORT(tn_ssl_enable_keylog) void tn_ssl_enable_keylog(TnSsl* w) {
  SSL_CTX_set_keylog_callback(w->sc->ctx, KeylogCallback);
}
EXPORT(tn_ssl_enable_alpn_cb) void tn_ssl_enable_alpn_cb(TnSsl* w) {
  w->alpn_callback_enabled = true;
  SSL_CTX_set_alpn_select_cb(SSL_get_SSL_CTX(w->ssl), SelectALPNCallback, nullptr);
}

// TLSWrap::GetServername/SetServername, crypto_tls.cc:1363-1392.
EXPORT(tn_ssl_get_servername) const char* tn_ssl_get_servername(TnSsl* w) {
  return SSL_get_servername(w->ssl, TLSEXT_NAMETYPE_host_name);
}
EXPORT(tn_ssl_set_servername) void tn_ssl_set_servername(TnSsl* w, const char* name) {
  SSL_set_tlsext_host_name(w->ssl, name);
}

// TLSWrap::SetALPNProtocols, crypto_tls.cc:1659-1676.
EXPORT(tn_ssl_set_alpn_protocols) void tn_ssl_set_alpn_protocols(TnSsl* w, const unsigned char* protos,
                                                                  size_t length) {
  if (!w->is_server) {
    if (SSL_set_alpn_protos(w->ssl, protos, static_cast<unsigned int>(length)) != 0) abort();
  } else {
    w->alpn_protos.assign(protos, protos + length);
    SSL_CTX_set_alpn_select_cb(SSL_get_SSL_CTX(w->ssl), SelectALPNCallback, nullptr);
  }
}

// TLSWrap::GetALPNNegotiatedProto, crypto_tls.cc:2122-2146: the length; the bytes at *out.
EXPORT(tn_ssl_get_alpn_selected) size_t tn_ssl_get_alpn_selected(TnSsl* w, const unsigned char** out) {
  unsigned int length = 0;
  SSL_get0_alpn_selected(w->ssl, out, &length);
  return length;
}

// TLSWrap::GetProtocol, crypto_tls.cc:2115-2120; GetCipherInfo (crypto_common.cc): name, standardName, version.
EXPORT(tn_ssl_get_version) const char* tn_ssl_get_version(TnSsl* w) { return SSL_get_version(w->ssl); }
EXPORT(tn_ssl_cipher_name) const char* tn_ssl_cipher_name(TnSsl* w) {
  const SSL_CIPHER* c = SSL_get_current_cipher(w->ssl);
  return c ? SSL_CIPHER_get_name(c) : nullptr;
}
EXPORT(tn_ssl_cipher_standard_name) const char* tn_ssl_cipher_standard_name(TnSsl* w) {
  const SSL_CIPHER* c = SSL_get_current_cipher(w->ssl);
  return c ? SSL_CIPHER_standard_name(c) : nullptr;
}
EXPORT(tn_ssl_cipher_version) const char* tn_ssl_cipher_version(TnSsl* w) {
  const SSL_CIPHER* c = SSL_get_current_cipher(w->ssl);
  return c ? SSL_CIPHER_get_version(c) : nullptr;
}

// TLSWrap::GetSession, crypto_tls.cc:1810-1834: i2d of the session, malloc'd; answers its length (0: none).
EXPORT(tn_ssl_get_session) size_t tn_ssl_get_session(TnSsl* w, unsigned char** out) {
  SSL_SESSION* sess = SSL_get_session(w->ssl);
  *out = nullptr;
  if (sess == nullptr) return 0;
  int length = i2d_SSL_SESSION(sess, nullptr);
  if (length <= 0) return 0;
  unsigned char* buffer = static_cast<unsigned char*>(malloc(static_cast<size_t>(length)));
  unsigned char* p = buffer;
  i2d_SSL_SESSION(sess, &p);
  *out = buffer;
  return static_cast<size_t>(length);
}
// TLSWrap::SetSession, crypto_tls.cc:1836-1853. Answers 1, 0 where the session does not parse (Node returns
// silently), -1 where SSL_set_session fails ("SSL_set_session error").
EXPORT(tn_ssl_set_session) int tn_ssl_set_session(TnSsl* w, const unsigned char* der, size_t length) {
  const unsigned char* p = der;
  SSL_SESSION* sess = d2i_SSL_SESSION(nullptr, &p, static_cast<long>(length));
  if (sess == nullptr) return 0;
  int ok = SSL_set_session(w->ssl, sess);
  SSL_SESSION_free(sess);
  return ok == 1 ? 1 : -1;
}
EXPORT(tn_ssl_session_reused) int tn_ssl_session_reused(TnSsl* w) { return SSL_session_reused(w->ssl); }

// TLSWrap::VerifyError, crypto_tls.cc:1862-1891: the verify result (UNABLE_TO_GET_ISSUER_CERT with no peer
// certificate), its code name and its reason.
EXPORT(tn_ssl_verify_result) int32_t tn_ssl_verify_result(TnSsl* w) {
  ncrypto::SSLPointer view(w->ssl);
  auto result = view.verifyPeerCertificate();
  view.release();
  return static_cast<int32_t>(result.value_or(X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT));
}
EXPORT(tn_x509_error_code) const char* tn_x509_error_code(int32_t err) { return ncrypto::X509Pointer::ErrorCode(err); }
EXPORT(tn_x509_error_reason) const char* tn_x509_error_reason(int32_t err) {
  auto reason = ncrypto::X509Pointer::ErrorReason(err);
  return reason.has_value() ? reason.value() : X509_verify_cert_error_string(err);
}

// The peer's and the own certificate, as DER (malloc'd), for the binding's certificate objects
// (TLSWrap::GetPeerCertificate 1705-1719, GetCertificate 1735-1743). index 0 is the leaf; a peer chain's further
// entries follow (SSL_get_peer_cert_chain), as Node's GetPeerCert walks them.
static size_t ToDer(X509* cert, unsigned char** out) {
  *out = nullptr;
  if (cert == nullptr) return 0;
  int length = i2d_X509(cert, out);
  return length > 0 ? static_cast<size_t>(length) : 0;
}
EXPORT(tn_ssl_peer_certificate) size_t tn_ssl_peer_certificate(TnSsl* w, unsigned char** out) {
  X509* cert = SSL_get1_peer_certificate(w->ssl);
  size_t length = ToDer(cert, out);
  X509_free(cert);
  return length;
}
EXPORT(tn_ssl_peer_chain_length) int tn_ssl_peer_chain_length(TnSsl* w) {
  STACK_OF(X509)* chain = SSL_get_peer_cert_chain(w->ssl);
  return chain ? sk_X509_num(chain) : 0;
}
EXPORT(tn_ssl_peer_chain_certificate) size_t tn_ssl_peer_chain_certificate(TnSsl* w, int index, unsigned char** out) {
  STACK_OF(X509)* chain = SSL_get_peer_cert_chain(w->ssl);
  return ToDer(chain ? sk_X509_value(chain, index) : nullptr, out);
}
EXPORT(tn_ssl_certificate) size_t tn_ssl_certificate(TnSsl* w, unsigned char** out) {
  return ToDer(SSL_get_certificate(w->ssl), out);
}

// TLSWrap::GetFinished/GetPeerFinished, crypto_tls.cc:1754-1808: the length (0: none) into out (128 bytes is
// more than either message's length; Node sizes by a first call).
EXPORT(tn_ssl_finished) size_t tn_ssl_finished(TnSsl* w, void* out, size_t length) {
  return SSL_get_finished(w->ssl, out, length);
}
EXPORT(tn_ssl_peer_finished) size_t tn_ssl_peer_finished(TnSsl* w, void* out, size_t length) {
  return SSL_get_peer_finished(w->ssl, out, length);
}

// TLSWrap::ExportKeyingMaterial, crypto_tls.cc:1996-2034.
EXPORT(tn_ssl_export_keying_material) int tn_ssl_export_keying_material(TnSsl* w, unsigned char* out, size_t olen,
                                                                       const char* label, size_t llen,
                                                                       const unsigned char* context, size_t clen,
                                                                       int use_context) {
  return SSL_export_keying_material(w->ssl, out, olen, label, llen, context, clen, use_context);
}

// TLSWrap::Renegotiate, crypto_tls.cc:2042-2048; GetTLSTicket 2050-2068; SetMaxSendFragment 2172-2183;
// IsSessionReused above; GetEphemeralKeyInfo's key (crypto_common.cc GetEphemeralKey).
EXPORT(tn_ssl_renegotiate) int tn_ssl_renegotiate(TnSsl* w) { return SSL_renegotiate(w->ssl); }
EXPORT(tn_ssl_tls_ticket) size_t tn_ssl_tls_ticket(TnSsl* w, const unsigned char** out) {
  SSL_SESSION* sess = SSL_get_session(w->ssl);
  *out = nullptr;
  if (sess == nullptr) return 0;
  size_t length = 0;
  SSL_SESSION_get0_ticket(sess, out, &length);
  return length;
}
EXPORT(tn_ssl_set_max_send_fragment) int tn_ssl_set_max_send_fragment(TnSsl* w, long size) {
  return SSL_set_max_send_fragment(w->ssl, size);
}
// The peer's ephemeral key: its type (EVP_PKEY_id), its bits, and for an EC key its curve's short name.
EXPORT(tn_ssl_ephemeral_key) int tn_ssl_ephemeral_key(TnSsl* w, int* bits, const char** curve) {
  EVP_PKEY* key = nullptr;
  *bits = 0;
  *curve = nullptr;
  if (!SSL_get_peer_tmp_key(w->ssl, &key)) return 0;
  int id = EVP_PKEY_id(key);
  *bits = EVP_PKEY_bits(key);
  if (id == EVP_PKEY_EC) {
    char name[80];
    size_t name_length = 0;
    if (EVP_PKEY_get_utf8_string_param(key, OSSL_PKEY_PARAM_GROUP_NAME, name, sizeof(name), &name_length)) {
      int nid = OBJ_sn2nid(name);
      if (nid == NID_undef) nid = OBJ_ln2nid(name);
      *curve = nid != NID_undef ? OBJ_nid2sn(nid) : nullptr;
    }
  } else if (id == EVP_PKEY_X25519 || id == EVP_PKEY_X448) {
    *curve = OBJ_nid2sn(id);
  }
  EVP_PKEY_free(key);
  return id;
}

// The negotiated group (GetEphemeralKey answers it by name for TLS 1.3's hybrid groups).
EXPORT(tn_ssl_negotiated_group) const char* tn_ssl_negotiated_group(TnSsl* w) {
  int nid = SSL_get_negotiated_group(w->ssl);
  return nid == NID_undef ? nullptr : SSL_group_to_name(w->ssl, nid);
}

// getSSLCiphers (crypto_util.cc GetSSLCiphers): the lower-cased names are the binding's.
static STACK_OF(SSL_CIPHER)* cipher_list = nullptr;
EXPORT(tn_ssl_cipher_count) int tn_ssl_cipher_count() {
  if (cipher_list == nullptr) {
    SSL_CTX* ctx = SSL_CTX_new(TLS_method());
    SSL* ssl = SSL_new(ctx);
    cipher_list = sk_SSL_CIPHER_dup(SSL_get_ciphers(ssl));
    SSL_free(ssl);
    SSL_CTX_free(ctx);
  }
  return sk_SSL_CIPHER_num(cipher_list);
}
EXPORT(tn_ssl_cipher_at) const char* tn_ssl_cipher_at(int index) {
  return SSL_CIPHER_get_name(sk_SSL_CIPHER_value(cipher_list, index));
}

// ---- Certificates as objects (crypto_x509.cc X509ToObject, 720-855) --------------------------------------

EXPORT(tn_x509_from_der) X509* tn_x509_from_der(const unsigned char* der, size_t length) {
  const unsigned char* p = der;
  return d2i_X509(nullptr, &p, static_cast<long>(length));
}
EXPORT(tn_x509_free) void tn_x509_free(X509* x) { X509_free(x); }

// A malloc'd copy of `text`, its length in *length; null for "undefined".
static char* Copy(const char* text, size_t size, size_t* length) {
  char* out = static_cast<char*>(malloc(size + 1));
  if (out == nullptr) return nullptr;
  memcpy(out, text, size);
  out[size] = 0;
  *length = size;
  return out;
}
static char* CopyBio(const ncrypto::BIOPointer& bio, size_t* length) {
  if (!bio) return nullptr;
  BUF_MEM* mem = bio;
  return Copy(mem->data, mem->length, length);
}

// GetX509NameObject's entries (611-667), as key NUL value NUL pairs; the binding builds Node's null-prototype
// object, with an array where a key repeats.
EXPORT(tn_x509_name) char* tn_x509_name(X509* x, int issuer, size_t* length) {
  ncrypto::X509View view(x);
  const ncrypto::X509Name name = issuer ? view.getIssuerName() : view.getSubjectName();
  *length = 0;
  if (!name) return nullptr;
  std::string out;
  for (auto entry : name) {
    auto pair = entry;
    out.append(pair.first);
    out.push_back('\0');
    out.append(pair.second);
    out.push_back('\0');
  }
  return Copy(out.data(), out.size(), length);
}

// The text fields of X509ToObject and X509Certificate's methods; null answers "undefined".
//  0 subjectaltname  1 infoAccess  2 valid_from  3 valid_to  4 fingerprint  5 fingerprint256  6 fingerprint512
//  7 serialNumber    8 modulus     9 exponent    10 asn1Curve  11 nistCurve 12 pem 13 signatureAlgorithm
//  14 signatureAlgorithmOid
EXPORT(tn_x509_text) char* tn_x509_text(X509* x, int field, size_t* length) {
  ncrypto::X509View view(x);
  *length = 0;
  switch (field) {
    case 0: return CopyBio(view.getSubjectAltName(), length);
    case 1: return CopyBio(view.getInfoAccess(), length);
    case 2: return CopyBio(view.getValidFrom(), length);
    case 3: return CopyBio(view.getValidTo(), length);
    case 4: case 5: case 6: {
      const ncrypto::Digest& digest =
          field == 4 ? ncrypto::Digest::SHA1 : field == 5 ? ncrypto::Digest::SHA256 : ncrypto::Digest::SHA512;
      auto fingerprint = view.getFingerprint(digest);
      if (!fingerprint.has_value()) return nullptr;
      return Copy(fingerprint->data(), fingerprint->size(), length);
    }
    case 7: {
      // GetSerialNumber (260-266): upper-cased.
      auto serial = view.getSerialNumber();
      if (!serial) return nullptr;
      std::string text(static_cast<char*>(serial.get()));
      for (auto& c : text) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
      return Copy(text.data(), text.size(), length);
    }
    case 8: case 9: {
      char* result = nullptr;
      view.ifRsa([&](const ncrypto::Rsa& rsa) {
        auto key = rsa.getPublicKey();
        if (field == 8) {
          result = CopyBio(ncrypto::BIOPointer::New(key.n), length);  // GetModulusString (676-681)
        } else if (key.e != nullptr) {
          // GetExponentString (683-691): "0x" and BN_print.
          ncrypto::BIOPointer bio = ncrypto::BIOPointer::NewMem();
          BIO_puts(bio.get(), "0x");
          BN_print(bio.get(), key.e);
          result = CopyBio(bio, length);
        }
        return true;
      });
      return result;
    }
    case 10: case 11: {
      char* result = nullptr;
      view.ifEc([&](const ncrypto::Ec& ec) {
        int nid = ec.getCurve();
        if (nid != 0) {
          const char* name = field == 10 ? OBJ_nid2sn(nid) : EC_curve_nid2nist(nid);
          if (name != nullptr && name[0] != 0) result = Copy(name, strlen(name), length);
        }
        return true;
      });
      return result;
    }
    case 12: return CopyBio(view.toPEM(), length);
    case 13: {
      auto algorithm = view.getSignatureAlgorithm();
      return algorithm.has_value() ? Copy(algorithm->data(), algorithm->size(), length) : nullptr;
    }
    case 14: {
      auto oid = view.getSignatureAlgorithmOID();
      return oid.has_value() ? Copy(oid->data(), oid->size(), length) : nullptr;
    }
  }
  return nullptr;
}

EXPORT(tn_x509_is_ca) int tn_x509_is_ca(X509* x) { return ncrypto::X509View(x).isCA(); }

// bits: the RSA modulus's bit count (BignumPointer::GetBitCount) or the EC group's order bits
// (GetECGroupBits, 703-712); -1 for "undefined".
EXPORT(tn_x509_bits) int tn_x509_bits(X509* x) {
  ncrypto::X509View view(x);
  int bits = -1;
  view.ifRsa([&](const ncrypto::Rsa& rsa) {
    bits = ncrypto::BignumPointer::GetBitCount(rsa.getPublicKey().n);
    return true;
  });
  view.ifEc([&](const ncrypto::Ec& ec) {
    const EC_GROUP* group = ec.getGroup();
    int b = group ? EC_GROUP_order_bits(group) : 0;
    bits = b > 0 ? b : -1;
    return true;
  });
  return bits;
}

// pubkey: the RSA key's DER (GetPubKey, 669-674) or the EC point in the key's conversion form (GetECPubKey,
// 693-701); null for "undefined".
EXPORT(tn_x509_pubkey) unsigned char* tn_x509_pubkey(X509* x, size_t* length) {
  ncrypto::X509View view(x);
  unsigned char* result = nullptr;
  *length = 0;
  view.ifRsa([&](const ncrypto::Rsa& rsa) {
    auto bio = rsa.derPublicKey();
    if (bio) result = reinterpret_cast<unsigned char*>(CopyBio(bio, length));
    return true;
  });
  view.ifEc([&](const ncrypto::Ec& ec) {
    const EC_GROUP* group = ec.getGroup();
    const EC_POINT* point = ec.getPublicKey();
    if (group == nullptr || point == nullptr) return true;
    point_conversion_form_t form = ec.getPointConversionForm();
    size_t size = EC_POINT_point2oct(group, point, form, nullptr, 0, nullptr);
    if (size == 0) return true;
    result = static_cast<unsigned char*>(malloc(size));
    if (EC_POINT_point2oct(group, point, form, result, size, nullptr) != size) {
      free(result);
      result = nullptr;
      return true;
    }
    *length = size;
    return true;
  });
  return result;
}

// ext_key_usage (GetKeyUsage, 268-275): the usages NUL-separated; null for "undefined".
EXPORT(tn_x509_key_usage) char* tn_x509_key_usage(X509* x, size_t* length) {
  std::string out;
  *length = 0;
  bool ok = ncrypto::X509View(x).enumUsages([&](const char* usage) {
    out.append(usage);
    out.push_back('\0');
  });
  if (!ok) return nullptr;
  return Copy(out.data(), out.size(), length);
}

// The DER, malloc'd (GetDer, 172-181).
EXPORT(tn_x509_der) size_t tn_x509_der(X509* x, unsigned char** out) { return ToDer(x, out); }

// X509Certificate::GetIssuerCert's walk (GetPeerCertificate's chain, crypto_common.cc): whether `issuer` issued `x`.
EXPORT(tn_x509_issued_by) int tn_x509_issued_by(X509* x, X509* issuer) {
  return ncrypto::X509View(x).isIssuedBy(ncrypto::X509View(issuer));
}

// X509Pointer::IssuerFrom (ncrypto.cc:1669-1686), as GetLastIssuedCert (crypto_common.cc:139-171) walks the
// context's store: the issuer of `x`, a new reference the binding frees, or null.
EXPORT(tn_ssl_issuer_from_store) X509* tn_ssl_issuer_from_store(TnSsl* w, X509* x) {
  return ncrypto::X509Pointer::IssuerFrom(SSL_get_SSL_CTX(w->ssl), ncrypto::X509View(x)).release();
}

// The context switch CertCbDone (crypto_tls.cc:1595-1657) and SetKeyCert (1678-1703) both make:
// SSLPointer::setSniContext (ncrypto.cc:4226-4243), then TLSWrap::SetCACerts (crypto_tls.cc:1429-1443). Answers 1;
// 2 where setSniContext failed (CertCbDone goes on without the switch, SetKeyCert throws); 0 where SetCACerts failed
// (both throw the queue's error).
EXPORT(tn_ssl_use_context) int tn_ssl_use_context(TnSsl* w, TnContext* sc) {
  ncrypto::SSLPointer ssl(w->ssl);
  ncrypto::SSLCtxPointer ctx(sc->ctx);
  bool switched = ssl.setSniContext(ctx);
  ctx.release();
  ssl.release();
  if (!switched) return 2;
  if (SSL_set1_verify_cert_store(w->ssl, SSL_CTX_get_cert_store(sc->ctx)) != 1) return 0;
  SSL_set_client_CA_list(w->ssl, SSL_dup_CA_list(SSL_CTX_get_client_CA_list(sc->ctx)));
  return 1;
}

// ---- Node's crypto constants (node_constants.cc DefineCryptoConstants, 865-1092) -------------------------

// The body is Node's, extracted by the build; each definition is written as a line: "n NAME VALUE" for a number
// (Node's NODE_DEFINE_CONSTANT is a Number of the value) and "s NAME VALUE" for a string. Answers the text,
// malloc'd, its length in *length.
#include "default_cipher_list.inc"
EXPORT(tn_crypto_constants) char* tn_crypto_constants(size_t* length) {
  std::string target;
  char line[512];
#define HAVE_OPENSSL 1
#define NODE_DEFINE_CONSTANT(target, name)                                                     \
  do {                                                                                         \
    snprintf(line, sizeof(line), "n %s %.17g\n", #name, static_cast<double>(name));            \
    target.append(line);                                                                       \
  } while (0)
#define NODE_DEFINE_STRING_CONSTANT(target, name, value)                                       \
  do {                                                                                         \
    target.append("s ").append(name).append(" ").append(value).append("\n");                   \
  } while (0)
#include "crypto_constants_body.inc"
#undef NODE_DEFINE_CONSTANT
#undef NODE_DEFINE_STRING_CONSTANT
  return Copy(target.data(), target.size(), length);
}

// GetBIOError (crypto_tls.cc:397-406): the first line ERR_print_errors_cb gives, malloc'd (the queue is consumed as
// Node's is), its length in *length.
EXPORT(tn_err_bio_error) char* tn_err_bio_error(size_t* length) {
  std::string ret;
  ERR_print_errors_cb(
      [](const char* str, size_t len, void* opaque) {
        static_cast<std::string*>(opaque)->assign(str, len);
        return 0;
      },
      static_cast<void*>(&ret));
  return Copy(ret.data(), ret.size(), length);
}

// ClearOut's and ClearIn's MarkPopErrorOnReturn and SetVerifyMode's ClearErrorOnReturn are the binding's, through
// tn_err_set_mark / tn_err_pop_to_mark / tn_err_clear above.

// SecureContext::SetDHParam (crypto_context.cc:1998-2061). `pem` null is "auto" (the JavaScript passes true).
// Answers 1 set; 2 set, with "DH parameter is less than 2048 bits"; 0 not DH parameters, silently discarded as
// Node discards them; -1 "DH parameter is less than 1024 bits"; -2 "Error setting temp DH parameter".
EXPORT(tn_ctx_set_dh_param) int tn_ctx_set_dh_param(TnContext* sc, const char* pem, size_t length) {
  ERR_set_mark();
  if (pem == nullptr) {
    if (!SSL_CTX_set_dh_auto(sc->ctx, 1)) abort();
    ERR_pop_to_mark();
    return 1;
  }
  BIO* bio = BIO_new_mem_buf(pem, static_cast<int>(length));
  EVP_PKEY* params = bio ? PEM_read_bio_Parameters(bio, nullptr) : nullptr;
  if (bio) BIO_free(bio);
  if (params && EVP_PKEY_id(params) != EVP_PKEY_DH) { EVP_PKEY_free(params); params = nullptr; }
  if (params == nullptr) { ERR_pop_to_mark(); return 0; }
  int size = EVP_PKEY_get_bits(params);
  if (size < 1024) { EVP_PKEY_free(params); ERR_pop_to_mark(); return -1; }
  if (!SSL_CTX_set0_tmp_dh_pkey(sc->ctx, params)) { EVP_PKEY_free(params); ERR_pop_to_mark(); return -2; }
  ERR_pop_to_mark();
  return size < 2048 ? 2 : 1;
}

// ResetRootCertStore's release of the process's store (crypto_context.cc:1260-1321): the next ask builds a new one;
// a context already holding the old store keeps its reference.
EXPORT(tn_root_reset) void tn_root_reset() {
  if (root_store != nullptr) X509_STORE_free(root_store);
  root_store = nullptr;
}
