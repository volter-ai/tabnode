// THE TLSWrap OF THE tls_wrap BINDING (Tabnode ADR-0018 item 7, ADR-0016 §3, §4): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_tls.cc, over ncrypto and OpenSSL in libnode.so. A connection is an SSL whose two BIOs are memory
// buffers; the engine's TLSWrap (src/node-lib/binding/tls_wrap.ts) writes the underlying stream's bytes into enc_in,
// drains enc_out to it, and runs ClearIn, ClearOut and EncOut over these calls. OpenSSL never touches a socket. What
// OpenSSL raises inside an SSL_* call reaches the engine through its tls_* imports (engine.h), synchronously, as
// Node's callbacks are made inside SSL_read and SSL_do_handshake.
#include <openssl/core_names.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/x509v3.h>

#include <cstdlib>
#include <cstring>

#include "crypto_util.h"

// ---- TLSWrap (crypto_tls.cc) ------------------------------------------------------------------------------

// TLSWrap::SSLInfoCallback, crypto_tls.cc:599-639.
static void SSLInfoCallback(const SSL* ssl_, int where, int ret) {
  if (!(where & (SSL_CB_HANDSHAKE_START | SSL_CB_HANDSHAKE_DONE))) return;
  SSL* ssl = const_cast<SSL*>(ssl_);
  TnSsl* c = static_cast<TnSsl*>(SSL_get_app_data(ssl_));
  if (where & SSL_CB_HANDSHAKE_START) tabnode_tls_handshake(c, 0);
  if ((where & SSL_CB_HANDSHAKE_DONE) && !SSL_renegotiate_pending(ssl)) tabnode_tls_handshake(c, 1);
}

// KeylogCallback, crypto_tls.cc:143-158 (the binding appends the newline).
static void KeylogCallback(const SSL* s, const char* line) {
  tabnode_tls_keylog(SSL_get_app_data(s), line, static_cast<uint32_t>(strlen(line)));
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
  tabnode_tls_new_session(w, id, id_length, der.data(), static_cast<uint32_t>(der.size()));
  return 0;
}

// SSLCertCallback, crypto_tls.cc:210-247: the binding keeps the "waiting" and "running" state (EnableCertCb) and
// answers 1 to continue or -1 to suspend the handshake (SSL_ERROR_WANT_X509_LOOKUP).
static int SSLCertCallback(SSL* s, void* arg) {
  TnSsl* w = static_cast<TnSsl*>(SSL_get_app_data(s));
  if (!w->is_server) return 1;
  const char* servername = SSL_get_servername(s, TLSEXT_NAMETYPE_host_name);
  return tabnode_tls_cert(w, servername ? servername : "", servername ? static_cast<uint32_t>(strlen(servername)) : 0,
                          SSL_get_tlsext_status_type(s) == TLSEXT_STATUSTYPE_ocsp);
}

// SelectALPNCallback, crypto_tls.cc:249-302.
static int SelectALPNCallback(SSL* s, const unsigned char** out, unsigned char* outlen, const unsigned char* in,
                              unsigned int inlen, void* arg) {
  TnSsl* w = static_cast<TnSsl*>(SSL_get_app_data(s));
  if (w->alpn_callback_enabled) {
    int offset = tabnode_tls_alpn(w, in, inlen);
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
CRYPTO_EXPORT(tabnode_ssl_new) TnSsl* tabnode_ssl_new(TnContext* sc, int is_server) {
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
CRYPTO_EXPORT(tabnode_ssl_free) void tabnode_ssl_free(TnSsl* w) {
  if (w == nullptr) return;
  SSL_free(w->ssl);  // frees both BIOs
  delete w;
}

// The underlying stream's read, written into enc_in (TLSWrap::OnStreamRead, crypto_tls.cc:1157-1201).
CRYPTO_EXPORT(tabnode_ssl_enc_in) int tabnode_ssl_enc_in(TnSsl* w, const void* data, size_t length) {
  return BIO_write(w->enc_in, data, static_cast<int>(length));
}

// EncOut's view of enc_out (crypto_tls.cc:641-735): the pending bytes, peeked; the binding writes them to the
// underlying stream and commits them once the write completes (OnStreamAfterWrite, 737-784).
CRYPTO_EXPORT(tabnode_ssl_enc_out_pending) size_t tabnode_ssl_enc_out_pending(TnSsl* w) { return BIO_pending(w->enc_out); }
CRYPTO_EXPORT(tabnode_ssl_enc_out_peek) const char* tabnode_ssl_enc_out_peek(TnSsl* w) {
  char* data = nullptr;
  BIO_get_mem_data(w->enc_out, &data);
  return data;
}
CRYPTO_EXPORT(tabnode_ssl_enc_out_commit) void tabnode_ssl_enc_out_commit(TnSsl* w, size_t length) {
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
CRYPTO_EXPORT(tabnode_ssl_read) int tabnode_ssl_read(TnSsl* w, void* out, size_t length) {
  return SSL_read(w->ssl, out, static_cast<int>(length));
}
CRYPTO_EXPORT(tabnode_ssl_write) int tabnode_ssl_write(TnSsl* w, const void* data, size_t length) {
  return SSL_write(w->ssl, data, static_cast<int>(length));
}
CRYPTO_EXPORT(tabnode_ssl_get_error) int tabnode_ssl_get_error(TnSsl* w, int ret) { return SSL_get_error(w->ssl, ret); }
CRYPTO_EXPORT(tabnode_ssl_shutdown) int tabnode_ssl_shutdown(TnSsl* w) { return SSL_shutdown(w->ssl); }

// TLSWrap::SetVerifyMode, crypto_tls.cc:1219-1249.
CRYPTO_EXPORT(tabnode_ssl_set_verify_mode) void tabnode_ssl_set_verify_mode(TnSsl* w, int request_cert, int reject_unauthorized) {
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
CRYPTO_EXPORT(tabnode_ssl_enable_session_callbacks) void tabnode_ssl_enable_session_callbacks(TnSsl* w) {
  w->session_callbacks = true;
  SSL_CTX_sess_set_new_cb(w->sc->ctx, NewSessionCallback);
}
CRYPTO_EXPORT(tabnode_ssl_enable_keylog) void tabnode_ssl_enable_keylog(TnSsl* w) {
  SSL_CTX_set_keylog_callback(w->sc->ctx, KeylogCallback);
}
CRYPTO_EXPORT(tabnode_ssl_enable_alpn_cb) void tabnode_ssl_enable_alpn_cb(TnSsl* w) {
  w->alpn_callback_enabled = true;
  SSL_CTX_set_alpn_select_cb(SSL_get_SSL_CTX(w->ssl), SelectALPNCallback, nullptr);
}

// TLSWrap::GetServername/SetServername, crypto_tls.cc:1363-1392.
CRYPTO_EXPORT(tabnode_ssl_get_servername) const char* tabnode_ssl_get_servername(TnSsl* w) {
  return SSL_get_servername(w->ssl, TLSEXT_NAMETYPE_host_name);
}
CRYPTO_EXPORT(tabnode_ssl_set_servername) void tabnode_ssl_set_servername(TnSsl* w, const char* name) {
  SSL_set_tlsext_host_name(w->ssl, name);
}

// TLSWrap::SetALPNProtocols, crypto_tls.cc:1659-1676.
CRYPTO_EXPORT(tabnode_ssl_set_alpn_protocols) void tabnode_ssl_set_alpn_protocols(TnSsl* w, const unsigned char* protos,
                                                                  size_t length) {
  if (!w->is_server) {
    if (SSL_set_alpn_protos(w->ssl, protos, static_cast<unsigned int>(length)) != 0) abort();
  } else {
    w->alpn_protos.assign(protos, protos + length);
    SSL_CTX_set_alpn_select_cb(SSL_get_SSL_CTX(w->ssl), SelectALPNCallback, nullptr);
  }
}

// TLSWrap::GetALPNNegotiatedProto, crypto_tls.cc:2122-2146: the length; the bytes at *out.
CRYPTO_EXPORT(tabnode_ssl_get_alpn_selected) size_t tabnode_ssl_get_alpn_selected(TnSsl* w, const unsigned char** out) {
  unsigned int length = 0;
  SSL_get0_alpn_selected(w->ssl, out, &length);
  return length;
}

// TLSWrap::GetProtocol, crypto_tls.cc:2115-2120; GetCipherInfo (crypto_common.cc): name, standardName, version.
CRYPTO_EXPORT(tabnode_ssl_get_version) const char* tabnode_ssl_get_version(TnSsl* w) { return SSL_get_version(w->ssl); }
CRYPTO_EXPORT(tabnode_ssl_cipher_name) const char* tabnode_ssl_cipher_name(TnSsl* w) {
  const SSL_CIPHER* c = SSL_get_current_cipher(w->ssl);
  return c ? SSL_CIPHER_get_name(c) : nullptr;
}
CRYPTO_EXPORT(tabnode_ssl_cipher_standard_name) const char* tabnode_ssl_cipher_standard_name(TnSsl* w) {
  const SSL_CIPHER* c = SSL_get_current_cipher(w->ssl);
  return c ? SSL_CIPHER_standard_name(c) : nullptr;
}
CRYPTO_EXPORT(tabnode_ssl_cipher_version) const char* tabnode_ssl_cipher_version(TnSsl* w) {
  const SSL_CIPHER* c = SSL_get_current_cipher(w->ssl);
  return c ? SSL_CIPHER_get_version(c) : nullptr;
}

// TLSWrap::GetSession, crypto_tls.cc:1810-1834: i2d of the session, malloc'd; answers its length (0: none).
CRYPTO_EXPORT(tabnode_ssl_get_session) size_t tabnode_ssl_get_session(TnSsl* w, unsigned char** out) {
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
CRYPTO_EXPORT(tabnode_ssl_set_session) int tabnode_ssl_set_session(TnSsl* w, const unsigned char* der, size_t length) {
  const unsigned char* p = der;
  SSL_SESSION* sess = d2i_SSL_SESSION(nullptr, &p, static_cast<long>(length));
  if (sess == nullptr) return 0;
  int ok = SSL_set_session(w->ssl, sess);
  SSL_SESSION_free(sess);
  return ok == 1 ? 1 : -1;
}
CRYPTO_EXPORT(tabnode_ssl_session_reused) int tabnode_ssl_session_reused(TnSsl* w) { return SSL_session_reused(w->ssl); }

// TLSWrap::VerifyError, crypto_tls.cc:1862-1891: the verify result (UNABLE_TO_GET_ISSUER_CERT with no peer
// certificate), its code name and its reason.
CRYPTO_EXPORT(tabnode_ssl_verify_result) int32_t tabnode_ssl_verify_result(TnSsl* w) {
  ncrypto::SSLPointer view(w->ssl);
  auto result = view.verifyPeerCertificate();
  view.release();
  return static_cast<int32_t>(result.value_or(X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT));
}
CRYPTO_EXPORT(tabnode_x509_error_code) const char* tabnode_x509_error_code(int32_t err) { return ncrypto::X509Pointer::ErrorCode(err); }
CRYPTO_EXPORT(tabnode_x509_error_reason) const char* tabnode_x509_error_reason(int32_t err) {
  auto reason = ncrypto::X509Pointer::ErrorReason(err);
  return reason.has_value() ? reason.value() : X509_verify_cert_error_string(err);
}

// The peer's and the own certificate, as DER (malloc'd), for the binding's certificate objects
// (TLSWrap::GetPeerCertificate 1705-1719, GetCertificate 1735-1743). index 0 is the leaf; a peer chain's further
// entries follow (SSL_get_peer_cert_chain), as Node's GetPeerCert walks them.
CRYPTO_EXPORT(tabnode_ssl_peer_certificate) size_t tabnode_ssl_peer_certificate(TnSsl* w, unsigned char** out) {
  X509* cert = SSL_get1_peer_certificate(w->ssl);
  size_t length = ToDer(cert, out);
  X509_free(cert);
  return length;
}
CRYPTO_EXPORT(tabnode_ssl_peer_chain_length) int tabnode_ssl_peer_chain_length(TnSsl* w) {
  STACK_OF(X509)* chain = SSL_get_peer_cert_chain(w->ssl);
  return chain ? sk_X509_num(chain) : 0;
}
CRYPTO_EXPORT(tabnode_ssl_peer_chain_certificate) size_t tabnode_ssl_peer_chain_certificate(TnSsl* w, int index, unsigned char** out) {
  STACK_OF(X509)* chain = SSL_get_peer_cert_chain(w->ssl);
  return ToDer(chain ? sk_X509_value(chain, index) : nullptr, out);
}
CRYPTO_EXPORT(tabnode_ssl_certificate) size_t tabnode_ssl_certificate(TnSsl* w, unsigned char** out) {
  return ToDer(SSL_get_certificate(w->ssl), out);
}

// TLSWrap::GetFinished/GetPeerFinished, crypto_tls.cc:1754-1808: the length (0: none) into out (128 bytes is
// more than either message's length; Node sizes by a first call).
CRYPTO_EXPORT(tabnode_ssl_finished) size_t tabnode_ssl_finished(TnSsl* w, void* out, size_t length) {
  return SSL_get_finished(w->ssl, out, length);
}
CRYPTO_EXPORT(tabnode_ssl_peer_finished) size_t tabnode_ssl_peer_finished(TnSsl* w, void* out, size_t length) {
  return SSL_get_peer_finished(w->ssl, out, length);
}

// TLSWrap::ExportKeyingMaterial, crypto_tls.cc:1996-2034.
CRYPTO_EXPORT(tabnode_ssl_export_keying_material) int tabnode_ssl_export_keying_material(TnSsl* w, unsigned char* out, size_t olen,
                                                                       const char* label, size_t llen,
                                                                       const unsigned char* context, size_t clen,
                                                                       int use_context) {
  return SSL_export_keying_material(w->ssl, out, olen, label, llen, context, clen, use_context);
}

// TLSWrap::Renegotiate, crypto_tls.cc:2042-2048; GetTLSTicket 2050-2068; SetMaxSendFragment 2172-2183;
// IsSessionReused above; GetEphemeralKeyInfo's key (crypto_common.cc GetEphemeralKey).
CRYPTO_EXPORT(tabnode_ssl_renegotiate) int tabnode_ssl_renegotiate(TnSsl* w) { return SSL_renegotiate(w->ssl); }
CRYPTO_EXPORT(tabnode_ssl_tls_ticket) size_t tabnode_ssl_tls_ticket(TnSsl* w, const unsigned char** out) {
  SSL_SESSION* sess = SSL_get_session(w->ssl);
  *out = nullptr;
  if (sess == nullptr) return 0;
  size_t length = 0;
  SSL_SESSION_get0_ticket(sess, out, &length);
  return length;
}
CRYPTO_EXPORT(tabnode_ssl_set_max_send_fragment) int tabnode_ssl_set_max_send_fragment(TnSsl* w, int32_t size) {
  return SSL_set_max_send_fragment(w->ssl, size);
}
// The peer's ephemeral key: its type (EVP_PKEY_id), its bits, and for an EC key its curve's short name.
CRYPTO_EXPORT(tabnode_ssl_ephemeral_key) int tabnode_ssl_ephemeral_key(TnSsl* w, int* bits, const char** curve) {
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
CRYPTO_EXPORT(tabnode_ssl_negotiated_group) const char* tabnode_ssl_negotiated_group(TnSsl* w) {
  int nid = SSL_get_negotiated_group(w->ssl);
  return nid == NID_undef ? nullptr : SSL_group_to_name(w->ssl, nid);
}

// X509Pointer::IssuerFrom (ncrypto.cc:1669-1686), as GetLastIssuedCert (crypto_common.cc:139-171) walks the
// context's store: the issuer of `x`, a new reference the binding frees, or null.
CRYPTO_EXPORT(tabnode_ssl_issuer_from_store) X509* tabnode_ssl_issuer_from_store(TnSsl* w, X509* x) {
  return ncrypto::X509Pointer::IssuerFrom(SSL_get_SSL_CTX(w->ssl), ncrypto::X509View(x)).release();
}

// The context switch CertCbDone (crypto_tls.cc:1595-1657) and SetKeyCert (1678-1703) both make:
// SSLPointer::setSniContext (ncrypto.cc:4226-4243), then TLSWrap::SetCACerts (crypto_tls.cc:1429-1443). Answers 1;
// 2 where setSniContext failed (CertCbDone goes on without the switch, SetKeyCert throws); 0 where SetCACerts failed
// (both throw the queue's error).
CRYPTO_EXPORT(tabnode_ssl_use_context) int tabnode_ssl_use_context(TnSsl* w, TnContext* sc) {
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

