// SCRYPT OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_scrypt.cc, over ncrypto and OpenSSL in the program: ScryptJob, OpenSSL's (WebCrypto has no scrypt).
#include <openssl/err.h>

#include "crypto_util.h"

#ifndef OPENSSL_NO_SCRYPT
namespace {
struct ScryptConfig {
  ByteSource pass;
  ByteSource salt;
  uint32_t N;
  uint32_t r;
  uint32_t p;
  uint64_t maxmem;
  int32_t length;
};
// ScryptTraits::DeriveBits (113-140).
bool DeriveScrypt(const ScryptConfig& params, ByteSource* out, CryptoJobMode mode) {
  if (params.length == 0) {
    *out = ByteSource();
    return true;
  }
  auto dp = ncrypto::scrypt(ncrypto::Buffer<const char>{.data = params.pass.data<char>(), .len = params.pass.size()},
                            ncrypto::Buffer<const unsigned char>{.data = params.salt.data<unsigned char>(),
                                                                 .len = params.salt.size()},
                            params.N, params.r, params.p, params.maxmem, params.length);
  if (!dp) return false;
  *out = ByteSource::Allocated(dp.release());
  return true;
}
}  // namespace

// ScryptTraits::AdditionalConfig (55-111): `maxmem` is IntegerValue of a number; null where it threw.
CRYPTO_EXPORT(tabnode_scrypt_job_new) CryptoJob* tabnode_scrypt_job_new(int32_t mode, const void* pass,
                                                                       size_t pass_size, const void* salt,
                                                                       size_t salt_size, uint32_t N, uint32_t r,
                                                                       uint32_t p, double maxmem, int32_t length) {
  if (pass_size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "pass is too large");
    return nullptr;
  }
  if (salt_size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "salt is too large");
    return nullptr;
  }
  ScryptConfig params;
  params.pass = ByteSource::CopyOf(pass, pass_size);
  params.salt = ByteSource::CopyOf(salt, salt_size);
  params.N = N;
  params.r = r;
  params.p = p;
  params.maxmem = static_cast<uint64_t>(static_cast<int64_t>(maxmem));
  params.length = length;
  if (params.length < 0) abort();
  if (!ncrypto::checkScryptParams(params.N, params.r, params.p, params.maxmem)) {
    uint32_t err = ERR_peek_last_error();
    if (err != 0) {
      char buf[256];
      ERR_error_string_n(err, buf, sizeof(buf));
      Throw("ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "Invalid scrypt params: %s", buf);
    } else {
      Throw("ERR_CRYPTO_INVALID_SCRYPT_PARAMS");
    }
    return nullptr;
  }
  return new DeriveBitsJob<ScryptConfig>(JobMode(mode), std::move(params), DeriveScrypt);
}
#endif  // !OPENSSL_NO_SCRYPT
