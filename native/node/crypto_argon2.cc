// ARGON2 OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_argon2.cc, over ncrypto and OpenSSL 3.5 in the program: Argon2Job. WebCrypto's standard defines no
// Argon2, so it is OpenSSL's.
#include "crypto_util.h"

#define CHECK(condition) \
  if (!(condition)) abort()

#if OPENSSL_WITH_ARGON2
namespace {
// Argon2Config (crypto_argon2.h:24-46).
struct Argon2Config {
  KeyObjectData key;
  ByteSource pass;
  ByteSource salt;
  ByteSource secret;
  ByteSource ad;
  ncrypto::Argon2Type type;
  uint32_t iter;
  uint32_t lanes;
  uint32_t memcost;
  uint32_t version = 0x13;
  uint32_t keylen;
};

// Argon2Traits::DeriveBits.
bool DeriveArgon2(const Argon2Config& config, ByteSource* out, CryptoJobMode mode) {
  if (config.keylen == 0) {
    *out = ByteSource();
    return true;
  }
  const ncrypto::Buffer<const char> pass{
      .data = config.key ? config.key.GetSymmetricKey() : config.pass.data<const char>(),
      .len = config.key ? config.key.GetSymmetricKeySize() : config.pass.size(),
  };
  auto dp = ncrypto::argon2(pass, config.salt, config.lanes, config.keylen, config.memcost, config.iter,
                            config.version, config.secret, config.ad, config.type);
  if (!dp) return false;
  *out = ByteSource::Allocated(dp.release());
  return true;
}
}  // namespace

// Argon2Traits::AdditionalConfig: `args` Node's from its second (the pass as a handle or bytes, the salt, the lanes,
// the key's length, the memory cost, the iterations, the secret, the associated data, the type). Null where it threw.
CRYPTO_EXPORT(tabnode_argon2_job_new) CryptoJob* tabnode_argon2_job_new(int32_t mode, const TnValue* args,
                                                                       uint32_t count) {
  Argon2Config config;
  CHECK(args[0].IsKey() || args[0].IsAnyBufferSource());
  if (args[0].IsKey()) {
    config.key = args[0].Key().addRef();
  } else {
    if (args[0].length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "pass is too large");
      return nullptr;
    }
    config.pass = args[0].Bytes();
  }
  if (args[1].length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "salt is too large");
    return nullptr;
  }
  if (args[6].length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "secret is too large");
    return nullptr;
  }
  if (args[7].length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "ad is too large");
    return nullptr;
  }
  config.salt = args[1].Bytes();
  config.secret = args[6].Bytes();
  config.ad = args[7].Bytes();
  CHECK(args[2].IsUint32() && args[3].IsUint32() && args[4].IsUint32() && args[5].IsUint32() && args[8].IsUint32());
  config.lanes = args[2].Uint32();
  config.keylen = args[3].Uint32();
  config.memcost = args[4].Uint32();
  config.iter = args[5].Uint32();
  config.type = static_cast<ncrypto::Argon2Type>(args[8].Uint32());
  return new DeriveBitsJob<Argon2Config>(JobMode(mode), std::move(config), DeriveArgon2);
}

// kTypeArgon2d, kTypeArgon2i, kTypeArgon2id (Argon2::Initialize), as the binding defines them.
CRYPTO_EXPORT(tabnode_argon2_type) int tabnode_argon2_type(int which) {
  switch (which) {
    case 0:
      return static_cast<int>(ncrypto::Argon2Type::ARGON2D);
    case 1:
      return static_cast<int>(ncrypto::Argon2Type::ARGON2I);
    default:
      return static_cast<int>(ncrypto::Argon2Type::ARGON2ID);
  }
}
#endif
