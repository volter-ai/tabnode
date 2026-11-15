// PBKDF2 OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_pbkdf2.cc, over ncrypto and OpenSSL in libnode.so: PBKDF2Job. The engine device answers a PBKDF2
// over a digest WebCrypto defines (the binding's routing, src/node-lib/binding/crypto_kdf.ts); this is the rest.
#include "crypto_util.h"

using ncrypto::Digest;

namespace {
struct PBKDF2Config {
  ByteSource pass;
  ByteSource salt;
  KeyObjectData key;
  int32_t iterations;
  int32_t length;
  // Node's config keeps a Digest, which cannot move; its EVP_MD is the same.
  const EVP_MD* digest;
};
// PBKDF2Traits::DeriveBits (99-121).
bool DerivePBKDF2(const PBKDF2Config& params, ByteSource* out, CryptoJobMode mode) {
  const ncrypto::Buffer<const char> pass{
      .data = params.key ? params.key.GetSymmetricKey() : params.pass.data<const char>(),
      .len = params.key ? params.key.GetSymmetricKeySize() : params.pass.size(),
  };
  auto dp = ncrypto::pbkdf2(Digest(params.digest), pass,
                            ncrypto::Buffer<const unsigned char>{.data = params.salt.data<unsigned char>(),
                                                                 .len = params.salt.size()},
                            params.iterations, params.length);
  if (!dp) return false;
  *out = ByteSource::Allocated(dp.release());
  return true;
}
}  // namespace

// PBKDF2Traits::AdditionalConfig (46-97): `key` the pass's handle data, else the pass's bytes; null where it threw.
CRYPTO_EXPORT(tabnode_pbkdf2_job_new) CryptoJob* tabnode_pbkdf2_job_new(int32_t mode, const KeyObjectData* key,
                                                                       const void* pass, size_t pass_size,
                                                                       const void* salt, size_t salt_size,
                                                                       int32_t iterations, int32_t length,
                                                                       const char* digest) {
  PBKDF2Config params;
  if (key != nullptr) {
    params.key = key->addRef();
  } else {
    if (pass_size > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "pass is too large");
      return nullptr;
    }
    params.pass = ByteSource::CopyOf(pass, pass_size);
  }
  if (salt_size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "salt is too large");
    return nullptr;
  }
  params.salt = ByteSource::CopyOf(salt, salt_size);
  params.iterations = iterations;
  if (params.iterations < 0) {
    Throw("ERR_OUT_OF_RANGE", "iterations must be <= %d", INT_MAX);
    return nullptr;
  }
  params.length = length;
  if (params.length < 0) {
    Throw("ERR_OUT_OF_RANGE", "length must be <= %d", INT_MAX);
    return nullptr;
  }
  params.digest = Digest::FromName(digest).get();
  if (params.digest == nullptr) {
    Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", digest);
    return nullptr;
  }
  return new DeriveBitsJob<PBKDF2Config>(JobMode(mode), std::move(params), DerivePBKDF2);
}
