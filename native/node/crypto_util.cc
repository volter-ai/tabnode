// THE crypto BINDING'S UTILITIES (Tabnode ADR-0018 item 7, ADR-0016 §3): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_util.cc and of the process's OpenSSL start in src/node.cc, over ncrypto and OpenSSL in libnode.so.
// The error queue as the binding reads it into Node's error shape (ThrowCryptoError), the process's OpenSSL
// configuration and InitCryptoOnce, and the version string process.versions reads.
#include <openssl/conf.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/provider.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "crypto_util.h"

char* Copy(const char* text, size_t size, size_t* length) {
  char* out = static_cast<char*>(malloc(size + 1));
  if (out == nullptr) return nullptr;
  memcpy(out, text, size);
  out[size] = 0;
  *length = size;
  return out;
}

char* CopyBio(const ncrypto::BIOPointer& bio, size_t* length) {
  if (!bio) return nullptr;
  BUF_MEM* mem = bio;
  return Copy(mem->data, mem->length, length);
}

size_t ToDer(X509* cert, unsigned char** out) {
  *out = nullptr;
  if (cert == nullptr) return 0;
  int length = i2d_X509(cert, out);
  return length > 0 ? static_cast<size_t>(length) : 0;
}

// ---- The error queue -------------------------------------------------------------------------------------------

CRYPTO_EXPORT(tabnode_err_get) uint32_t tabnode_err_get() { return static_cast<uint32_t>(ERR_get_error()); }
CRYPTO_EXPORT(tabnode_err_peek) uint32_t tabnode_err_peek() { return static_cast<uint32_t>(ERR_peek_error()); }
CRYPTO_EXPORT(tabnode_err_clear) void tabnode_err_clear() { ERR_clear_error(); }
CRYPTO_EXPORT(tabnode_err_set_mark) void tabnode_err_set_mark() { ERR_set_mark(); }
CRYPTO_EXPORT(tabnode_err_pop_to_mark) void tabnode_err_pop_to_mark() { ERR_pop_to_mark(); }
CRYPTO_EXPORT(tabnode_err_lib) int tabnode_err_lib(uint32_t code) { return ERR_GET_LIB(code); }
CRYPTO_EXPORT(tabnode_err_lib_string) const char* tabnode_err_lib_string(uint32_t code) {
  return ERR_lib_error_string(code);
}
CRYPTO_EXPORT(tabnode_err_reason_string) const char* tabnode_err_reason_string(uint32_t code) {
  return ERR_reason_error_string(code);
}
// ThrowCryptoError's message (crypto_util.cc:653-677): ERR_error_string_n of the code.
CRYPTO_EXPORT(tabnode_err_string) void tabnode_err_string(uint32_t code, char* buffer, size_t length) {
  ERR_error_string_n(code, buffer, length);
}
// SetSessionIdContext's message (crypto_context.cc:2140-2150): ERR_print_errors into a memory BIO. Answers a malloc'd
// NUL-terminated string the caller frees.
CRYPTO_EXPORT(tabnode_err_print) char* tabnode_err_print() {
  BIO* bio = BIO_new(BIO_s_mem());
  if (bio == nullptr) return nullptr;
  ERR_print_errors(bio);
  char* data;
  long length = BIO_get_mem_data(bio, &data);
  size_t ignored;
  char* out = Copy(data, static_cast<size_t>(length), &ignored);
  BIO_free(bio);
  return out;
}
// GetBIOError (crypto_tls.cc:397-406): the last line ERR_print_errors_cb gives, malloc'd (the queue is consumed as
// Node's is), its length in *length.
CRYPTO_EXPORT(tabnode_err_bio_error) char* tabnode_err_bio_error(size_t* length) {
  std::string ret;
  ERR_print_errors_cb(
      [](const char* str, size_t len, void* opaque) {
        static_cast<std::string*>(opaque)->assign(str, len);
        return 0;
      },
      static_cast<void*>(&ret));
  return Copy(ret.data(), ret.size(), length);
}

// ---- The process's OpenSSL ---------------------------------------------------------------------------------------

// The process's OpenSSL start (src/node.cc:1183-1266, InitializeOncePerProcess) and InitCryptoOnce
// (crypto_util.cc:149-205), once. `conf_file` is --openssl-config's file, else OPENSSL_CONF's, else null (the default
// openssl.cnf in OPENSSLDIR, /etc/ssl, read through the process's kernel); `shared_config` is --openssl-shared-config,
// which reads the file's `openssl_conf` section instead of Node's `nodejs_conf` (NODE_OPENSSL_CONF_NAME, configure.py's
// default); `legacy_provider` is --openssl-legacy-provider; `secure_heap` and `secure_heap_min` are --secure-heap and
// --secure-heap-min (0: none). Answers 0, or the exit code Node's start returns for an OpenSSL configuration error
// (ERR_GET_REASON of the queue's head), with the queue left for the binding's message ("OpenSSL configuration error:"
// and GetOpenSSLErrorString, tabnode_err_print). Where Node runs this before the environment, the engine runs it at its
// crypto binding's first use, once the process's options are parsed: no OpenSSL call comes before it. Answers what the
// first call answered on every later call. A secure heap's failure is written to stderr, as Node writes it.
CRYPTO_EXPORT(tabnode_crypto_init) int tabnode_crypto_init(const char* conf_file, int shared_config,
                                                           int legacy_provider, size_t secure_heap,
                                                           size_t secure_heap_min) {
  static bool done = false;
  static int status = 0;
  if (done) return status;
  done = true;
  OPENSSL_INIT_SETTINGS* settings = OPENSSL_INIT_new();
  OPENSSL_INIT_set_config_filename(settings, conf_file);
  OPENSSL_INIT_set_config_appname(settings, shared_config ? "openssl_conf" : "nodejs_conf");
  OPENSSL_INIT_set_config_file_flags(settings, CONF_MFLAGS_IGNORE_MISSING_FILE);
  OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, settings);
  OPENSSL_INIT_free(settings);
  if (ERR_peek_error() != 0) return status = ERR_GET_REASON(ERR_peek_error());
  // Ensure CSPRNG is properly seeded (node.cc:1265-1266).
  if (!ncrypto::CSPRNG(nullptr, 0)) abort();
  // InitCryptoOnce.
  if (legacy_provider) {
    OSSL_PROVIDER* legacy = OSSL_PROVIDER_load(nullptr, "legacy");
    if (legacy == nullptr) fprintf(stderr, "Unable to load legacy provider.\n");
  }
  OPENSSL_init_ssl(0, nullptr);
  if (secure_heap != 0) {
    switch (ncrypto::DataPointer::TryInitSecureHeap(secure_heap, secure_heap_min)) {
      case ncrypto::DataPointer::InitSecureHeapResult::FAILED:
        fprintf(stderr, "Unable to initialize openssl secure heap.\n");
        break;
      case ncrypto::DataPointer::InitSecureHeapResult::UNABLE_TO_MEMORY_MAP:
        fprintf(stderr, "Unable to memory map openssl secure heap.\n");
        break;
      case ncrypto::DataPointer::InitSecureHeapResult::OK:
        break;
    }
  }
  // Turn off compression. Saves memory and protects against CRIME attacks.
  sk_SSL_COMP_zero(SSL_COMP_get_compression_methods());
#ifndef OPENSSL_NO_ENGINE
  ncrypto::EnginePointer::initEnginesOnce();
#endif
  return status;
}

// OpenSSL_version(OPENSSL_VERSION), from which process.versions.openssl is GetOpenSSLVersion's (node_metadata.cc:57-78).
CRYPTO_EXPORT(tabnode_openssl_version) const char* tabnode_openssl_version() {
  return OpenSSL_version(OPENSSL_VERSION);
}
