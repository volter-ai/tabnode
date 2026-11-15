// What the crypto binding's glue shares (Tabnode ADR-0018 §1, item 7; ADR-0016 §3), as Node v24.21.0's
// src/crypto/crypto_util.h declares it for src/crypto/*.cc: the OpenSSL half of Node's crypto_*.cc, over ncrypto and
// OpenSSL in libnode.so, with the V8 half (argument unwrapping, result objects, MakeCallback) removed. That half is the
// engine's TypeScript (src/node-lib/binding/openssl.ts and the bindings over it), which calls these files' exports
// through the program and reads their answers in the process's memory. Every function names the lines it carries.
// Nothing here is a policy of the engine's own: where a body differs from Node's, the difference is said at the site.
#ifndef TABNODE_CRYPTO_UTIL_H
#define TABNODE_CRYPTO_UTIL_H

#include <openssl/bio.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "engine.h"
#include "ncrypto.h"

#define CRYPTO_EXPORT(name) extern "C" __attribute__((export_name(#name)))

// SecureContext (crypto_context.cc): its SSL_CTX and what Node's object keeps beside it.
struct TnContext {
  SSL_CTX* ctx = nullptr;
  X509_STORE* own_cert_store = nullptr;
  unsigned char ticket_key_name[16];
  unsigned char ticket_key_hmac[16];
  unsigned char ticket_key_aes[16];
};

// TLSWrap (crypto_tls.cc): its SSL, its two memory BIOs and the state Node's wrap keeps in C++. Its address names the
// connection in every call of the engine's and every callback into it (engine.h tls_*), as Node's SSL app data names
// its wrap.
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

// The process's root store (crypto_context.cc GetOrCreateRootCertStore); null until its first ask.
X509_STORE* RootStore();
extern X509_STORE* root_store;

// The TnContext an SSL_CTX belongs to (its ex_data).
TnContext* ContextOf(const SSL_CTX* ctx);

// A malloc'd copy of `text`, NUL-terminated, its length in *length; null where memory is out.
char* Copy(const char* text, size_t size, size_t* length);
// A memory BIO's bytes, copied as Copy copies; null for an empty pointer ("undefined" in Node's object).
char* CopyBio(const ncrypto::BIOPointer& bio, size_t* length);
// A certificate's DER (i2d_X509, malloc'd by OpenSSL) at *out; answers its length, 0 for none.
size_t ToDer(X509* cert, unsigned char** out);

#endif
