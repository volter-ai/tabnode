// THE CIPHERS OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_cipher.cc, over ncrypto and OpenSSL in the program: GetCipherInfo, GetSSLCiphers, GetCiphers,
// CipherBase (createCipheriv and createDecipheriv) and PublicKeyCipher (publicEncrypt, privateDecrypt,
// privateEncrypt, publicDecrypt). Which of a CipherBase's updates the engine device answers is the binding's routing
// (src/node-lib/binding/crypto_cipher.ts); the context here is OpenSSL's, and it is set to where the device left the
// stream before OpenSSL answers again (tabnode_cipher_rechain). Every body is Node's, its V8 half removed; where it
// differs, the difference is said at the site.
#include <openssl/evp.h>
#include <openssl/rsa.h>

#include <cstring>

#include "crypto_util.h"

using ncrypto::Cipher;
using ncrypto::CipherCtxPointer;
using ncrypto::ClearErrorOnReturn;
using ncrypto::Digest;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;
using ncrypto::MarkPopErrorOnReturn;
using ncrypto::SSLCtxPointer;
using ncrypto::SSLPointer;

#define CHECK(condition) \
  if (!(condition)) abort()

namespace {
constexpr unsigned kNoAuthTagLength = static_cast<unsigned>(-1);
// A list of names as the engine reads it: each NUL-terminated, in order.
char* NameList(const std::vector<std::string>& names, size_t* length) {
  std::string joined;
  for (const auto& name : names) {
    joined.append(name);
    joined.push_back('\0');
  }
  return Copy(joined.data(), joined.size(), length);
}
}  // namespace

// GetCipherInfo (crypto_cipher.cc:41-163): `args` are Node's from its second (the name or nid, the key length to
// test, the IV length to test); the info's members, or null for undefined (an unknown cipher, a length it refuses).
CRYPTO_EXPORT(tabnode_cipher_info) char* tabnode_cipher_info(const TnValue* args, uint32_t count, size_t* length) {
  CHECK(args[0].IsString() || args[0].IsInt32());
  const auto cipher =
      args[0].IsString() ? Cipher::FromName(args[0].String().c_str()) : Cipher::FromNid(args[0].Int32());
  if (!cipher) return nullptr;
  int iv_length = cipher.getIvLength();
  int key_length = cipher.getKeyLength();
  int block_length = cipher.getBlockSize();
  auto mode_label = cipher.getModeLabel();
  auto name = cipher.getName();
  if (args[1].IsInt32() || args[2].IsInt32()) {
    auto ctx = CipherCtxPointer::New();
    if (!ctx) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to allocate cipher context");
      return nullptr;
    }
    if (!ctx.init(cipher, true)) return nullptr;
    if (args[1].IsInt32()) {
      int check_len = args[1].Int32();
      if (!ctx.setKeyLength(check_len)) return nullptr;
      key_length = check_len;
    }
    if (args[2].IsInt32()) {
      int check_len = args[2].Int32();
      if (cipher.isCcmMode()) {
        if (check_len < 7 || check_len > 13) return nullptr;
      } else if (cipher.isGcmMode()) {
        // Nothing to do.
      } else if (cipher.isOcbMode()) {
        if (!ctx.setIvLength(check_len)) return nullptr;
      } else {
        if (check_len != iv_length) return nullptr;
      }
      iv_length = check_len;
    }
  }
  TnFields info;
  if (mode_label.length()) info.String("mode", std::string(mode_label.data(), mode_label.length()));
  info.String("name", std::string(name));
  info.Number("nid", cipher.getNid());
  if (!cipher.isStreamMode()) info.Number("blockSize", block_length);
  if (iv_length != 0) info.Number("ivLength", iv_length);
  info.Number("keyLength", key_length);
  return info.Answer(length);
}

// CipherBase::GetSSLCiphers (166-188): a new SSL's ciphers, each NUL-terminated; null where it threw.
CRYPTO_EXPORT(tabnode_ssl_cipher_list) char* tabnode_ssl_cipher_list(size_t* length) {
  ClearErrorOnReturn clear_error_on_return;
  auto ctx = SSLCtxPointer::New();
  if (!ctx) {
    ThrowCrypto(clear_error_on_return.peekError(), "SSL_CTX_new");
    return nullptr;
  }
  auto ssl = SSLPointer::New(ctx);
  if (!ssl) {
    ThrowCrypto(clear_error_on_return.peekError(), "SSL_new");
    return nullptr;
  }
  std::vector<std::string> names;
  ssl.getCiphers([&](const std::string_view name) { names.emplace_back(name); });
  return NameList(names, length);
}

// CipherBase::GetCiphers (190-212).
CRYPTO_EXPORT(tabnode_cipher_list) char* tabnode_cipher_list(size_t* length) {
  std::vector<std::string> names;
  Cipher::ForEach([&](std::string_view name) { names.emplace_back(name); });
  return NameList(names, length);
}

// ---- CipherBase (214-858) ---------------------------------------------------------------------------------------

namespace {
enum CipherKind { kCipher, kDecipher };
enum AuthTagState { kAuthTagUnknown, kAuthTagSetByUser, kAuthTagComputed };
enum UpdateResult { kSuccess, kErrorMessageSize, kErrorState };
}  // namespace

// CipherBase's C++ state (crypto_cipher.h:20-95).
struct TnCipher {
  CipherCtxPointer ctx_;
  CipherKind kind_;
  AuthTagState auth_tag_state_ = kAuthTagUnknown;
  unsigned int auth_tag_len_ = kNoAuthTagLength;
  char auth_tag_[EVP_GCM_TLS_TAG_LEN];
  bool pending_auth_failed_ = false;
  int max_message_size_ = 0;

  bool IsAuthenticatedMode() const {
    CHECK(ctx_);
    return Cipher::FromCtx(ctx_).isSupportedAuthenticatedMode();
  }

  // CipherBase::CheckCCMMessageLength (486-496).
  bool CheckCCMMessageLength(int message_len) {
    CHECK(ctx_);
    CHECK(ctx_.isCcmMode());
    if (message_len > max_message_size_) {
      Throw("ERR_CRYPTO_INVALID_MESSAGELEN");
      return false;
    }
    return true;
  }

  // CipherBase::InitAuthenticated (439-484).
  bool InitAuthenticated(const char* cipher_type, int iv_len, unsigned int auth_tag_len) {
    CHECK(IsAuthenticatedMode());
    MarkPopErrorOnReturn mark_pop_error_on_return;
    if (!ctx_.setIvLength(iv_len)) {
      Throw("ERR_CRYPTO_INVALID_IV");
      return false;
    }
    if (ctx_.isCcmMode()) {
      if (kind_ == kDecipher && ncrypto::isFipsEnabled()) {
        Throw("ERR_CRYPTO_UNSUPPORTED_OPERATION", "CCM encryption not supported in FIPS mode");
        return false;
      }
      CHECK(iv_len >= 7 && iv_len <= 13);
      max_message_size_ = INT_MAX;
      if (iv_len == 12) max_message_size_ = 16777215;
      if (iv_len == 13) max_message_size_ = 65535;
    }
    if (auth_tag_len == kNoAuthTagLength) {
      if (ctx_.isGcmMode()) {
        return true;
#ifdef EVP_CHACHAPOLY_TLS_TAG_LEN
      } else if (ctx_.isChaCha20Poly1305()) {
        auth_tag_len = EVP_CHACHAPOLY_TLS_TAG_LEN;
#endif
      } else {
        Throw("ERR_CRYPTO_INVALID_AUTH_TAG", "authTagLength required for %s", cipher_type);
        return false;
      }
    } else if ((ctx_.isGcmMode() && !Cipher::IsValidGCMTagLength(auth_tag_len)) ||
               (!ctx_.isGcmMode() && !ctx_.setAeadTagLength(auth_tag_len))) {
      Throw("ERR_CRYPTO_INVALID_AUTH_TAG", "Invalid authentication tag length: %u", auth_tag_len);
      return false;
    }
    auth_tag_len_ = auth_tag_len;
    return true;
  }

  // CipherBase::CommonInit (343-388).
  void CommonInit(const char* cipher_type, const Cipher& cipher, const unsigned char* key, int key_len,
                  const unsigned char* iv, int iv_len, unsigned int auth_tag_len) {
    MarkPopErrorOnReturn mark_pop_error_on_return;
    CHECK(!ctx_);
    ctx_ = CipherCtxPointer::New();
    if (!ctx_) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to allocate cipher context");
      return;
    }
    if (cipher.isWrapMode()) ctx_.setAllowWrap();
    const bool encrypt = (kind_ == kCipher);
    if (!ctx_.init(cipher, encrypt)) {
      ThrowCrypto(mark_pop_error_on_return.peekError(), "Failed to initialize cipher");
      return;
    }
    if (cipher.isSupportedAuthenticatedMode()) {
      CHECK(iv_len >= 0);
      if (!InitAuthenticated(cipher_type, iv_len, auth_tag_len)) return;
    }
    if (!ctx_.setKeyLength(key_len)) {
      ctx_.reset();
      Throw("ERR_CRYPTO_INVALID_KEYLEN");
      return;
    }
    if (!ctx_.init(Cipher(), encrypt, key, iv)) {
      ThrowCrypto(mark_pop_error_on_return.peekError(), "Failed to initialize cipher");
      return;
    }
  }

  // CipherBase::InitIv (390-437).
  void InitIv(const char* cipher_type, const ByteSource& key_buf, const unsigned char* iv, size_t iv_size,
              unsigned int auth_tag_len) {
    MarkPopErrorOnReturn mark_pop_error_on_return;
    auto cipher = Cipher::FromName(cipher_type);
    if (!cipher) {
      Throw("ERR_CRYPTO_UNKNOWN_CIPHER");
      return;
    }
    const int expected_iv_len = cipher.getIvLength();
    const bool has_iv = iv_size > 0;
    if (!has_iv && expected_iv_len != 0) {
      Throw("ERR_CRYPTO_INVALID_IV");
      return;
    }
    if (!cipher.isSupportedAuthenticatedMode() && has_iv && static_cast<int>(iv_size) != expected_iv_len) {
      Throw("ERR_CRYPTO_INVALID_IV");
      return;
    }
    if (cipher.isChaCha20Poly1305()) {
      CHECK(has_iv);
      if (iv_size > 12) {
        Throw("ERR_CRYPTO_INVALID_IV");
        return;
      }
    }
    CommonInit(cipher_type, cipher, key_buf.data<unsigned char>(), key_buf.size(), iv, iv_size, auth_tag_len);
  }

  // CipherBase::Update (618-680): the bytes in a malloc'd buffer at *out, their length in *out_len.
  UpdateResult Update(const char* data, size_t len, char** out, size_t* out_len) {
    if (!ctx_ || len > INT_MAX) return kErrorState;
    MarkPopErrorOnReturn mark_pop_error_on_return;
    if (ctx_.isCcmMode() && !CheckCCMMessageLength(len)) return kErrorMessageSize;
    const int block_size = ctx_.getBlockSize();
    CHECK(block_size > 0);
    if (len + block_size > INT_MAX) return kErrorState;
    int buf_len = len + block_size;
    ncrypto::Buffer<const unsigned char> buffer = {
        .data = reinterpret_cast<const unsigned char*>(data),
        .len = len,
    };
    if (kind_ == kCipher && ctx_.isWrapMode() && !ctx_.update(buffer, nullptr, &buf_len)) return kErrorState;
    unsigned char* bytes = static_cast<unsigned char*>(malloc(buf_len > 0 ? buf_len : 1));
    if (bytes == nullptr) abort();
    bool r = ctx_.update(buffer, bytes, &buf_len);
    *out = reinterpret_cast<char*>(bytes);
    *out_len = buf_len;
    if (!r && kind_ == kDecipher && ctx_.isCcmMode()) {
      pending_auth_failed_ = true;
      return kSuccess;
    }
    return r == 1 ? kSuccess : kErrorState;
  }

  // CipherBase::Final (734-806).
  bool Final(char** out, size_t* out_len) {
    if (!ctx_) return false;
    const int block_size = ctx_.getBlockSize();
    unsigned char* bytes = static_cast<unsigned char*>(malloc(block_size > 0 ? block_size : 1));
    if (bytes == nullptr) abort();
    *out = reinterpret_cast<char*>(bytes);
    *out_len = 0;
    bool ok;
    if (kind_ == kDecipher && ctx_.isCcmMode()) {
      ok = !pending_auth_failed_;
    } else {
      int out_length = block_size;
      ok = ctx_.update({}, bytes, &out_length, true);
      *out_len = out_length;
      if (ok && kind_ == kCipher && IsAuthenticatedMode()) {
        if (auth_tag_len_ == kNoAuthTagLength) {
          CHECK(ctx_.isGcmMode());
          auth_tag_len_ = EVP_GCM_TLS_TAG_LEN;
        }
        ok = ctx_.getAeadTag(auth_tag_len_, reinterpret_cast<unsigned char*>(auth_tag_));
        if (ok) auth_tag_state_ = kAuthTagComputed;
      }
    }
    ctx_.reset();
    return ok;
  }
};

// CipherBase::New (300-341): `cipher` 1 for a Cipher, 0 for a Decipher; the key is a handle's (`key`) or bytes; the
// IV `iv_size` bytes at `iv` (Node's null IV is none); `auth_tag_len` Node's, -1 for none. Null where it threw.
CRYPTO_EXPORT(tabnode_cipher_new) TnCipher* tabnode_cipher_new(int cipher, const char* cipher_type,
                                                              const KeyObjectData* key, const void* key_bytes,
                                                              size_t key_size, const void* iv, size_t iv_size,
                                                              int64_t auth_tag_len) {
  auto* base = new TnCipher();
  base->kind_ = cipher ? kCipher : kDecipher;
  // ByteSource::FromSecretKeyBytes: a handle's secret, or the bytes.
  const ByteSource key_buf = key != nullptr
                                 ? ByteSource::Foreign(key->GetSymmetricKey(), key->GetSymmetricKeySize())
                                 : ByteSource::CopyOf(key_bytes, key_size);
  if (key_buf.size() > INT_MAX) {
    delete base;
    Throw("ERR_OUT_OF_RANGE", "key is too big");
    return nullptr;
  }
  if (iv_size > INT_MAX) {
    delete base;
    Throw("ERR_OUT_OF_RANGE", "iv is too big");
    return nullptr;
  }
  unsigned int tag_len;
  if (auth_tag_len >= 0) {
    tag_len = static_cast<unsigned int>(auth_tag_len);
  } else {
    CHECK(auth_tag_len == -1);
    tag_len = kNoAuthTagLength;
  }
  base->InitIv(cipher_type, key_buf, static_cast<const unsigned char*>(iv), iv_size, tag_len);
  // Node's object exists whatever InitIv threw; the engine throws the error and never hands the object out.
  if (HasThrown()) {
    delete base;
    return nullptr;
  }
  return base;
}
CRYPTO_EXPORT(tabnode_cipher_free) void tabnode_cipher_free(TnCipher* base) { delete base; }

// CipherBase::Update (682-711): the bytes, or null where it threw (a message too long for CCM is its own error; an
// unsupported state is ThrowCryptoError's).
CRYPTO_EXPORT(tabnode_cipher_update) char* tabnode_cipher_update(TnCipher* base, const char* data, size_t size,
                                                                size_t* length) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too long");
    return nullptr;
  }
  char* out = nullptr;
  UpdateResult r = base->Update(data, size, &out, length);
  if (r != kSuccess) {
    free(out);
    if (r == kErrorState) ThrowCrypto(mark_pop_error_on_return.peekError(), "Trying to add data in unsupported state");
    return nullptr;
  }
  return out;
}

// CipherBase::SetAutoPadding (713-729).
CRYPTO_EXPORT(tabnode_cipher_set_auto_padding) int tabnode_cipher_set_auto_padding(TnCipher* base,
                                                                                  int auto_padding) {
  if (!base->ctx_) return 0;
  MarkPopErrorOnReturn mark_pop_error_on_return;
  return base->ctx_.setPadding(auto_padding != 0) ? 1 : 0;
}

// CipherBase::Final (808-833): null where it threw.
CRYPTO_EXPORT(tabnode_cipher_final) char* tabnode_cipher_final(TnCipher* base, size_t* length) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  if (!base->ctx_) {
    Throw("ERR_CRYPTO_INVALID_STATE");
    return nullptr;
  }
  const bool is_auth_mode = base->IsAuthenticatedMode();
  char* out = nullptr;
  if (!base->Final(&out, length)) {
    free(out);
    ThrowCrypto(mark_pop_error_on_return.peekError(),
                is_auth_mode ? "Unsupported state or unable to authenticate data" : "Unsupported state");
    return nullptr;
  }
  return out;
}

// CipherBase::GetAuthTag (500-518): the tag, or null for undefined.
CRYPTO_EXPORT(tabnode_cipher_get_auth_tag) char* tabnode_cipher_get_auth_tag(TnCipher* base, size_t* length) {
  if (base->ctx_ || base->kind_ != kCipher || base->auth_tag_len_ == kNoAuthTagLength ||
      base->auth_tag_state_ != kAuthTagComputed) {
    return nullptr;
  }
  return Copy(base->auth_tag_, base->auth_tag_len_, length);
}

// CipherBase::SetAuthTag (520-569): 1 true, 0 false, -1 where it threw; `*deprecated` 1 where Node emits DEP0182
// (ProcessEmitDeprecationWarning), which the engine emits before it answers.
CRYPTO_EXPORT(tabnode_cipher_set_auth_tag) int tabnode_cipher_set_auth_tag(TnCipher* base, const char* tag,
                                                                          size_t size, int* deprecated) {
  *deprecated = 0;
  if (!base->ctx_ || !base->IsAuthenticatedMode() || base->kind_ != kDecipher ||
      base->auth_tag_state_ != kAuthTagUnknown) {
    return 0;
  }
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "buffer is too big");
    return -1;
  }
  unsigned int tag_len = size;
  bool is_valid;
  if (base->ctx_.isGcmMode()) {
    is_valid = (base->auth_tag_len_ == kNoAuthTagLength || base->auth_tag_len_ == tag_len) &&
               Cipher::IsValidGCMTagLength(tag_len);
  } else {
    CHECK(base->auth_tag_len_ != kNoAuthTagLength);
    is_valid = base->auth_tag_len_ == tag_len;
  }
  if (!is_valid) {
    Throw("ERR_CRYPTO_INVALID_AUTH_TAG", "Invalid authentication tag length: %u", tag_len);
    return -1;
  }
  if (base->ctx_.isGcmMode() && base->auth_tag_len_ == kNoAuthTagLength && tag_len != EVP_GCM_TLS_TAG_LEN) {
    *deprecated = 1;
  }
  base->auth_tag_len_ = tag_len;
  CHECK(base->auth_tag_len_ <= Cipher::MAX_AUTH_TAG_LENGTH);
  if (!base->ctx_.setAeadTag({tag, base->auth_tag_len_})) return 0;
  base->auth_tag_state_ = kAuthTagSetByUser;
  return 1;
}

// CipherBase::SetAAD (571-616): 1 true, 0 false, -1 where it threw.
CRYPTO_EXPORT(tabnode_cipher_set_aad) int tabnode_cipher_set_aad(TnCipher* base, const unsigned char* data,
                                                                size_t size, int32_t plaintext_len) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "buffer is too big");
    return -1;
  }
  if (!base->ctx_ || !base->IsAuthenticatedMode()) return 0;
  MarkPopErrorOnReturn mark_pop_error_on_return;
  int outlen;
  if (base->ctx_.isCcmMode()) {
    if (plaintext_len < 0) {
      Throw("ERR_MISSING_ARGS", "options.plaintextLength required for CCM mode with AAD");
      return -1;
    }
    if (!base->CheckCCMMessageLength(plaintext_len)) return -1;
    ncrypto::Buffer<const unsigned char> buffer{.data = nullptr, .len = static_cast<size_t>(plaintext_len)};
    if (!base->ctx_.update(buffer, nullptr, &outlen)) return 0;
  }
  ncrypto::Buffer<const unsigned char> buffer{.data = data, .len = size};
  return base->ctx_.update(buffer, nullptr, &outlen) ? 1 : 0;
}

// ---- What the engine device's answers take (ADR-0018 §5) --------------------------------------------------------

// The device's algorithm for a cipher, by its name (Cipher::FromName): 1 AES-CBC, 2 AES-CTR, each of a 128- or a
// 256-bit key; 0 for every other cipher (ADR-0018 §5).
CRYPTO_EXPORT(tabnode_cipher_device_kind) int tabnode_cipher_device_kind(const char* cipher_type) {
  auto cipher = Cipher::FromName(cipher_type);
  if (!cipher) return 0;
  switch (cipher.getNid()) {
    case NID_aes_128_cbc:
    case NID_aes_256_cbc:
      return 1;
    case NID_aes_128_ctr:
    case NID_aes_256_ctr:
      return 2;
    default:
      return 0;
  }
}
// Whether the cipher pads (the context's EVP_CIPH_NO_PADDING flag is clear), which the device's CBC reads.
CRYPTO_EXPORT(tabnode_cipher_pads) int tabnode_cipher_pads(TnCipher* base) {
  if (!base->ctx_) return 0;
  return (EVP_CIPHER_CTX_test_flags(base->ctx_.get(), EVP_CIPH_NO_PADDING) == 0) ? 1 : 0;
}
// The stream continued in OpenSSL where the device left it: the context started again with the stream's next IV
// (CBC's last ciphertext block, CTR's next counter block) and the key it holds (EVP_CipherInit_ex with no cipher and
// no key keeps both and the padding, and empties the context's partial block). 1, or 0 where OpenSSL refused it.
CRYPTO_EXPORT(tabnode_cipher_rechain) int tabnode_cipher_rechain(TnCipher* base, const unsigned char* iv) {
  if (!base->ctx_) return 0;
  return base->ctx_.init(Cipher(), base->kind_ == kCipher, nullptr, iv) ? 1 : 0;
}

// ---- PublicKeyCipher (835-927) ----------------------------------------------------------------------------------

namespace {
using Cipher_t = ncrypto::DataPointer (*)(const EVPKeyPointer&, const Cipher::CipherParams&,
                                          const ncrypto::Buffer<const void>);
}  // namespace

// PublicKeyCipher::Cipher<operation, cipher> (861-925): `operation` 0 publicEncrypt, 1 privateDecrypt, 2
// privateEncrypt, 3 publicDecrypt; `args` Node's (the key's slots, the buffer, the padding, the OAEP digest and
// label). Null where it threw.
CRYPTO_EXPORT(tabnode_public_key_cipher) char* tabnode_public_key_cipher(int operation, const TnValue* args,
                                                                        uint32_t count, size_t* length) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  static const Cipher_t ciphers[] = {Cipher::encrypt, Cipher::decrypt, Cipher::sign, Cipher::recover};
  const bool is_private = operation == 1 || operation == 2;
  const Cipher_t cipher = ciphers[operation];
  unsigned int offset = 0;
  auto data = KeyObjectData::GetPublicOrPrivateKey(args, &offset, is_private);
  if (!data) return nullptr;
  const auto& pkey = data.GetAsymmetricKey();
  if (!pkey) return nullptr;
  const TnValue& buf = args[offset];
  if (buf.length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "buffer is too long");
    return nullptr;
  }
  uint32_t padding = static_cast<uint32_t>(args[offset + 1].number);
  if (operation == 1 && padding == RSA_PKCS1_PADDING) {
    EVPKeyCtxPointer ctx = pkey.newCtx();
    CHECK(ctx);
    if (!ctx.initForDecrypt()) {
      ThrowCrypto(ERR_get_error());
      return nullptr;
    }
    if (!ctx.setRsaImplicitRejection()) {
      Throw("ERR_INVALID_ARG_VALUE", "RSA_PKCS1_PADDING is no longer supported for private decryption");
      return nullptr;
    }
  }
  Digest digest;
  if (args[offset + 2].IsString()) {
    std::string oaep_str = args[offset + 2].String();
    digest = Digest::FromName(oaep_str.c_str());
    if (!digest) {
      Throw("ERR_OSSL_EVP_INVALID_DIGEST");
      return nullptr;
    }
  }
  const TnValue& label_value = args[offset + 3];
  if (!label_value.IsUndefined() && label_value.length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "oaepLabel is too big");
    return nullptr;
  }
  ByteSource label = label_value.IsUndefined() ? ByteSource() : label_value.Bytes();
  ByteSource in = buf.Bytes();
  const Cipher::CipherParams params{
      .padding = static_cast<int>(padding),
      .digest = digest,
      .label = label,
  };
  auto out = cipher(pkey, params, in);
  if (!out) {
    ThrowCrypto(ERR_get_error());
    return nullptr;
  }
  return Copy(static_cast<const char*>(out.get()), out.size(), length);
}
