// THE CIPHER LIST OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_cipher.cc that `tls` reaches, over OpenSSL in libnode.so.
#include "crypto_util.h"

// CipherBase::GetSSLCiphers (crypto_cipher.cc:166-188): the lower-cased names are the binding's.
static STACK_OF(SSL_CIPHER)* cipher_list = nullptr;
CRYPTO_EXPORT(tabnode_ssl_cipher_count) int tabnode_ssl_cipher_count() {
  if (cipher_list == nullptr) {
    SSL_CTX* ctx = SSL_CTX_new(TLS_method());
    SSL* ssl = SSL_new(ctx);
    cipher_list = sk_SSL_CIPHER_dup(SSL_get_ciphers(ssl));
    SSL_free(ssl);
    SSL_CTX_free(ctx);
  }
  return sk_SSL_CIPHER_num(cipher_list);
}
CRYPTO_EXPORT(tabnode_ssl_cipher_at) const char* tabnode_ssl_cipher_at(int index) {
  return SSL_CIPHER_get_name(sk_SSL_CIPHER_value(cipher_list, index));
}

