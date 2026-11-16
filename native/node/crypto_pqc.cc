// POST-QUANTUM KEYS OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_pqc.cc, over ncrypto and OpenSSL 3.5's ML-DSA, ML-KEM and SLH-DSA in libnode.so: a key's AKP JWK,
// and the algorithms' names and kinds.
#include <cstring>

#include "crypto_util.h"

#if OPENSSL_WITH_PQC
using ncrypto::DataPointer;
using ncrypto::EVPKeyPointer;

namespace {
enum PqcAlgorithmFlag {
  kPqcRawPrivate = 1 << 0,
  kPqcRawSeed = 1 << 1,
  kPqcSignature = 1 << 2,
};
// PqcAlgorithm (20-119): its key type is Node's env string of it (env_properties.h:113-130).
struct PqcAlgorithm {
  int id;
  const char* name;
  const char* key_type;
  int flags;
};
constexpr int kPqcMlDsaFlags = kPqcRawSeed | kPqcSignature;
constexpr int kPqcMlKemFlags = kPqcRawSeed;
constexpr int kPqcSlhDsaFlags = kPqcRawPrivate | kPqcSignature;
constexpr PqcAlgorithm kPqcAlgorithms[] = {
    {EVP_PKEY_ML_DSA_44, "ML-DSA-44", "ml-dsa-44", kPqcMlDsaFlags},
    {EVP_PKEY_ML_DSA_65, "ML-DSA-65", "ml-dsa-65", kPqcMlDsaFlags},
    {EVP_PKEY_ML_DSA_87, "ML-DSA-87", "ml-dsa-87", kPqcMlDsaFlags},
    {EVP_PKEY_ML_KEM_768, "ML-KEM-768", "ml-kem-768", kPqcMlKemFlags},
    {EVP_PKEY_ML_KEM_1024, "ML-KEM-1024", "ml-kem-1024", kPqcMlKemFlags},
#if OPENSSL_WITH_PQC_ML_KEM_512
    {EVP_PKEY_ML_KEM_512, "ML-KEM-512", "ml-kem-512", kPqcMlKemFlags},
#endif
#if OPENSSL_WITH_PQC_SLH_DSA
    {EVP_PKEY_SLH_DSA_SHA2_128F, "SLH-DSA-SHA2-128f", "slh-dsa-sha2-128f", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHA2_128S, "SLH-DSA-SHA2-128s", "slh-dsa-sha2-128s", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHA2_192F, "SLH-DSA-SHA2-192f", "slh-dsa-sha2-192f", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHA2_192S, "SLH-DSA-SHA2-192s", "slh-dsa-sha2-192s", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHA2_256F, "SLH-DSA-SHA2-256f", "slh-dsa-sha2-256f", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHA2_256S, "SLH-DSA-SHA2-256s", "slh-dsa-sha2-256s", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHAKE_128F, "SLH-DSA-SHAKE-128f", "slh-dsa-shake-128f", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHAKE_128S, "SLH-DSA-SHAKE-128s", "slh-dsa-shake-128s", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHAKE_192F, "SLH-DSA-SHAKE-192f", "slh-dsa-shake-192f", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHAKE_192S, "SLH-DSA-SHAKE-192s", "slh-dsa-shake-192s", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHAKE_256F, "SLH-DSA-SHAKE-256f", "slh-dsa-shake-256f", kPqcSlhDsaFlags},
    {EVP_PKEY_SLH_DSA_SHAKE_256S, "SLH-DSA-SHAKE-256s", "slh-dsa-shake-256s", kPqcSlhDsaFlags},
#endif
};
const PqcAlgorithm* FindPqcAlgorithmById(int id) {
  for (const auto& alg : kPqcAlgorithms) {
    if (alg.id == id) return &alg;
  }
  return nullptr;
}
const PqcAlgorithm* FindPqcAlgorithmByName(const char* name) {
  for (const auto& alg : kPqcAlgorithms) {
    if (strcmp(name, alg.name) == 0) return &alg;
  }
  return nullptr;
}
bool HasPqcAlgorithmFlag(const PqcAlgorithm* alg, PqcAlgorithmFlag flag) {
  return alg != nullptr && (alg->flags & flag) != 0;
}
bool TrySetEncodedKey(DataPointer data, TnFields* target, const char* key) {
  if (!data) return false;
  target->Base64Url(key, data.get(), data.size());
  return true;
}
}  // namespace

// ExportJwkPqcKey (153-188).
bool ExportJwkPqcKey(const KeyObjectData& key, TnFields* target) {
  std::lock_guard<std::mutex> lock(key.mutex());
  const auto& pkey = key.GetAsymmetricKey();
  const PqcAlgorithm* alg = FindPqcAlgorithmById(pkey.id());
  if (!alg) abort();
  if (key.GetKeyType() == kKeyTypePrivate) {
    const bool uses_seed = HasPqcAlgorithmFlag(alg, kPqcRawSeed);
    DataPointer priv_data = uses_seed ? pkey.rawSeed() : pkey.rawPrivateKey();
    if (uses_seed && !priv_data) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "key does not have an available seed");
      return false;
    }
    if (!TrySetEncodedKey(std::move(priv_data), target, "priv")) return false;
  }
  target->String("kty", "AKP");
  target->String("alg", alg->name);
  return TrySetEncodedKey(pkey.rawPublicKey(), target, "pub");
}

// ImportJWKPqcKey (190-246).
KeyObjectData ImportJWKPqcKey(const TnValue& jwk) {
  const TnValue& alg_value = jwk.Get("alg");
  const TnValue& pub_value = jwk.Get("pub");
  const TnValue& priv_value = jwk.Get("priv");
  std::string alg_str = alg_value.IsString() ? alg_value.String() : std::string();
  const PqcAlgorithm* alg = FindPqcAlgorithmByName(alg_str.c_str());
  if (!alg) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Unsupported JWK AKP \"alg\"");
    return {};
  }
  if (!pub_value.IsString() || (!priv_value.IsUndefined() && !priv_value.IsString())) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK AKP key");
    return {};
  }
  KeyType type = priv_value.IsString() ? kKeyTypePrivate : kKeyTypePublic;
  EVPKeyPointer pkey;
  if (type == kKeyTypePrivate) {
    ByteSource priv = priv_value.Decoded();
    ncrypto::Buffer<const unsigned char> buf{.data = priv.data<unsigned char>(), .len = priv.size()};
    pkey = HasPqcAlgorithmFlag(alg, kPqcRawSeed) ? EVPKeyPointer::NewRawSeed(alg->id, buf)
                                                 : EVPKeyPointer::NewRawPrivate(alg->id, buf);
  } else {
    ByteSource pub = pub_value.Decoded();
    pkey = EVPKeyPointer::NewRawPublic(
        alg->id, ncrypto::Buffer<const unsigned char>{.data = pub.data<unsigned char>(), .len = pub.size()});
  }
  if (!pkey) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK AKP key");
    return {};
  }
  return KeyObjectData::CreateAsymmetric(type, std::move(pkey));
}

// IsPqcKeyId and the rest (248-281).
bool IsPqcKeyId(int id) { return FindPqcAlgorithmById(id) != nullptr; }
bool IsPqcRawPrivateKeyId(int id) { return HasPqcAlgorithmFlag(FindPqcAlgorithmById(id), kPqcRawPrivate); }
bool IsPqcSeedKeyId(int id) { return HasPqcAlgorithmFlag(FindPqcAlgorithmById(id), kPqcRawSeed); }
bool IsPqcSignatureKeyId(int id) { return HasPqcAlgorithmFlag(FindPqcAlgorithmById(id), kPqcSignature); }
int GetPqcNidFromName(const char* name) {
  for (const auto& alg : kPqcAlgorithms) {
    if (strcasecmp(name, alg.name) == 0) return alg.id;
  }
  return NID_undef;
}
const char* GetPqcAsymmetricKeyType(int id) {
  const PqcAlgorithm* alg = FindPqcAlgorithmById(id);
  return alg == nullptr ? nullptr : alg->key_type;
}
#endif
