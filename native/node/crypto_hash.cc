// THE HASHES OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_hash.cc, over ncrypto and OpenSSL in libnode.so: the digests' cache (GetDigestImplementation),
// getHashes and getCachedAliases, oneShotDigest, Hash, HashJob and CShakeJob. Which digest calls OpenSSL answers and
// which the engine device answers is the binding's routing (src/node-lib/binding/crypto_hash.ts); these are
// OpenSSL's. The Keccak helpers and DeriveCShakeBits (crypto_hash.cc:608-776, 876-939) are Node's, unchanged but for
// DCHECK.
#include <openssl/core_names.h>
#include <openssl/err.h>
#include <openssl/evp.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "crypto_util.h"

using ncrypto::EVPMDCtxPointer;
using ncrypto::MarkPopErrorOnReturn;

#define DCHECK(condition)
#define DCHECK_GE(a, b)

// CShakeParams and DeriveCShakeBits (crypto_hash.h:84-110) are crypto_util.h's, which KMAC (crypto_kmac.cc) takes too.

namespace {
// The process's digests, as Node's Environment caches them (env->evp_md_cache, alias_to_md_id_map,
// supported_hash_algorithms): one Environment a process.
std::vector<EVP_MD*> evp_md_cache;
std::map<std::string, size_t> alias_to_md_id_map;
std::vector<std::string> supported_hash_algorithms;

// PushAliases ... SaveSupportedHashAlgorithmsAndCacheMD (crypto_hash.cc:80-150), OpenSSL 3's.
void PushAliases(const char* name, void* data) { static_cast<std::vector<std::string>*>(data)->push_back(name); }
struct MaybeCachedMD {
  EVP_MD* explicit_md = nullptr;
  const EVP_MD* implicit_md = nullptr;
  int32_t cache_id = -1;
};
MaybeCachedMD FetchAndMaybeCacheMD(const char* search_name) {
  const EVP_MD* implicit_md = ncrypto::getDigestByName(search_name);
  if (!implicit_md) return {nullptr, nullptr, -1};
  const char* real_name = EVP_MD_get0_name(implicit_md);
  if (!real_name) return {nullptr, implicit_md, -1};
  auto it = alias_to_md_id_map.find(real_name);
  if (it != alias_to_md_id_map.end()) {
    size_t id = it->second;
    return {evp_md_cache[id], implicit_md, static_cast<int32_t>(id)};
  }
  EVP_MD* explicit_md = EVP_MD_fetch(nullptr, real_name, nullptr);
  if (!explicit_md) return {nullptr, implicit_md, -1};
  evp_md_cache.push_back(explicit_md);
  size_t id = evp_md_cache.size() - 1;
  std::vector<std::string> aliases;
  EVP_MD_names_do_all(explicit_md, PushAliases, &aliases);
  for (const auto& alias : aliases) alias_to_md_id_map.emplace(alias, id);
  alias_to_md_id_map.emplace(search_name, id);
  return {explicit_md, implicit_md, static_cast<int32_t>(id)};
}
void SaveSupportedHashAlgorithmsAndCacheMD(const EVP_MD* md, const char* from, const char* to, void* arg) {
  if (!from) return;
  auto result = FetchAndMaybeCacheMD(from);
  if (result.explicit_md) supported_hash_algorithms.push_back(from);
}
const std::vector<std::string>& GetSupportedHashAlgorithms() {
  if (supported_hash_algorithms.empty()) {
    MarkPopErrorOnReturn mark_pop_error_on_return;
    EVP_MD_do_all_sorted(SaveSupportedHashAlgorithmsAndCacheMD, nullptr);
  }
  return supported_hash_algorithms;
}

// GetDigestImplementation (192-228): `*new_cache_id` is the id the V8 half sets in its algorithm cache (-1: none).
const EVP_MD* GetDigestImplementation(const char* algorithm, int32_t cache_id, int32_t* new_cache_id) {
  *new_cache_id = -1;
  if (cache_id != -1) return evp_md_cache[cache_id];
  auto result = FetchAndMaybeCacheMD(algorithm);
  if (result.cache_id != -1) {
    alias_to_md_id_map.emplace(algorithm, result.cache_id);
    *new_cache_id = result.cache_id;
  }
  return result.explicit_md ? result.explicit_md : result.implicit_md;
}

void MarkInvalidXofLength() { ERR_raise(ERR_LIB_EVP, EVP_R_NOT_XOF_OR_INVALID_LENGTH); }

// The SHAKE defaults (HashInit, OneShotDigest).
unsigned int DefaultXofLength(const EVP_MD* md) {
  const char* name = OBJ_nid2sn(EVP_MD_type(md));
  if (name != nullptr) {
    if (strcmp(name, "SHAKE128") == 0) return 16;
    if (strcmp(name, "SHAKE256") == 0) return 32;
  }
  return 0;
}
}  // namespace

// GetHashes (152-160): the names, each NUL-terminated.
CRYPTO_EXPORT(tabnode_hash_get_hashes) char* tabnode_hash_get_hashes(size_t* length) {
  std::string out;
  for (const auto& name : GetSupportedHashAlgorithms()) {
    out += name;
    out.push_back('\0');
  }
  return Copy(out.data(), out.size(), length);
}
// GetCachedAliases (162-190): name NUL id NUL pairs.
CRYPTO_EXPORT(tabnode_hash_cached_aliases) char* tabnode_hash_cached_aliases(size_t* length) {
  std::string out;
  for (auto& [alias, id] : alias_to_md_id_map) {
    out += alias;
    out.push_back('\0');
    out += std::to_string(id);
    out.push_back('\0');
  }
  return Copy(out.data(), out.size(), length);
}

// OneShotDigest (238-325): the digest's bytes (the V8 half encodes them), or null where it threw; `output_length`
// is -1 for undefined.
CRYPTO_EXPORT(tabnode_hash_one_shot) char* tabnode_hash_one_shot(const char* algorithm, int32_t cache_id,
                                                                int32_t* new_cache_id, const unsigned char* input,
                                                                size_t input_length, int64_t output_length_arg,
                                                                size_t* length) {
  const EVP_MD* md = GetDigestImplementation(algorithm, cache_id, new_cache_id);
  if (md == nullptr) {
    std::string message = std::string("Digest method ") + algorithm + " is not supported";
    ThrowCrypto(ERR_get_error(), message.c_str());
    return nullptr;
  }
  bool is_xof = (EVP_MD_flags(md) & EVP_MD_FLAG_XOF) != 0;
  int output_length = EVP_MD_size(md);
  if (!is_xof && output_length_arg >= 0) {
    output_length = static_cast<int>(output_length_arg);
    if (output_length != EVP_MD_size(md)) {
      std::string message = "Output length " + std::to_string(output_length) + " is invalid for ";
      message += std::string(algorithm) + ", which does not support XOF";
      ThrowCrypto(ERR_get_error(), message.c_str());
      return nullptr;
    }
  } else if (is_xof) {
    if (output_length_arg >= 0) {
      output_length = static_cast<int>(output_length_arg);
    } else if (output_length == 0) {
      output_length = static_cast<int>(DefaultXofLength(md));
    }
  }
  if (output_length == 0) return Copy("", 0, length);
  ncrypto::Buffer<const unsigned char> buf = {.data = input, .len = input_length};
  ncrypto::DataPointer output =
      is_xof ? ncrypto::xofHashDigest(buf, md, output_length) : ncrypto::hashDigest(buf, md);
  if (!output) {
    ThrowCrypto(ERR_get_error());
    return nullptr;
  }
  return Copy(output.get<const char>(), output.size(), length);
}

// Hash (Hash::New, HashInit, HashUpdate, HashDigest: 343-440): its context, its length, its digest once made.
struct TnHash {
  EVPMDCtxPointer mdctx;
  unsigned int md_len = 0;
  ByteSource digest;
};

namespace {
bool HashInit(TnHash* hash, const EVP_MD* md, bool has_xof, unsigned int xof_md_len) {
  hash->mdctx = EVPMDCtxPointer::New();
  if (!hash->mdctx.digestInit(md)) {
    hash->mdctx.reset();
    return false;
  }
  hash->md_len = hash->mdctx.getDigestSize();
  if (hash->mdctx.hasXofFlag() && !has_xof && hash->md_len == 0) hash->md_len = DefaultXofLength(md);
  if (has_xof && xof_md_len != hash->md_len) {
    if (!hash->mdctx.hasXofFlag()) {
      MarkInvalidXofLength();
      hash->mdctx.reset();
      return false;
    }
    hash->md_len = xof_md_len;
  }
  return true;
}
}  // namespace

// Hash::New (343-372): a copy of `orig` where it is given, else the named digest; null where it threw.
CRYPTO_EXPORT(tabnode_hash_new) TnHash* tabnode_hash_new(TnHash* orig, const char* algorithm, int32_t cache_id,
                                                        int32_t* new_cache_id, int has_xof, uint32_t xof_md_len) {
  *new_cache_id = -1;
  const EVP_MD* md = orig != nullptr ? orig->mdctx.getDigest()
                                     : GetDigestImplementation(algorithm, cache_id, new_cache_id);
  TnHash* hash = new TnHash();
  if (md == nullptr || !HashInit(hash, md, has_xof != 0, xof_md_len)) {
    ThrowCrypto(ERR_get_error(), "Digest method not supported");
    delete hash;
    return nullptr;
  }
  if (orig != nullptr && !orig->mdctx.copyTo(hash->mdctx)) {
    ThrowCrypto(ERR_get_error(), "Digest copy error");
    delete hash;
    return nullptr;
  }
  return hash;
}
CRYPTO_EXPORT(tabnode_hash_free) void tabnode_hash_free(TnHash* hash) { delete hash; }

// HashUpdate (398-421): 1 or 0, -1 where it threw.
CRYPTO_EXPORT(tabnode_hash_update) int tabnode_hash_update(TnHash* hash, const void* data, size_t size) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too long");
    return -1;
  }
  if (!hash->mdctx) return 0;
  return hash->mdctx.digestUpdate(ncrypto::Buffer<const void>{.data = data, .len = size}) ? 1 : 0;
}

// HashDigest (423-450): the digest's bytes, made once and kept; null where it threw.
CRYPTO_EXPORT(tabnode_hash_digest) char* tabnode_hash_digest(TnHash* hash, size_t* length) {
  unsigned int len = hash->md_len;
  if (!hash->digest && len > 0) {
    auto data = hash->mdctx.digestFinal(len);
    if (!data) {
      ThrowCrypto(ERR_get_error());
      return nullptr;
    }
    hash->digest = ByteSource::Allocated(data.release());
  }
  return Copy(hash->digest.data<char>(), len, length);
}

// HashJob (HashTraits, 452-517).
namespace {
struct HashConfig {
  ByteSource in;
  const EVP_MD* digest;
  unsigned int length;
};
bool DeriveHash(const HashConfig& params, ByteSource* out, CryptoJobMode mode) {
  auto ctx = EVPMDCtxPointer::New();
  if (!ctx.digestInit(params.digest) || !ctx.digestUpdate(params.in)) return false;
  if (params.length > 0) {
    auto data = ctx.digestFinal(params.length);
    if (!data) return false;
    *out = ByteSource::Allocated(data.release());
  }
  return true;
}
}  // namespace

// HashTraits::AdditionalConfig (474-505): `length_bits` -1 for none; null where it threw.
CRYPTO_EXPORT(tabnode_hash_job_new) CryptoJob* tabnode_hash_job_new(int32_t mode, const char* algorithm,
                                                                   const void* data, size_t size,
                                                                   int64_t length_bits) {
  HashConfig params;
  params.digest = ncrypto::getDigestByName(algorithm);
  if (params.digest == nullptr) {
    Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", algorithm);
    return nullptr;
  }
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too big");
    return nullptr;
  }
  params.in = ByteSource::CopyOf(data, size);
  unsigned int expected = EVP_MD_size(params.digest);
  params.length = expected;
  if (length_bits >= 0) {
    params.length = static_cast<uint32_t>(length_bits) / CHAR_BIT;
    if (params.length != expected && (EVP_MD_flags(params.digest) & EVP_MD_FLAG_XOF) == 0) {
      Throw("ERR_CRYPTO_INVALID_DIGEST", "Digest method not supported");
      return nullptr;
    }
  }
  return new DeriveBitsJob<HashConfig>(JobMode(mode), std::move(params), DeriveHash);
}

#if OPENSSL_WITH_EVP_MAC
namespace {
static constexpr std::array<unsigned char, 1> kEmptyString = {};
static constexpr size_t kKeccakKmac128Rate = 168;
static constexpr size_t kKeccakKmac256Rate = 136;
static constexpr size_t kMaxCShakeCustomizationSize = 512;

struct EncodedLength {
  std::array<unsigned char, sizeof(size_t) + 1> data;
  size_t size;
};

struct EncodedStringInput {
  const void* data;
  size_t byte_length;
  size_t bit_length;
};

struct KeccakKmacXof {
  ncrypto::EVPMDCtxPointer ctx;
  size_t rate;
};

size_t EncodedLengthSize(size_t value) {
  size_t size = 1;
  size_t remaining = value;
  while (remaining >>= CHAR_BIT) size++;
  return size + 1;
}

bool AddSize(size_t a, size_t b, size_t* out) {
  if (a > std::numeric_limits<size_t>::max() - b) return false;
  *out = a + b;
  return true;
}

EncodedLength EncodeLength(size_t value, bool left) {
  const size_t value_size = EncodedLengthSize(value) - 1;
  EncodedLength encoded = {{}, value_size + 1};

  if (left) encoded.data[0] = static_cast<unsigned char>(value_size);
  for (size_t n = 0; n < value_size; n++) {
    const size_t shift = CHAR_BIT * (value_size - n - 1);
    encoded.data[(left ? 1 : 0) + n] =
        static_cast<unsigned char>(value >> shift);
  }
  if (!left) encoded.data[value_size] = static_cast<unsigned char>(value_size);

  return encoded;
}

bool DigestUpdate(ncrypto::EVPMDCtxPointer* ctx,
                  const void* data,
                  size_t size) {
  if (size == 0) return true;
  return ctx->digestUpdate(ncrypto::Buffer<const void>{
      .data = data,
      .len = size,
  });
}

bool DigestUpdateZeros(ncrypto::EVPMDCtxPointer* ctx, size_t size) {
  static constexpr std::array<unsigned char, 168> zeros = {};
  while (size > 0) {
    const size_t chunk = std::min(size, zeros.size());
    if (!DigestUpdate(ctx, zeros.data(), chunk)) return false;
    size -= chunk;
  }
  return true;
}

bool EncodedStringSize(size_t byte_length, size_t bit_length, size_t* size) {
  return AddSize(EncodedLengthSize(bit_length), byte_length, size);
}

bool ByteLengthToBitLength(size_t byte_length, size_t* bit_length) {
  if (byte_length > std::numeric_limits<size_t>::max() / CHAR_BIT) {
    return false;
  }
  *bit_length = byte_length * CHAR_BIT;
  return true;
}

KeccakKmacXof NewKeccakKmacXof(bool use_128_bits) {
  // OpenSSL 3.x exposes the cSHAKE/KMAC suffix primitive as KECCAK-KMAC-*.
  const char* digest_name = use_128_bits ? OSSL_DIGEST_NAME_KECCAK_KMAC128
                                         : OSSL_DIGEST_NAME_KECCAK_KMAC256;
  auto digest = std::unique_ptr<EVP_MD, decltype(&EVP_MD_free)>{
      EVP_MD_fetch(nullptr, digest_name, nullptr), EVP_MD_free};
  if (!digest) return {};

  auto ctx = ncrypto::EVPMDCtxPointer::New();
  if (!ctx.digestInit(digest.get())) return {};

  return {
      .ctx = std::move(ctx),
      .rate = use_128_bits ? kKeccakKmac128Rate : kKeccakKmac256Rate,
  };
}

bool ToEncodedStringInput(const void* data,
                          size_t byte_length,
                          EncodedStringInput* input) {
  if (byte_length > 0 && data == nullptr) return false;

  size_t bit_length;
  if (!ByteLengthToBitLength(byte_length, &bit_length)) return false;

  *input = {
      .data = byte_length == 0 ? kEmptyString.data() : data,
      .byte_length = byte_length,
      .bit_length = bit_length,
  };
  return true;
}

bool DigestUpdateEncodedLength(ncrypto::EVPMDCtxPointer* ctx,
                               size_t value,
                               bool left) {
  const EncodedLength encoded = EncodeLength(value, left);
  return DigestUpdate(ctx, encoded.data.data(), encoded.size);
}

bool DigestUpdateEncodedString(ncrypto::EVPMDCtxPointer* ctx,
                               const void* data,
                               size_t byte_length,
                               size_t bit_length) {
  return DigestUpdateEncodedLength(ctx, bit_length, true) &&
         DigestUpdate(ctx, data, byte_length);
}

bool DigestUpdateBytepad(ncrypto::EVPMDCtxPointer* ctx,
                         size_t width,
                         const void* data,
                         size_t byte_length,
                         size_t bit_length,
                         const void* data2 = nullptr,
                         size_t byte_length2 = 0,
                         size_t bit_length2 = 0) {
  if (width == 0) return false;

  size_t encoded_size;
  size_t written = EncodedLengthSize(width);
  if (!EncodedStringSize(byte_length, bit_length, &encoded_size) ||
      !AddSize(written, encoded_size, &written)) {
    return false;
  }
  if (data2 != nullptr) {
    if (!EncodedStringSize(byte_length2, bit_length2, &encoded_size) ||
        !AddSize(written, encoded_size, &written)) {
      return false;
    }
  }

  size_t padded_size;
  if (!AddSize(written, width - 1, &padded_size)) return false;
  padded_size = padded_size / width * width;
  DCHECK_GE(padded_size, written);
  const size_t padding = padded_size - written;

  return DigestUpdateEncodedLength(ctx, width, true) &&
         DigestUpdateEncodedString(ctx, data, byte_length, bit_length) &&
         (data2 == nullptr ||
          DigestUpdateEncodedString(ctx, data2, byte_length2, bit_length2)) &&
         DigestUpdateZeros(ctx, padding);
}

}  // namespace

bool DeriveCShakeBits(const CShakeParams& params, ByteSource* out) {
  if (params.customization_size > kMaxCShakeCustomizationSize) {
    return false;
  }

  if (params.length == 0) {
    *out = ByteSource();
    return true;
  }

  auto xof = NewKeccakKmacXof(params.variant == CShakeVariant::CSHAKE128);
  if (!xof.ctx) return false;
  auto ctx = std::move(xof.ctx);

  EncodedStringInput function_name;
  EncodedStringInput customization;
  if (!ToEncodedStringInput(params.function_name_data,
                            params.function_name_size,
                            &function_name) ||
      !ToEncodedStringInput(params.customization_data,
                            params.customization_size,
                            &customization)) {
    return false;
  }

  if (!DigestUpdateBytepad(&ctx,
                           xof.rate,
                           function_name.data,
                           function_name.byte_length,
                           function_name.bit_length,
                           customization.data,
                           customization.byte_length,
                           customization.bit_length)) {
    return false;
  }

  if (params.bytepad_input != nullptr &&
      !DigestUpdateBytepad(&ctx,
                           xof.rate,
                           params.bytepad_input->data,
                           params.bytepad_input->byte_length,
                           params.bytepad_input->bit_length)) {
    return false;
  }

  if (!DigestUpdate(&ctx, params.input_data, params.input_size)) {
    return false;
  }

  if (params.append_output_length &&
      !DigestUpdateEncodedLength(&ctx, params.length, false)) {
    return false;
  }

  const size_t length_bytes =
      NumBitsToBytes(static_cast<size_t>(params.length));
  auto data = ctx.digestFinal(length_bytes);
  if (!data) [[unlikely]]
    return false;

  DCHECK(!data.isSecure());
  *out = ByteSource::Allocated(data.release());
  if (params.length % CHAR_BIT != 0) TruncateToBitLength(params.length, out);
  return true;
}

namespace {
struct CShakeConfig {
  ByteSource in;
  ByteSource function_name;
  ByteSource customization;
  CShakeVariant variant;
  uint32_t length;
};
bool DeriveCShake(const CShakeConfig& params, ByteSource* out, CryptoJobMode mode) {
  CShakeParams cshake_params = {
      .variant = params.variant,
      .function_name_data = params.function_name.data(),
      .function_name_size = params.function_name.size(),
      .customization_data = params.customization.data(),
      .customization_size = params.customization.size(),
      .bytepad_input = nullptr,
      .input_data = params.in.data(),
      .input_size = params.in.size(),
      .append_output_length = false,
      .length = params.length,
  };
  return DeriveCShakeBits(cshake_params, out);
}
}  // namespace

// CShakeTraits::AdditionalConfig (808-856): a null function name or customization is undefined.
CRYPTO_EXPORT(tabnode_cshake_job_new) CryptoJob* tabnode_cshake_job_new(int32_t mode, const char* algorithm,
                                                                       const void* data, size_t size,
                                                                       const void* function_name, size_t function_size,
                                                                       const void* customization, size_t custom_size,
                                                                       uint32_t length) {
  CShakeConfig params;
  std::string algorithm_str = algorithm;
  if (algorithm_str == "cSHAKE128") {
    params.variant = CShakeVariant::CSHAKE128;
  } else if (algorithm_str == "cSHAKE256") {
    params.variant = CShakeVariant::CSHAKE256;
  } else {
    abort();
  }
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too big");
    return nullptr;
  }
  params.in = ByteSource::CopyOf(data, size);
  if (function_name != nullptr) {
    if (function_size > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "functionName is too big");
      return nullptr;
    }
    params.function_name = ByteSource::CopyOf(function_name, function_size);
  }
  if (customization != nullptr) {
    if (custom_size > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "customization is too big");
      return nullptr;
    }
    params.customization = ByteSource::CopyOf(customization, custom_size);
  }
  params.length = length;
  return new DeriveBitsJob<CShakeConfig>(JobMode(mode), std::move(params), DeriveCShake);
}
#endif  // OPENSSL_WITH_EVP_MAC
