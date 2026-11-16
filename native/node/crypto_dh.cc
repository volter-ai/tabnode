// DIFFIE-HELLMAN OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_dh.cc, over ncrypto and OpenSSL in libnode.so: DiffieHellman and DiffieHellmanGroup,
// DhKeyPairGenJob's configuration and Setup, DHBitsJob (every key agreement of crypto.diffieHellman and WebCrypto's
// deriveBits: DH, ECDH, X25519, X448) and a key's details. A DH group is OpenSSL's; which agreements the engine device
// answers is the binding's routing (src/node-lib/binding/crypto_dh.ts).
#include <openssl/dh.h>
#include <openssl/err.h>

#include <string_view>
#include <variant>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::DataPointer;
using ncrypto::DHPointer;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;

#define CHECK(condition) \
  if (!(condition)) abort()

// DiffieHellman's C++ state (crypto_dh.h:17-40).
struct TnDH {
  DHPointer dh_;
};

namespace {
// PutDhError (crypto_dh.cc:94-102), OpenSSL 3's.
void PutDhError(int reason) { ERR_raise(ERR_LIB_DH, reason); }

TnDH* Made(DHPointer&& dh) {
  auto* made = new TnDH();
  made->dh_ = std::move(dh);
  return made;
}

// DataPointerToBuffer (crypto_dh.cc:58-92): the bytes, as the engine takes them.
char* Answer(DataPointer&& data, size_t* length) {
  return Copy(static_cast<const char*>(data.get()), data.size(), length);
}
}  // namespace

// DiffieHellmanGroup (crypto_dh.cc:114-127): null where it threw.
CRYPTO_EXPORT(tabnode_dh_group_new) TnDH* tabnode_dh_group_new(const char* name) {
  DHPointer dh = DHPointer::FromGroup(std::string_view(name));
  if (!dh) {
    Throw("ERR_CRYPTO_UNKNOWN_DH_GROUP");
    return nullptr;
  }
  return Made(std::move(dh));
}

// New (crypto_dh.cc:129-224): `args` Node's two (a prime length and a generator, or a prime's bytes and a generator
// as a number or bytes). Null where it threw.
CRYPTO_EXPORT(tabnode_dh_new) TnDH* tabnode_dh_new(const TnValue* args, uint32_t count) {
  if (count != 2) {
    Throw("ERR_MISSING_ARGS", "Constructor must have two arguments");
    return nullptr;
  }
  if (args[0].IsInt32()) {
    int32_t bits = args[0].Int32();
    if (bits < 2) {
      PutDhError(DH_R_MODULUS_TOO_SMALL);
      ThrowCrypto(ERR_get_error(), "Invalid prime length");
      return nullptr;
    }
    if (!args[1].IsInt32()) {
      Throw("ERR_INVALID_ARG_TYPE", "Second argument must be an int32");
      return nullptr;
    }
    int32_t generator = args[1].Int32();
    if (generator < 2) {
      PutDhError(DH_R_BAD_GENERATOR);
      ThrowCrypto(ERR_get_error(), "Invalid generator");
      return nullptr;
    }
    auto dh = DHPointer::New(bits, generator);
    if (!dh) {
      Throw("ERR_INVALID_ARG_VALUE", "Invalid DH parameters");
      return nullptr;
    }
    return Made(std::move(dh));
  }
  if (args[0].length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "prime is too big");
    return nullptr;
  }
  BignumPointer bn_p(args[0].data, args[0].length);
  BignumPointer bn_g;
  if (!bn_p) {
    Throw("ERR_INVALID_ARG_VALUE", "Invalid prime");
    return nullptr;
  }
  if (args[1].IsInt32()) {
    int32_t generator = args[1].Int32();
    if (generator < 2) {
      PutDhError(DH_R_BAD_GENERATOR);
      ThrowCrypto(ERR_get_error(), "Invalid generator");
      return nullptr;
    }
    bn_g = BignumPointer::New();
    if (!bn_g.setWord(generator)) {
      PutDhError(DH_R_BAD_GENERATOR);
      ThrowCrypto(ERR_get_error(), "Invalid generator");
      return nullptr;
    }
  } else {
    if (args[1].length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "generator is too big");
      return nullptr;
    }
    bn_g = BignumPointer(args[1].data, args[1].length);
    if (!bn_g) {
      PutDhError(DH_R_BAD_GENERATOR);
      ThrowCrypto(ERR_get_error(), "Invalid generator");
      return nullptr;
    }
    if (bn_g.getWord().has_value() && bn_g.getWord().value() < 2) {
      PutDhError(DH_R_BAD_GENERATOR);
      ThrowCrypto(ERR_get_error(), "Invalid generator");
      return nullptr;
    }
  }
  if (BN_num_bits(bn_p.get()) >= 512 && BN_cmp(bn_g.get(), bn_p.get()) >= 0) {
    PutDhError(DH_R_BAD_GENERATOR);
    ThrowCrypto(ERR_get_error(), "Invalid generator");
    return nullptr;
  }
  auto dh = DHPointer::New(std::move(bn_p), std::move(bn_g));
  if (!dh) {
    Throw("ERR_INVALID_ARG_VALUE", "Invalid DH parameters");
    return nullptr;
  }
  return Made(std::move(dh));
}
CRYPTO_EXPORT(tabnode_dh_free) void tabnode_dh_free(TnDH* dh) { delete dh; }

// GenerateKeys (226-240): the public key, or null where it threw.
CRYPTO_EXPORT(tabnode_dh_generate_keys) char* tabnode_dh_generate_keys(TnDH* dh, size_t* length) {
  auto dp = dh->dh_.generateKeys();
  if (!dp) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Key generation failed");
    return nullptr;
  }
  return Answer(std::move(dp), length);
}

// GetPrime, GetGenerator, GetPublicKey, GetPrivateKey (242-300): `which` 0 to 3; null where it threw.
CRYPTO_EXPORT(tabnode_dh_get) char* tabnode_dh_get(TnDH* dh, int which, size_t* length) {
  DataPointer dp;
  const char* missing;
  switch (which) {
    case 0:
      dp = dh->dh_.getPrime();
      missing = "p is null";
      break;
    case 1:
      dp = dh->dh_.getGenerator();
      missing = "g is null";
      break;
    case 2:
      dp = dh->dh_.getPublicKey();
      missing = "No public key - did you forget to generate one?";
      break;
    default:
      dp = dh->dh_.getPrivateKey();
      missing = "No private key - did you forget to generate one?";
  }
  if (!dp) {
    Throw("ERR_CRYPTO_INVALID_STATE", "%s", missing);
    return nullptr;
  }
  return Answer(std::move(dp), length);
}

// ComputeSecret (302-339): null where it threw.
CRYPTO_EXPORT(tabnode_dh_compute_secret) char* tabnode_dh_compute_secret(TnDH* dh, const unsigned char* data,
                                                                        size_t size, size_t* length) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "secret is too big");
    return nullptr;
  }
  BignumPointer key(data, size);
  switch (dh->dh_.checkPublicKey(key)) {
    case DHPointer::CheckPublicKeyResult::CHECK_FAILED:
      Throw("ERR_CRYPTO_INVALID_KEYTYPE", "Unspecified validation error");
      return nullptr;
    case DHPointer::CheckPublicKeyResult::TOO_SMALL:
      Throw("ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too small");
      return nullptr;
    case DHPointer::CheckPublicKeyResult::TOO_LARGE:
      Throw("ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too large");
      return nullptr;
    case DHPointer::CheckPublicKeyResult::INVALID:
      Throw("ERR_CRYPTO_INVALID_KEYTYPE", "Supplied key is invalid");
      return nullptr;
    case DHPointer::CheckPublicKeyResult::NONE:
      break;
  }
  auto dp = dh->dh_.computeSecret(key);
  if (!dp) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to compute shared secret");
    return nullptr;
  }
  return Answer(std::move(dp), length);
}

// SetPublicKey, SetPrivateKey (341-371): `which` 0 the public key, 1 the private; 1, or 0 where it threw.
CRYPTO_EXPORT(tabnode_dh_set_key) int tabnode_dh_set_key(TnDH* dh, int which, const unsigned char* data, size_t size) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "buf is too big");
    return 0;
  }
  BignumPointer num(data, size);
  if (which == 0) {
    if (!num || !dh->dh_.setPublicKey(std::move(num))) {
      Throw("ERR_INVALID_ARG_VALUE", "Invalid public key");
      return 0;
    }
  } else if (!num || !dh->dh_.setPrivateKey(std::move(num))) {
    Throw("ERR_INVALID_ARG_VALUE", "Invalid private key");
    return 0;
  }
  return 1;
}

// Check (373-385), the verifyError getter: its value, or -1 where it threw.
CRYPTO_EXPORT(tabnode_dh_check) int tabnode_dh_check(TnDH* dh) {
  auto result = dh->dh_.check();
  if (result == DHPointer::CheckResult::CHECK_FAILED) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Checking DH parameters failed");
    return -1;
  }
  return static_cast<int>(result);
}

// ---- DhKeyPairGenJob (crypto_dh.cc:388-480) ---------------------------------------------------------------------

namespace {
// DhKeyPairParams (crypto_dh.h:35-44).
struct DhKeyPairParams {
  std::variant<BignumPointer, int> prime;
  unsigned int generator;
};

// DhKeyGenTraits::Setup (442-480).
EVPKeyCtxPointer DhSetup(DhKeyPairParams* params) {
  EVPKeyPointer key_params;
  if (BignumPointer* prime_fixed_value = std::get_if<BignumPointer>(&params->prime)) {
    auto prime = prime_fixed_value->clone();
    auto bn_g = BignumPointer::New();
    if (!prime || !bn_g || !bn_g.setWord(params->generator)) return {};
    auto dh = DHPointer::New(std::move(prime), std::move(bn_g));
    if (!dh) return {};
    key_params = EVPKeyPointer::NewDH(std::move(dh));
  } else if (int* prime_size = std::get_if<int>(&params->prime)) {
    auto param_ctx = EVPKeyCtxPointer::NewFromID(EVP_PKEY_DH);
    if (!param_ctx.initForParamgen() || !param_ctx.setDhParameters(*prime_size, params->generator)) return {};
    key_params = param_ctx.paramgen();
  } else {
    abort();
  }
  if (!key_params) return {};
  EVPKeyCtxPointer ctx = key_params.newCtx();
  if (!ctx.initForKeygen()) return {};
  return ctx;
}
}  // namespace

// DhKeyGenTraits::AdditionalConfig (402-440).
KeyGenJob* NewDhKeyGenJob(CryptoJobMode mode, const TnValue* args, unsigned int* offset) {
  DhKeyPairParams params;
  if (args[*offset].IsString()) {
    std::string group_name = args[*offset].String();
    auto group = DHPointer::FindGroup(std::string_view(group_name));
    if (!group) {
      Throw("ERR_CRYPTO_UNKNOWN_DH_GROUP");
      return nullptr;
    }
    static constexpr int kStandardizedGenerator = 2;
    params.prime = std::move(group);
    params.generator = kStandardizedGenerator;
    *offset += 1;
  } else {
    if (args[*offset].IsInt32()) {
      int size = args[*offset].Int32();
      if (size < 0) {
        Throw("ERR_OUT_OF_RANGE", "Invalid prime size");
        return nullptr;
      }
      params.prime = size;
    } else {
      if (args[*offset].length > INT_MAX) {
        Throw("ERR_OUT_OF_RANGE", "prime is too big");
        return nullptr;
      }
      params.prime = BignumPointer(args[*offset].data, args[*offset].length);
    }
    CHECK(args[*offset + 1].IsInt32());
    params.generator = args[*offset + 1].Int32();
    *offset += 2;
  }
  return new KeyPairGenJob<DhKeyPairParams>(mode, std::move(params), DhSetup);
}

// ---- DHBitsJob (crypto_dh.cc:510-560) ---------------------------------------------------------------------------

namespace {
// DHBitsConfig (crypto_dh.h:84-91).
struct DHBitsConfig {
  KeyObjectData private_key;
  KeyObjectData public_key;
};

// DHBitsTraits::DeriveBits (535-556): a synchronous job's failure is thrown, "diffieHellman failed".
bool DeriveDHBits(const DHBitsConfig& params, ByteSource* out, CryptoJobMode mode) {
  auto dp = DHPointer::stateless(params.private_key.GetAsymmetricKey(), params.public_key.GetAsymmetricKey());
  if (!dp) {
    if (mode == kCryptoJobSync) {
      unsigned long err = ERR_get_error();  // NOLINT(runtime/int)
      if (err) ThrowCrypto(err, "diffieHellman failed");
    }
    return false;
  }
  *out = ByteSource::Allocated(dp.release());
  CHECK(!out->empty());
  return true;
}
}  // namespace

// DHBitsTraits::AdditionalConfig (510-527): `args` Node's from its second (the public key's slots, then the private
// key's). Null where it threw.
CRYPTO_EXPORT(tabnode_dh_bits_job_new) CryptoJob* tabnode_dh_bits_job_new(int32_t mode, const TnValue* args,
                                                                         uint32_t count) {
  unsigned int offset = 0;
  auto public_key = KeyObjectData::GetPublicOrPrivateKey(args, &offset);
  if (!public_key) return nullptr;
  auto private_key = KeyObjectData::GetPrivateKey(args, &offset, true);
  if (!private_key) return nullptr;
  DHBitsConfig params;
  params.public_key = std::move(public_key);
  params.private_key = std::move(private_key);
  return new DeriveBitsJob<DHBitsConfig>(JobMode(mode), std::move(params), DeriveDHBits);
}

// What the engine device's agreement takes (ADR-0018 §5): the job's two keys, each as a handle's new data.
CRYPTO_EXPORT(tabnode_dh_bits_job_key) KeyObjectData* tabnode_dh_bits_job_key(CryptoJob* job, int private_key) {
  auto* bits = static_cast<DeriveBitsJob<DHBitsConfig>*>(job);
  return NewHandleData(private_key ? bits->params.private_key : bits->params.public_key);
}

// GetDhKeyDetail (559-564): none.
bool GetDhKeyDetail(const KeyObjectData& key, TnFields* target) {
  if (key.GetAsymmetricKey().id() != EVP_PKEY_DH) abort();
  return true;
}
