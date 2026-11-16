// AES OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's src/crypto/crypto_aes.cc,
// over ncrypto and OpenSSL in the program: AESCipherJob (WebCrypto's AES-CTR, AES-CBC, AES-GCM, AES-KW and AES-OCB).
// The engine device answers the variants the browser holds (the binding's routing,
// src/node-lib/binding/crypto_webcrypto.ts); these are the rest. The bodies are Node's (its OpenSSL branch, not
// BoringSSL's), unchanged but for CHECK and their `env` argument.
#include <cstring>
#include <vector>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::Cipher;
using ncrypto::CipherCtxPointer;
using ncrypto::DataPointer;

#define CHECK(condition) \
  if (!(condition)) abort()
#define CHECK_EQ(a, b) CHECK((a) == (b))
#define CHECK_LE(a, b) CHECK((a) <= (b))

namespace {
// AESKeyVariant (crypto_aes.h:14-60), OpenSSL's: the order kKeyVariantAES_* number.
enum class AESKeyVariant {
  CTR_128, CTR_192, CTR_256, CBC_128, CBC_192, CBC_256, GCM_128, GCM_192, GCM_256, KW_128, KW_192, KW_256,
#if OPENSSL_WITH_AES_OCB
  OCB_128, OCB_192, OCB_256,
#endif
};

// AESCipherConfig (crypto_aes.h:62-77, its move at crypto_aes.cc:487-497): a Cipher copies and does not move.
struct AESCipherConfig {
  AESKeyVariant variant;
  Cipher cipher;
  size_t length = 0;
  ByteSource iv;  // Used for both iv or counter
  ByteSource additional_data;
  AESCipherConfig() = default;
  AESCipherConfig(AESCipherConfig&& other) noexcept
      : variant(other.variant),
        cipher(other.cipher),
        length(other.length),
        iv(std::move(other.iv)),
        additional_data(std::move(other.additional_data)) {}
};

constexpr size_t kAesBlockSize = 16;
constexpr const char* kDefaultWrapIV = "\xa6\xa6\xa6\xa6\xa6\xa6\xa6\xa6";

// AES_Cipher (crypto_aes.cc:48-200).
WebCryptoCipherStatus AES_Cipher(const KeyObjectData& key_data, WebCryptoCipherMode cipher_mode,
                                 const AESCipherConfig& params, const ByteSource& in, ByteSource* out) {
  CHECK_EQ(key_data.GetKeyType(), kKeyTypeSecret);
  auto ctx = CipherCtxPointer::New();
  if (!ctx) return WebCryptoCipherStatus::FAILED;
  if (params.cipher.isWrapMode()) ctx.setAllowWrap();
  const bool encrypt = cipher_mode == kWebCryptoCipherEncrypt;
  if (!ctx.init(params.cipher, encrypt)) return WebCryptoCipherStatus::FAILED;
  if ((params.cipher.isGcmMode() || params.cipher.isOcbMode()) && !ctx.setIvLength(params.iv.size())) {
    return WebCryptoCipherStatus::FAILED;
  }
  if (!ctx.setKeyLength(key_data.GetSymmetricKeySize()) ||
      !ctx.init(Cipher(), encrypt, reinterpret_cast<const unsigned char*>(key_data.GetSymmetricKey()),
                params.iv.data<unsigned char>())) {
    return WebCryptoCipherStatus::FAILED;
  }
  size_t tag_len = 0;
  size_t data_len = in.size();
  if (params.cipher.isGcmMode() || params.cipher.isOcbMode()) {
    tag_len = params.length;
    switch (cipher_mode) {
      case kWebCryptoCipherDecrypt: {
        if (data_len < tag_len) return WebCryptoCipherStatus::FAILED;
        data_len -= tag_len;
        if (params.cipher.isOcbMode()) {
          if (!ctx.setAeadTagLength(tag_len)) return WebCryptoCipherStatus::FAILED;
        }
        ncrypto::Buffer<const char> buffer = {
            .data = in.data<char>() + data_len,
            .len = tag_len,
        };
        if (!ctx.setAeadTag(buffer)) return WebCryptoCipherStatus::FAILED;
        break;
      }
      case kWebCryptoCipherEncrypt: {
        if (params.cipher.isOcbMode()) {
          if (!ctx.setAeadTagLength(tag_len)) return WebCryptoCipherStatus::FAILED;
        }
        break;
      }
    }
  }
  size_t total = 0;
  const int block_size = ctx.getBlockSize();
  if (block_size < 0) return WebCryptoCipherStatus::FAILED;
  int buf_len;
  if (!TryGetIntCipherOutputLength(data_len, static_cast<size_t>(block_size) + (encrypt ? tag_len : 0), &buf_len)) {
    return WebCryptoCipherStatus::FAILED;
  }
  int out_len;
  ncrypto::Buffer<const unsigned char> buffer = {
      .data = params.additional_data.data<unsigned char>(),
      .len = params.additional_data.size(),
  };
  if ((params.cipher.isGcmMode() || params.cipher.isOcbMode()) && params.additional_data.size() &&
      !ctx.update(buffer, nullptr, &out_len)) {
    return WebCryptoCipherStatus::FAILED;
  }
  auto buf = DataPointer::Alloc(buf_len);
  auto ptr = static_cast<unsigned char*>(buf.get());
  buffer = {
      .data = in.data<unsigned char>(),
      .len = data_len,
  };
  if (data_len == 0) {
    out_len = 0;
  } else if (!ctx.update(buffer, ptr, &out_len)) {
    return WebCryptoCipherStatus::FAILED;
  }
  total += out_len;
  CHECK_LE(out_len, buf_len);
  out_len = block_size;
  if (!ctx.update({}, ptr + total, &out_len, true)) return WebCryptoCipherStatus::FAILED;
  total += out_len;
  if (encrypt && (params.cipher.isGcmMode() || params.cipher.isOcbMode())) {
    if (!ctx.getAeadTag(tag_len, ptr + total)) return WebCryptoCipherStatus::FAILED;
    total += tag_len;
  }
  if (total == 0) {
    *out = ByteSource::Allocated(nullptr, 0);
    return WebCryptoCipherStatus::OK;
  }
  buf = buf.resize(total);
  *out = ByteSource::Allocated(buf.release());
  return WebCryptoCipherStatus::OK;
}

// CeilDiv, GetCounter, BlockWithZeroedCounter, AES_CTR_Cipher2, AES_CTR_Cipher (277-450).
template <typename T>
T CeilDiv(T a, T b) {
  return a == 0 ? 0 : 1 + (a - 1) / b;
}

BignumPointer GetCounter(const AESCipherConfig& params) {
  unsigned int remainder = (params.length % CHAR_BIT);
  const unsigned char* data = params.iv.data<unsigned char>();
  if (remainder == 0) {
    unsigned int byte_length = params.length / CHAR_BIT;
    return BignumPointer(data + params.iv.size() - byte_length, byte_length);
  }
  unsigned int byte_length = CeilDiv(params.length, static_cast<size_t>(CHAR_BIT));
  std::vector<unsigned char> counter(data + params.iv.size() - byte_length, data + params.iv.size());
  counter[0] &= ~(0xFF << remainder);
  return BignumPointer(counter.data(), counter.size());
}

std::vector<unsigned char> BlockWithZeroedCounter(const AESCipherConfig& params) {
  unsigned int length_bytes = params.length / CHAR_BIT;
  unsigned int remainder = params.length % CHAR_BIT;
  const unsigned char* data = params.iv.data<unsigned char>();
  std::vector<unsigned char> new_counter_block(data, data + params.iv.size());
  size_t index = new_counter_block.size() - length_bytes;
  memset(&new_counter_block.front() + index, 0, length_bytes);
  if (remainder) new_counter_block[index - 1] &= 0xFF << remainder;
  return new_counter_block;
}

WebCryptoCipherStatus AES_CTR_Cipher2(const KeyObjectData& key_data, WebCryptoCipherMode cipher_mode,
                                      const AESCipherConfig& params, const ByteSource& in,
                                      unsigned const char* counter, unsigned char* out) {
  auto ctx = CipherCtxPointer::New();
  if (!ctx) return WebCryptoCipherStatus::FAILED;
  if (!ctx.init(params.cipher, cipher_mode == kWebCryptoCipherEncrypt,
                reinterpret_cast<const unsigned char*>(key_data.GetSymmetricKey()), counter)) {
    return WebCryptoCipherStatus::FAILED;
  }
  int out_len = 0;
  int final_len = 0;
  ncrypto::Buffer<const unsigned char> buffer = {
      .data = in.data<unsigned char>(),
      .len = in.size(),
  };
  if (!ctx.update(buffer, out, &out_len) || !ctx.update({}, out + out_len, &final_len, true)) {
    return WebCryptoCipherStatus::FAILED;
  }
  return static_cast<unsigned>(out_len + final_len) != in.size() ? WebCryptoCipherStatus::FAILED
                                                                  : WebCryptoCipherStatus::OK;
}

WebCryptoCipherStatus AES_CTR_Cipher(const KeyObjectData& key_data, WebCryptoCipherMode cipher_mode,
                                     const AESCipherConfig& params, const ByteSource& in, ByteSource* out) {
  auto num_counters = BignumPointer::NewLShift(params.length);
  if (!num_counters) return WebCryptoCipherStatus::FAILED;
  BignumPointer current_counter = GetCounter(params);
  auto num_output = BignumPointer::New();
  if (!num_output.setWord(CeilDiv(in.size(), kAesBlockSize))) return WebCryptoCipherStatus::FAILED;
  if (num_output > num_counters) return WebCryptoCipherStatus::FAILED;
  auto remaining_until_reset = BignumPointer::NewSub(num_counters, current_counter);
  if (!remaining_until_reset) return WebCryptoCipherStatus::FAILED;
  auto buf = DataPointer::Alloc(in.size());
  if (remaining_until_reset >= num_output) {
    auto status = AES_CTR_Cipher2(key_data, cipher_mode, params, in, params.iv.data<unsigned char>(),
                                  static_cast<unsigned char*>(buf.get()));
    if (status == WebCryptoCipherStatus::OK) *out = ByteSource::Allocated(buf.release());
    return status;
  }
  std::optional<BN_ULONG> remaining_blocks = remaining_until_reset.getWord();
  CHECK(remaining_blocks.has_value());
  BN_ULONG input_size_part1 = remaining_blocks.value() * kAesBlockSize;
  auto status = AES_CTR_Cipher2(key_data, cipher_mode, params, ByteSource::Foreign(in.data<char>(), input_size_part1),
                                params.iv.data<unsigned char>(), static_cast<unsigned char*>(buf.get()));
  if (status != WebCryptoCipherStatus::OK) return status;
  std::vector<unsigned char> new_counter_block = BlockWithZeroedCounter(params);
  auto ptr = static_cast<unsigned char*>(buf.get()) + input_size_part1;
  status = AES_CTR_Cipher2(key_data, cipher_mode, params,
                           ByteSource::Foreign(in.data<char>() + input_size_part1, in.size() - input_size_part1),
                           new_counter_block.data(), ptr);
  if (status == WebCryptoCipherStatus::OK) *out = ByteSource::Allocated(buf.release());
  return status;
}

// AESCipherTraits::DoCipher (580-597).
WebCryptoCipherStatus DoAesCipher(const KeyObjectData& key_data, WebCryptoCipherMode cipher_mode,
                                  const AESCipherConfig& params, const ByteSource& in, ByteSource* out) {
  return params.cipher.isCtrMode() ? AES_CTR_Cipher(key_data, cipher_mode, params, in, out)
                                   : AES_Cipher(key_data, cipher_mode, params, in, out);
}

// The variants' ciphers (VARIANTS, crypto_aes.h).
const Cipher& VariantCipher(AESKeyVariant variant) {
  switch (variant) {
    case AESKeyVariant::CTR_128: return Cipher::AES_128_CTR;
    case AESKeyVariant::CTR_192: return Cipher::AES_192_CTR;
    case AESKeyVariant::CTR_256: return Cipher::AES_256_CTR;
    case AESKeyVariant::CBC_128: return Cipher::AES_128_CBC;
    case AESKeyVariant::CBC_192: return Cipher::AES_192_CBC;
    case AESKeyVariant::CBC_256: return Cipher::AES_256_CBC;
    case AESKeyVariant::GCM_128: return Cipher::AES_128_GCM;
    case AESKeyVariant::GCM_192: return Cipher::AES_192_GCM;
    case AESKeyVariant::GCM_256: return Cipher::AES_256_GCM;
    case AESKeyVariant::KW_128: return Cipher::AES_128_KW;
    case AESKeyVariant::KW_192: return Cipher::AES_192_KW;
    case AESKeyVariant::KW_256: return Cipher::AES_256_KW;
#if OPENSSL_WITH_AES_OCB
    case AESKeyVariant::OCB_128: return Cipher::AES_128_OCB;
    case AESKeyVariant::OCB_192: return Cipher::AES_192_OCB;
    case AESKeyVariant::OCB_256: return Cipher::AES_256_OCB;
#endif
  }
  abort();
}
}  // namespace

// CipherJob<AESCipherTraits>::New (crypto_cipher.h:150-181) and AESCipherTraits::AdditionalConfig (crypto_aes.cc
// 507-578, with ValidateIV, ValidateCounter, ValidateAuthTag, ValidateAdditionalData and UseDefaultIV): `args` Node's
// from its fifth (the variant, then the IV or counter, the counter's length or the tag's, the additional data).
// Null where it threw.
CRYPTO_EXPORT(tabnode_aes_cipher_job_new) CryptoJob* tabnode_aes_cipher_job_new(int32_t mode, uint32_t cipher_mode,
                                                                               const KeyObjectData* key,
                                                                               const void* data, size_t size,
                                                                               const TnValue* args, uint32_t count) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too large");
    return nullptr;
  }
  AESCipherConfig params;
  CHECK(args[0].IsUint32());
  params.variant = static_cast<AESKeyVariant>(args[0].Uint32());
  params.cipher = VariantCipher(params.variant);
  if (!params.cipher) {
    Throw("ERR_CRYPTO_UNKNOWN_CIPHER");
    return nullptr;
  }
  if (!params.cipher.isWrapMode()) {
    if (args[1].length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "iv is too big");
      return nullptr;
    }
    params.iv = args[1].Bytes();
    if (params.cipher.isCtrMode()) {
      CHECK(args[2].IsUint32());
      params.length = args[2].Uint32();
      if (params.iv.size() != 16 || params.length == 0 || params.length > 128) {
        Throw("ERR_CRYPTO_INVALID_COUNTER");
        return nullptr;
      }
    } else if (params.cipher.isGcmMode() || params.cipher.isOcbMode()) {
      if (!args[2].IsUint32()) {
        Throw("ERR_CRYPTO_INVALID_TAG_LENGTH");
        return nullptr;
      }
      params.length = args[2].Uint32();
      if (params.length > 128) {
        Throw("ERR_CRYPTO_INVALID_TAG_LENGTH");
        return nullptr;
      }
      if (args[3].IsAnyBufferSource()) {
        if (args[3].length > INT_MAX) {
          Throw("ERR_OUT_OF_RANGE", "additionalData is too big");
          return nullptr;
        }
        params.additional_data = args[3].Bytes();
      }
    }
  } else {
    params.iv = ByteSource::Foreign(kDefaultWrapIV, strlen(kDefaultWrapIV));
  }
  if (params.cipher.isOcbMode()) {
    if (params.iv.size() == 0 || params.iv.size() > 15) {
      Throw("ERR_CRYPTO_INVALID_IV");
      return nullptr;
    }
  } else if (params.iv.size() < static_cast<size_t>(params.cipher.getIvLength())) {
    Throw("ERR_CRYPTO_INVALID_IV");
    return nullptr;
  }
  return new CipherJob<AESCipherConfig>(JobMode(mode), *key, static_cast<WebCryptoCipherMode>(cipher_mode),
                                        ByteSource::CopyOf(data, size), std::move(params), DoAesCipher);
}
