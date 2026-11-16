// DSA OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's src/crypto/crypto_dsa.cc,
// over ncrypto and OpenSSL in libnode.so: a key's details and DsaKeyPairGenJob's configuration and Setup. WebCrypto
// defines no DSA, so every call here is OpenSSL's.
#include <optional>

#include "crypto_util.h"

using ncrypto::EVPKeyCtxPointer;

#define CHECK(condition) \
  if (!(condition)) abort()

namespace {
// DsaKeyPairParams (crypto_dsa.h:15-20).
struct DsaKeyPairParams {
  unsigned int modulus_bits;
  int divisor_bits;
};

// DsaKeyGenTraits::Setup (30-48).
EVPKeyCtxPointer DsaSetup(DsaKeyPairParams* params) {
  auto param_ctx = EVPKeyCtxPointer::NewFromID(EVP_PKEY_DSA);
  if (!param_ctx || !param_ctx.initForParamgen() ||
      !param_ctx.setDsaParameters(
          params->modulus_bits,
          params->divisor_bits != -1 ? std::optional<int>(params->divisor_bits) : std::nullopt)) {
    return {};
  }
  auto key_params = param_ctx.paramgen();
  if (!key_params) return {};
  EVPKeyCtxPointer key_ctx = key_params.newCtx();
  if (!key_ctx.initForKeygen()) return {};
  return key_ctx;
}
}  // namespace

// DsaKeyGenTraits::AdditionalConfig (60-75).
KeyGenJob* NewDsaKeyGenJob(CryptoJobMode mode, const TnValue* args, unsigned int* offset) {
  CHECK(args[*offset].IsUint32());
  CHECK(args[*offset + 1].IsInt32());
  DsaKeyPairParams params{args[*offset].Uint32(), args[*offset + 1].Int32()};
  CHECK(params.divisor_bits >= -1);
  *offset += 2;
  return new KeyPairGenJob<DsaKeyPairParams>(mode, std::move(params), DsaSetup);
}

// GetDsaKeyDetail (77-100).
bool GetDsaKeyDetail(const KeyObjectData& key, TnFields* target) {
  if (!key) return false;
  ncrypto::Dsa dsa = key.GetAsymmetricKey();
  if (!dsa) return false;
  target->Number("modulusLength", static_cast<double>(dsa.getModulusLength()));
  target->Number("divisorLength", static_cast<double>(dsa.getDivisorLength()));
  return true;
}
