// ChaCha20-Poly1305 OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_chacha20_poly1305.cc, over ncrypto and OpenSSL in the program: ChaCha20Poly1305CipherJob. WebCrypto
// defines no ChaCha20-Poly1305, so it is OpenSSL's. The body is Node's OpenSSL branch, unchanged but for CHECK.
#include "crypto_util.h"

using ncrypto::Cipher;
using ncrypto::CipherCtxPointer;
using ncrypto::DataPointer;

#define CHECK(condition) \
  if (!(condition)) abort()

namespace {
constexpr size_t kChaCha20Poly1305KeySize = 32;
constexpr size_t kChaCha20Poly1305IvSize = 12;
constexpr size_t kChaCha20Poly1305TagSize = 16;

// ChaCha20Poly1305CipherConfig (crypto_chacha20_poly1305.h).
struct ChaCha20Poly1305CipherConfig {
  Cipher cipher;
  ByteSource iv;
  ByteSource additional_data;
  ChaCha20Poly1305CipherConfig() = default;
  // Its move (crypto_chacha20_poly1305.cc): a Cipher copies and does not move.
  ChaCha20Poly1305CipherConfig(ChaCha20Poly1305CipherConfig&& other) noexcept
      : cipher(other.cipher), iv(std::move(other.iv)), additional_data(std::move(other.additional_data)) {}
};

// ChaCha20Poly1305CipherTraits::DoCipher (151-336), OpenSSL's branch.
WebCryptoCipherStatus DoChaCha(const KeyObjectData& key_data, WebCryptoCipherMode cipher_mode,
                               const ChaCha20Poly1305CipherConfig& params, const ByteSource& in, ByteSource* out) {
  CHECK(key_data.GetKeyType() == kKeyTypeSecret);
  if (key_data.GetSymmetricKeySize() != kChaCha20Poly1305KeySize) return WebCryptoCipherStatus::INVALID_KEY_TYPE;
  auto ctx = CipherCtxPointer::New();
  if (!ctx) return WebCryptoCipherStatus::FAILED;
  const bool encrypt = cipher_mode == kWebCryptoCipherEncrypt;
  if (!ctx.init(params.cipher, encrypt)) return WebCryptoCipherStatus::FAILED;
  if (!ctx.setKeyLength(key_data.GetSymmetricKeySize()) ||
      !ctx.init(Cipher(), encrypt, reinterpret_cast<const unsigned char*>(key_data.GetSymmetricKey()),
                params.iv.data<unsigned char>())) {
    return WebCryptoCipherStatus::FAILED;
  }
  size_t tag_len = kChaCha20Poly1305TagSize;
  size_t data_len = in.size();
  if (cipher_mode == kWebCryptoCipherDecrypt) {
    if (data_len < tag_len) return WebCryptoCipherStatus::FAILED;
    data_len -= tag_len;
    if (!ctx.setAeadTag(ncrypto::Buffer<const char>{
            .data = in.data<char>() + data_len,
            .len = tag_len,
        })) {
      return WebCryptoCipherStatus::FAILED;
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
  if (params.additional_data.size() && !ctx.update(buffer, nullptr, &out_len)) return WebCryptoCipherStatus::FAILED;
  auto buf = DataPointer::Alloc(buf_len);
  auto ptr = static_cast<unsigned char*>(buf.get());
  buffer = {
      .data = in.data<unsigned char>(),
      .len = data_len,
  };
  if (data_len == 0) {
    if (!ctx.update({}, ptr, &out_len)) return WebCryptoCipherStatus::FAILED;
  } else if (!ctx.update(buffer, ptr, &out_len)) {
    return WebCryptoCipherStatus::FAILED;
  }
  total += out_len;
  CHECK(out_len <= buf_len);
  out_len = block_size;
  if (!ctx.update({}, ptr + total, &out_len, true)) return WebCryptoCipherStatus::FAILED;
  total += out_len;
  if (encrypt) {
    if (!ctx.getAeadTag(kChaCha20Poly1305TagSize, ptr + total)) return WebCryptoCipherStatus::FAILED;
    total += kChaCha20Poly1305TagSize;
  }
  if (total == 0) {
    *out = ByteSource();
    return WebCryptoCipherStatus::OK;
  }
  buf = buf.resize(total);
  *out = ByteSource::Allocated(buf.release());
  return WebCryptoCipherStatus::OK;
}
}  // namespace

// CipherJob<ChaCha20Poly1305CipherTraits>::New and ChaCha20Poly1305CipherTraits::AdditionalConfig (24-149, with
// ValidateIV and ValidateAdditionalData): `args` Node's from its fifth (the IV, the additional data). Null where it
// threw.
CRYPTO_EXPORT(tabnode_chacha20_poly1305_job_new) CryptoJob* tabnode_chacha20_poly1305_job_new(
    int32_t mode, uint32_t cipher_mode, const KeyObjectData* key, const void* data, size_t size, const TnValue* args,
    uint32_t count) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too large");
    return nullptr;
  }
  ChaCha20Poly1305CipherConfig params;
  params.cipher = Cipher::CHACHA20_POLY1305;
  if (!params.cipher) {
    Throw("ERR_CRYPTO_UNKNOWN_CIPHER");
    return nullptr;
  }
  if (args[0].length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "iv is too large");
    return nullptr;
  }
  if (args[0].length != kChaCha20Poly1305IvSize) {
    Throw("ERR_CRYPTO_INVALID_IV");
    return nullptr;
  }
  params.iv = args[0].Bytes();
  if (count > 1 && args[1].IsAnyBufferSource()) {
    if (args[1].length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "additional data is too large");
      return nullptr;
    }
    params.additional_data = args[1].Bytes();
  }
  return new CipherJob<ChaCha20Poly1305CipherConfig>(JobMode(mode), *key,
                                                      static_cast<WebCryptoCipherMode>(cipher_mode),
                                                      ByteSource::CopyOf(data, size), std::move(params), DoChaCha);
}
