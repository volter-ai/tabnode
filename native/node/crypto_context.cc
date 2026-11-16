// THE SecureContext OF THE crypto BINDING (Tabnode ADR-0018 item 7, ADR-0016 §3, §4): the OpenSSL half of Node
// v24.21.0's src/crypto/crypto_context.cc, over ncrypto and OpenSSL in the program. A SecureContext is an SSL_CTX and
// what Node's object keeps beside it (TnContext, crypto_util.h); the process's root store is Node's, filled from the
// PEM the binding hands in (the image's bundle and NODE_EXTRA_CA_CERTS, as --use-openssl-ca makes it).
#include <openssl/core_names.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/params.h>
#include <openssl/pem.h>
#include <openssl/x509v3.h>

#include <cstdlib>
#include <cstring>

#include "crypto_util.h"

// ---- The root store ---------------------------------------------------------------------------------------

// Node's bundled roots, src/node_root_certs.h, as crypto_context.cc:76-80 includes them.
static const char* const kRootCerts[] = {
#define NODE_WANT_INTERNALS 1
#include "node_root_certs.h"
};
CRYPTO_EXPORT(tabnode_bundled_root_count) size_t tabnode_bundled_root_count() { return sizeof(kRootCerts) / sizeof(kRootCerts[0]); }
CRYPTO_EXPORT(tabnode_bundled_root) const char* tabnode_bundled_root(size_t index) { return kRootCerts[index]; }

// The process's root store (Node's GetOrCreateRootCertStore, crypto_context.cc:1040-1100), built from the PEM
// the binding hands in: the image's bundle and NODE_EXTRA_CA_CERTS, as --use-openssl-ca makes it (ADR-0016 §4).
X509_STORE* root_store = nullptr;
X509_STORE* RootStore() {
  if (root_store == nullptr) root_store = X509_STORE_new();
  return root_store;
}
// Answers the number of certificates added.
CRYPTO_EXPORT(tabnode_root_add_pem) int tabnode_root_add_pem(const char* pem, size_t length) {
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
TnContext* ContextOf(const SSL_CTX* ctx) { return static_cast<TnContext*>(SSL_CTX_get_ex_data(ctx, ContextIndex())); }

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
CRYPTO_EXPORT(tabnode_ctx_new) TnContext* tabnode_ctx_new(int method) {
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
CRYPTO_EXPORT(tabnode_ctx_init) int tabnode_ctx_init(TnContext* sc, int min_version, int max_version) {
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
CRYPTO_EXPORT(tabnode_ctx_free) void tabnode_ctx_free(TnContext* sc) {
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
CRYPTO_EXPORT(tabnode_ctx_set_key) int tabnode_ctx_set_key(TnContext* sc, const char* pem, size_t length, const char* pass,
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
CRYPTO_EXPORT(tabnode_ctx_set_cert) int tabnode_ctx_set_cert(TnContext* sc, const char* pem, size_t length) {
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
CRYPTO_EXPORT(tabnode_ctx_add_ca_cert) void tabnode_ctx_add_ca_cert(TnContext* sc, const char* pem, size_t length) {
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
CRYPTO_EXPORT(tabnode_ctx_add_crl) int tabnode_ctx_add_crl(TnContext* sc, const char* pem, size_t length) {
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
CRYPTO_EXPORT(tabnode_ctx_add_root_certs) void tabnode_ctx_add_root_certs(TnContext* sc) {
  X509_STORE* store = RootStore();
  X509_STORE_up_ref(store);
  SSL_CTX_set_cert_store(sc->ctx, store);
}

// SecureContext::SetAllowPartialTrustChain, crypto_context.cc:1846-1869.
CRYPTO_EXPORT(tabnode_ctx_set_allow_partial_trust_chain) void tabnode_ctx_set_allow_partial_trust_chain(TnContext* sc) {
  if (X509_STORE_set_flags(OwnCertStore(sc), X509_V_FLAG_PARTIAL_CHAIN) != 1) abort();
}

// SecureContext::SetCipherSuites, crypto_context.cc:1944-1957.
CRYPTO_EXPORT(tabnode_ctx_set_cipher_suites) int tabnode_ctx_set_cipher_suites(TnContext* sc, const char* suites) {
  return SSL_CTX_set_ciphersuites(sc->ctx, suites) == 1;
}

// SecureContext::SetCiphers, crypto_context.cc:1959-1981: an empty list's SSL_R_NO_CIPHER_MATCH is not an error.
// Answers 1, or 0 with the error left for the binding to read.
CRYPTO_EXPORT(tabnode_ctx_set_ciphers) int tabnode_ctx_set_ciphers(TnContext* sc, const char* ciphers) {
  if (SSL_CTX_set_cipher_list(sc->ctx, ciphers)) return 1;
  unsigned long err = ERR_peek_error();
  if (strlen(ciphers) == 0 && ERR_GET_REASON(err) == SSL_R_NO_CIPHER_MATCH) { ERR_clear_error(); return 1; }
  return 0;
}

// SecureContext::SetECDHCurve, crypto_context.cc:1983-1996.
CRYPTO_EXPORT(tabnode_ctx_set_ecdh_curve) int tabnode_ctx_set_ecdh_curve(TnContext* sc, const char* curve) {
  if (strcmp(curve, "auto") == 0) return 1;
  return SSL_CTX_set1_curves_list(sc->ctx, curve) == 1;
}

// SecureContext::SetSigalgs, crypto_context.cc:1752-1766.
CRYPTO_EXPORT(tabnode_ctx_set_sigalgs) int tabnode_ctx_set_sigalgs(TnContext* sc, const char* sigalgs) {
  return SSL_CTX_set1_sigalgs_list(sc->ctx, sigalgs) == 1;
}

// SecureContext::SetMinProto/SetMaxProto/GetMinProto/GetMaxProto, crypto_context.cc:2063-2107.
CRYPTO_EXPORT(tabnode_ctx_set_min_proto) void tabnode_ctx_set_min_proto(TnContext* sc, int v) {
  if (!SSL_CTX_set_min_proto_version(sc->ctx, v)) abort();
}
CRYPTO_EXPORT(tabnode_ctx_set_max_proto) void tabnode_ctx_set_max_proto(TnContext* sc, int v) {
  if (!SSL_CTX_set_max_proto_version(sc->ctx, v)) abort();
}
CRYPTO_EXPORT(tabnode_ctx_get_min_proto) uint32_t tabnode_ctx_get_min_proto(TnContext* sc) {
  return static_cast<uint32_t>(SSL_CTX_get_min_proto_version(sc->ctx));
}
CRYPTO_EXPORT(tabnode_ctx_get_max_proto) uint32_t tabnode_ctx_get_max_proto(TnContext* sc) {
  return static_cast<uint32_t>(SSL_CTX_get_max_proto_version(sc->ctx));
}

// SecureContext::SetOptions, crypto_context.cc:2109-2121: Node casts to `long`, 64 bits here as on its LP64 hosts
// (wasm32-linux-muslwali's `long` is 64 bits); OpenSSL 3's options are uint64_t.
CRYPTO_EXPORT(tabnode_ctx_set_options) void tabnode_ctx_set_options(TnContext* sc, int64_t options) {
  SSL_CTX_set_options(sc->ctx, static_cast<uint64_t>(options));
}

// SecureContext::SetSessionIdContext, crypto_context.cc:2123-2153. Answers 1, or 0 (the binding then reads
// tabnode_err_print for the TypeError's message).
CRYPTO_EXPORT(tabnode_ctx_set_session_id_context) int tabnode_ctx_set_session_id_context(TnContext* sc, const unsigned char* id,
                                                                        size_t length) {
  return SSL_CTX_set_session_id_context(sc->ctx, id, static_cast<unsigned int>(length)) == 1;
}

// SecureContext::SetSessionTimeout, crypto_context.cc:2155-2165.
CRYPTO_EXPORT(tabnode_ctx_set_session_timeout) void tabnode_ctx_set_session_timeout(TnContext* sc, int32_t timeout) {
  SSL_CTX_set_timeout(sc->ctx, timeout);
}

// SecureContext::GetTicketKeys/SetTicketKeys, crypto_context.cc:2424-2456: 48 bytes, name, HMAC key, AES key.
CRYPTO_EXPORT(tabnode_ctx_get_ticket_keys) void tabnode_ctx_get_ticket_keys(TnContext* sc, unsigned char* out) {
  memcpy(out, sc->ticket_key_name, 16);
  memcpy(out + 16, sc->ticket_key_hmac, 16);
  memcpy(out + 32, sc->ticket_key_aes, 16);
}
CRYPTO_EXPORT(tabnode_ctx_set_ticket_keys) void tabnode_ctx_set_ticket_keys(TnContext* sc, const unsigned char* in) {
  memcpy(sc->ticket_key_name, in, 16);
  memcpy(sc->ticket_key_hmac, in + 16, 16);
  memcpy(sc->ticket_key_aes, in + 32, 16);
}

// SecureContext::SetDHParam (crypto_context.cc:1998-2061). `pem` null is "auto" (the JavaScript passes true).
// Answers 1 set; 2 set, with "DH parameter is less than 2048 bits"; 0 not DH parameters, silently discarded as
// Node discards them; -1 "DH parameter is less than 1024 bits"; -2 "Error setting temp DH parameter".
CRYPTO_EXPORT(tabnode_ctx_set_dh_param) int tabnode_ctx_set_dh_param(TnContext* sc, const char* pem, size_t length) {
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
CRYPTO_EXPORT(tabnode_root_reset) void tabnode_root_reset() {
  if (root_store != nullptr) X509_STORE_free(root_store);
  root_store = nullptr;
}
