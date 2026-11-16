// THE HMACS OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_hmac.cc, over ncrypto and OpenSSL in the program: Hmac and HmacJob. Which HMAC calls OpenSSL
// answers and which the engine device answers is the binding's routing (src/node-lib/binding/crypto_hmac.ts).
#include <openssl/err.h>

#include "crypto_util.h"

using ncrypto::Digest;
using ncrypto::HMACCtxPointer;

// Hmac (crypto_hmac.h): its context.
struct TnHmac {
  HMACCtxPointer ctx;
};

CRYPTO_EXPORT(tabnode_hmac_new) TnHmac* tabnode_hmac_new() { return new TnHmac(); }
CRYPTO_EXPORT(tabnode_hmac_free) void tabnode_hmac_free(TnHmac* hmac) { delete hmac; }

// Hmac::HmacInit (66-96): `key` is ByteSource::FromSecretKeyBytes's bytes; 0 where it threw.
CRYPTO_EXPORT(tabnode_hmac_init) int tabnode_hmac_init(TnHmac* hmac, const char* hash_type, const char* key,
                                                      int key_len) {
  Digest md = Digest::FromName(hash_type);
  if (!md) {
    Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", hash_type);
    return 0;
  }
  if (key_len == 0) key = "";
  hmac->ctx = HMACCtxPointer::New();
  ncrypto::Buffer<const void> key_buf{.data = key, .len = static_cast<size_t>(key_len)};
  if (!hmac->ctx.init(key_buf, md)) {
    hmac->ctx.reset();
    ThrowCrypto(ERR_get_error());
    return 0;
  }
  return 1;
}

// Hmac::HmacUpdate (98-118): 1 or 0, -1 where it threw.
CRYPTO_EXPORT(tabnode_hmac_update) int tabnode_hmac_update(TnHmac* hmac, const char* data, size_t size) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too long");
    return -1;
  }
  return hmac->ctx.update(ncrypto::Buffer<const void>{.data = data, .len = size}) ? 1 : 0;
}

// Hmac::HmacDigest (120-150): the digest's bytes (none once finalized), null where it threw.
CRYPTO_EXPORT(tabnode_hmac_digest) char* tabnode_hmac_digest(TnHmac* hmac, size_t* length) {
  unsigned char md_value[Digest::MAX_SIZE];
  ncrypto::Buffer<void> buf{.data = md_value, .len = sizeof(md_value)};
  if (hmac->ctx) {
    if (!hmac->ctx.digestInto(&buf)) {
      hmac->ctx.reset();
      ThrowCrypto(ERR_get_error(), "Failed to finalize HMAC");
      return nullptr;
    }
    hmac->ctx.reset();
  } else {
    buf.len = 0;
  }
  return Copy(reinterpret_cast<const char*>(md_value), buf.len, length);
}

// HmacJob (HmacTraits, 152-257).
namespace {
struct HmacConfig {
  int mode;  // SignConfiguration::Mode: 0 sign, 1 verify
  KeyObjectData key;
  ByteSource data;
  ByteSource signature;
  // Node's config keeps a Digest, which cannot move; its EVP_MD is the same.
  const EVP_MD* digest;
};
bool DeriveHmac(const HmacConfig& params, ByteSource* out, CryptoJobMode mode) {
  auto ctx = HMACCtxPointer::New();
  ncrypto::Buffer<const void> key_buf{.data = params.key.GetSymmetricKey(), .len = params.key.GetSymmetricKeySize()};
  if (!ctx.init(key_buf, params.digest)) return false;
  if (!ctx.update(ncrypto::Buffer<const void>{.data = params.data.data(), .len = params.data.size()})) return false;
  auto buf = ctx.digest();
  if (!buf) return false;
  *out = ByteSource::Allocated(buf.release());
  return true;
}
}  // namespace

// HmacTraits::AdditionalConfig (170-212): a null `signature` is undefined; null where it threw.
CRYPTO_EXPORT(tabnode_hmac_job_new) CryptoJob* tabnode_hmac_job_new(int32_t mode, uint32_t sign_mode,
                                                                   const char* digest, const KeyObjectData* key,
                                                                   const void* data, size_t size,
                                                                   const void* signature, size_t signature_size) {
  HmacConfig params;
  params.mode = static_cast<int>(sign_mode);
  params.digest = Digest::FromName(digest).get();
  if (params.digest == nullptr) {
    Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", digest);
    return nullptr;
  }
  params.key = key->addRef();
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too big");
    return nullptr;
  }
  params.data = ByteSource::CopyOf(data, size);
  if (signature != nullptr) {
    if (signature_size > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "signature is too big");
      return nullptr;
    }
    params.signature = ByteSource::CopyOf(signature, signature_size);
  }
  return new DeriveBitsJob<HmacConfig>(JobMode(mode), std::move(params), DeriveHmac);
}

// HmacTraits::EncodeOutput's verify branch (244-254): the signature's comparison, in constant time.
CRYPTO_EXPORT(tabnode_hmac_job_verified) int tabnode_hmac_job_verified(CryptoJob* job) {
  const auto* hmac = static_cast<DeriveBitsJob<HmacConfig>*>(job);
  const ByteSource& out = hmac->out;
  return out.size() > 0 && out.size() == hmac->params.signature.size() &&
                 CRYPTO_memcmp(out.data(), hmac->params.signature.data(), out.size()) == 0
             ? 1
             : 0;
}
