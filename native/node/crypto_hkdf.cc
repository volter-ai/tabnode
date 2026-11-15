// HKDF OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_hkdf.cc, over ncrypto and OpenSSL in libnode.so: HKDFJob. The engine device answers an HKDF over a
// digest WebCrypto defines (the binding's routing, src/node-lib/binding/crypto_kdf.ts); this is the rest.
#include "crypto_util.h"

using ncrypto::Digest;

namespace {
struct HKDFConfig {
  size_t length;
  // Node's config keeps a Digest, which cannot move; its EVP_MD is the same.
  const EVP_MD* digest;
  KeyObjectData key;
  ByteSource key_data;
  ByteSource salt;
  ByteSource info;
};
// HKDFTraits::DeriveBits (103-131).
bool DeriveHKDF(const HKDFConfig& params, ByteSource* out, CryptoJobMode mode) {
  const ncrypto::Buffer<const unsigned char> key_data{
      .data = params.key ? reinterpret_cast<const unsigned char*>(params.key.GetSymmetricKey())
                         : params.key_data.data<unsigned char>(),
      .len = params.key ? params.key.GetSymmetricKeySize() : params.key_data.size(),
  };
  auto dp = ncrypto::hkdf(Digest(params.digest), key_data,
                          ncrypto::Buffer<const unsigned char>{.data = params.info.data<unsigned char>(),
                                                               .len = params.info.size()},
                          ncrypto::Buffer<const unsigned char>{.data = params.salt.data<unsigned char>(),
                                                               .len = params.salt.size()},
                          params.length);
  if (!dp) return false;
  *out = ByteSource::Allocated(dp.release());
  return true;
}
}  // namespace

// HKDFTraits::AdditionalConfig (45-101): `key` the key's handle data, else its bytes; null where it threw.
CRYPTO_EXPORT(tabnode_hkdf_job_new) CryptoJob* tabnode_hkdf_job_new(int32_t mode, const char* hash,
                                                                   const KeyObjectData* key, const void* key_bytes,
                                                                   size_t key_size, const void* salt,
                                                                   size_t salt_size, const void* info,
                                                                   size_t info_size, uint32_t length) {
  HKDFConfig params;
  params.digest = Digest::FromName(hash).get();
  if (params.digest == nullptr) {
    Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", hash);
    return nullptr;
  }
  if (key != nullptr) {
    params.key = key->addRef();
  } else {
    if (key_size > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "key is too big");
      return nullptr;
    }
    params.key_data = ByteSource::CopyOf(key_bytes, key_size);
  }
  if (salt_size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "salt is too big");
    return nullptr;
  }
  if (info_size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "info is too big");
    return nullptr;
  }
  params.salt = ByteSource::CopyOf(salt, salt_size);
  params.info = ByteSource::CopyOf(info, info_size);
  params.length = length;
  if (!ncrypto::checkHkdfLength(Digest(params.digest), params.length)) {
    Throw("ERR_CRYPTO_INVALID_KEYLEN");
    return nullptr;
  }
  return new DeriveBitsJob<HKDFConfig>(JobMode(mode), std::move(params), DeriveHKDF);
}
