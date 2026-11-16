// KMAC OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_kmac.cc, over ncrypto and OpenSSL in the program: KmacJob (WebCrypto's KMAC128 and KMAC256, which
// WebCrypto's standard does not define, so OpenSSL's). DeriveBits is Node's, unchanged; its cSHAKE path is
// crypto_hash.cc's DeriveCShakeBits.
#include <openssl/core_names.h>
#include <openssl/crypto.h>

#include <array>
#include <limits>

#include "crypto_util.h"

using ncrypto::EVPMacCtxPointer;
using ncrypto::EVPMacPointer;

#if OPENSSL_WITH_EVP_MAC
namespace {
enum class KmacVariant { KMAC128, KMAC256 };

// KmacConfig (crypto_kmac.h).
struct KmacConfig {
  uint32_t mode;  // SignConfiguration::Mode: 0 sign, 1 verify
  KeyObjectData key;
  ByteSource data;
  ByteSource signature;
  ByteSource customization;
  KmacVariant variant;
  size_t key_length;
  uint32_t length;
};

static constexpr std::array<unsigned char, 4> kKmacFunctionName = {'K', 'M', 'A', 'C'};
static constexpr size_t kKmacMinOpenSSLKeySize = 4;
static constexpr size_t kKmacMaxOpenSSLKeySize = 512;
static constexpr size_t kKmacMaxOpenSSLCustomizationSize = 512;
static constexpr size_t kKmacMaxOpenSSLOutputSize = 0xffffff / CHAR_BIT;

bool KmacParamsWithinOpenSSLLimits(const KmacConfig& params, size_t key_size, size_t length_bytes) {
  return key_size <= kKmacMaxOpenSSLKeySize && NumBitsToBytes(params.key_length) <= kKmacMaxOpenSSLKeySize &&
         params.customization.size() <= kKmacMaxOpenSSLCustomizationSize && length_bytes <= kKmacMaxOpenSSLOutputSize;
}

bool DeriveBitsWithCShake(const KmacConfig& params, const void* key_data, size_t key_size, ByteSource* out) {
  const size_t key_length_bytes = NumBitsToBytes(params.key_length);
  if (key_size < key_length_bytes) return false;
  CShakeBytepadInput key_input = {
      .data = key_data,
      .byte_length = key_length_bytes,
      .bit_length = params.key_length,
  };
  CShakeParams cshake_params = {
      .variant = params.variant == KmacVariant::KMAC128 ? CShakeVariant::CSHAKE128 : CShakeVariant::CSHAKE256,
      .function_name_data = kKmacFunctionName.data(),
      .function_name_size = kKmacFunctionName.size(),
      .customization_data = params.customization.data(),
      .customization_size = params.customization.size(),
      .bytepad_input = &key_input,
      .input_data = params.data.data(),
      .input_size = params.data.size(),
      .append_output_length = true,
      .length = params.length,
  };
  return DeriveCShakeBits(cshake_params, out);
}

// KmacTraits::DeriveBits.
bool DeriveKmac(const KmacConfig& params, ByteSource* out, CryptoJobMode mode) {
  const bool truncate_to_bit_length = params.length % CHAR_BIT != 0;
  const size_t length_bytes = NumBitsToBytes(static_cast<size_t>(params.length));
  const void* key_data = params.key.GetSymmetricKey();
  size_t key_size = params.key.GetSymmetricKeySize();
  if (!KmacParamsWithinOpenSSLLimits(params, key_size, length_bytes)) return false;
  if (params.length == 0) {
    *out = ByteSource();
    return true;
  }
  if (params.length % CHAR_BIT != 0 || params.key_length % CHAR_BIT != 0 || key_size < kKmacMinOpenSSLKeySize) {
    return DeriveBitsWithCShake(params, key_data, key_size, out);
  }
  auto mac = EVPMacPointer::Fetch((params.variant == KmacVariant::KMAC128) ? OSSL_MAC_NAME_KMAC128
                                                                           : OSSL_MAC_NAME_KMAC256);
  if (!mac) return false;
  auto mac_ctx = EVPMacCtxPointer::New(mac.get());
  if (!mac_ctx) return false;
  OSSL_PARAM params_array[3];
  size_t params_count = 0;
  size_t outlen = length_bytes;
  params_array[params_count++] = OSSL_PARAM_construct_size_t(OSSL_MAC_PARAM_SIZE, &outlen);
  if (params.customization.size() > 0) {
    params_array[params_count++] = OSSL_PARAM_construct_octet_string(
        OSSL_MAC_PARAM_CUSTOM, const_cast<void*>(params.customization.data()), params.customization.size());
  }
  params_array[params_count] = OSSL_PARAM_construct_end();
  if (!mac_ctx.init(ncrypto::Buffer<const void>(key_data, key_size), params_array)) return false;
  if (!mac_ctx.update(ncrypto::Buffer<const void>(params.data.data(), params.data.size()))) return false;
  auto result = mac_ctx.final(length_bytes);
  if (!result) return false;
  auto buffer = result.release();
  *out = ByteSource::Allocated(buffer.data, buffer.len);
  if (truncate_to_bit_length) TruncateToBitLength(params.length, out);
  return true;
}
}  // namespace

// KmacTraits::AdditionalConfig: `args` Node's from its second (the sign mode, the key's handle, the algorithm's
// name, the customization, the key's length in bits, the output's length in bits, the data, the signature). Null
// where it threw.
CRYPTO_EXPORT(tabnode_kmac_job_new) CryptoJob* tabnode_kmac_job_new(int32_t mode, const TnValue* args, uint32_t count) {
  KmacConfig params;
  if (!args[0].IsUint32() || !args[1].IsKey() || !args[2].IsString()) abort();
  params.mode = args[0].Uint32();
  params.key = args[1].Key().addRef();
  std::string algorithm = args[2].String();
  if (algorithm == OSSL_MAC_NAME_KMAC128) {
    params.variant = KmacVariant::KMAC128;
  } else if (algorithm == OSSL_MAC_NAME_KMAC256) {
    params.variant = KmacVariant::KMAC256;
  } else {
    abort();
  }
  if (!args[3].IsUndefined()) {
    if (args[3].length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "customization is too big");
      return nullptr;
    }
    params.customization = args[3].Bytes();
  }
  double key_length = args[4].number;
  if (!(key_length >= 0) || key_length > static_cast<double>(std::numeric_limits<size_t>::max())) {
    Throw("ERR_OUT_OF_RANGE", "key length is too big");
    return nullptr;
  }
  params.key_length = static_cast<size_t>(key_length);
  if (!args[5].IsUint32()) abort();
  params.length = args[5].Uint32();
  if (args[6].length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too big");
    return nullptr;
  }
  params.data = args[6].Bytes();
  if (!args[7].IsUndefined()) {
    if (args[7].length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "signature is too big");
      return nullptr;
    }
    params.signature = args[7].Bytes();
  }
  return new DeriveBitsJob<KmacConfig>(JobMode(mode), std::move(params), DeriveKmac);
}

// KmacTraits::EncodeOutput's verify branch.
CRYPTO_EXPORT(tabnode_kmac_job_verified) int tabnode_kmac_job_verified(CryptoJob* job) {
  const auto& params = static_cast<DeriveBitsJob<KmacConfig>*>(job)->params;
  const ByteSource& out = job->out;
  return out.size() > 0 && out.size() == params.signature.size() &&
                 CRYPTO_memcmp(out.data(), params.signature.data(), out.size()) == 0
             ? 1
             : 0;
}
#endif
