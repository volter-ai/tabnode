// THE KEYS OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_keys.cc, over ncrypto and OpenSSL in libnode.so. KeyObjectData and the key arguments' five slots
// (GetPrivateKeyFromJs, GetPublicOrPrivateKeyFromJs, the encodings), and KeyObjectHandle's methods. A handle is a
// KeyObjectData* the engine's KeyObjectHandle holds (one reference, freed with it). NativeKeyObject and
// NativeCryptoKey hold no OpenSSL state of their own (only a handle's data and V8 values), so they are the engine's
// (src/node-lib/binding/crypto_keys.ts).
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/rsa.h>
#include <openssl/x509v3.h>

#include <cstring>
#include <string>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::BIOPointer;
using ncrypto::ECKeyPointer;
using ncrypto::ECPointPointer;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;
using ncrypto::MarkPopErrorOnReturn;
using ncrypto::PKCS8Pointer;

namespace {
bool StringEqualNoCase(const char* a, const char* b) {
  while (tolower(*a) == tolower(*b++)) {
    if (*a++ == '\0') return true;
  }
  return false;
}

// GetKeyFormatAndTypeFromJs (54-96).
bool GetKeyFormatAndType(const TnValue* args, unsigned int* offset, KeyEncodingContext context,
                         EVPKeyPointer::AsymmetricKeyEncodingConfig* config) {
  if (args[*offset].IsUndefined()) {
    if (context != kKeyContextGenerate || !args[*offset + 1].IsUndefined()) abort();
    config->output_key_object = true;
  } else {
    config->output_key_object = false;
    if (!args[*offset].IsInt32()) abort();
    config->format = static_cast<EVPKeyPointer::PKFormatType>(args[*offset].Int32());
    if (config->format == EVPKeyPointer::PKFormatType::RAW_PUBLIC ||
        config->format == EVPKeyPointer::PKFormatType::RAW_PRIVATE ||
        config->format == EVPKeyPointer::PKFormatType::RAW_SEED) {
      if (args[*offset + 1].IsInt32()) {
        config->ec_point_form = args[*offset + 1].Int32();
      } else if (!args[*offset + 1].IsNullOrUndefined()) {
        abort();
      }
    } else if (args[*offset + 1].IsInt32()) {
      config->type = static_cast<EVPKeyPointer::PKEncodingType>(args[*offset + 1].Int32());
    } else {
      if (!((context == kKeyContextInput && config->format == EVPKeyPointer::PKFormatType::PEM) ||
            (context == kKeyContextGenerate && config->format == EVPKeyPointer::PKFormatType::JWK)) ||
          !args[*offset + 1].IsNullOrUndefined()) {
        abort();
      }
      config->type = EVPKeyPointer::PKEncodingType::PKCS1;
    }
  }
  *offset += 2;
  return true;
}

// ToV8Value (98-121): a PEM's text or a DER's bytes, out of the BIO.
bool ToByteSource(const BIOPointer& bio, ByteSource* out) {
  if (!bio) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Invalid BIO pointer");
    return false;
  }
  BUF_MEM* bptr = bio;
  if (!bptr) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Unable to create BUF_MEM pointer");
    return false;
  }
  *out = ByteSource::FromBIO(bio);
  return true;
}

// WritePrivateKey, WritePublicKey (123-147).
bool WritePrivateKey(const EVPKeyPointer& pkey, const EVPKeyPointer::PrivateKeyEncodingConfig& config,
                     ByteSource* out) {
  if (!pkey) return false;
  auto res = pkey.writePrivateKey(config);
  if (res) return ToByteSource(res.value, out);
  ThrowCrypto(res.openssl_error.value_or(0), "Failed to encode private key");
  return false;
}
bool WritePublicKey(const EVPKeyPointer& pkey, const EVPKeyPointer::PublicKeyEncodingConfig& config,
                    ByteSource* out) {
  if (!pkey) return false;
  auto res = pkey.writePublicKey(config);
  if (res) return ToByteSource(res.value, out);
  ThrowCrypto(res.openssl_error.value_or(0), "Failed to encode public key");
  return false;
}

// ExportJWKSecretKey, ImportJWKSecretKey (149-179).
bool ExportJWKSecretKey(const KeyObjectData& key, TnFields* target) {
  target->String("kty", "oct");
  target->Base64Url("k", key.GetSymmetricKey(), key.GetSymmetricKeySize());
  return true;
}
KeyObjectData ImportJWKSecretKey(const TnValue& jwk) {
  const TnValue& key = jwk.Get("k");
  if (!key.IsString()) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK secret key format");
    return {};
  }
  return KeyObjectData::CreateSecret(key.Decoded());
}

// ExportJWKAsymmetricKey (181-206).
bool ExportJWKAsymmetricKey(const KeyObjectData& key, TnFields* target, bool handleRsaPss) {
  const int id = key.GetAsymmetricKey().id();
#if OPENSSL_WITH_PQC
  if (IsPqcKeyId(id)) return ExportJwkPqcKey(key, target);
#endif
  switch (id) {
    case EVP_PKEY_RSA_PSS:
      if (handleRsaPss) return ExportJWKRsaKey(key, target);
      break;
    case EVP_PKEY_RSA:
      return ExportJWKRsaKey(key, target);
    case EVP_PKEY_EC:
      return ExportJWKEcKey(key, target);
    case EVP_PKEY_ED25519:
    case EVP_PKEY_ED448:
    case EVP_PKEY_X25519:
    case EVP_PKEY_X448:
      return ExportJWKEdKey(key, target);
  }
  Throw("ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE");
  return false;
}

// GetSecretKeyDetail, GetAsymmetricKeyDetail (208-241).
bool GetSecretKeyDetail(const KeyObjectData& key, TnFields* target) {
  target->Number("length", static_cast<double>(key.GetSymmetricKeySize() * CHAR_BIT));
  return true;
}
bool GetAsymmetricKeyDetail(const KeyObjectData& key, TnFields* target) {
  if (!key) {
    Throw("ERR_CRYPTO_OPERATION_FAILED");
    return false;
  }
  switch (key.GetAsymmetricKey().id()) {
    case EVP_PKEY_RSA:
    case EVP_PKEY_RSA2:
    case EVP_PKEY_RSA_PSS:
      return GetRsaKeyDetail(key, target);
    case EVP_PKEY_DSA:
      return GetDsaKeyDetail(key, target);
    case EVP_PKEY_EC:
      return GetEcKeyDetail(key, target);
    case EVP_PKEY_DH:
      return GetDhKeyDetail(key, target);
  }
  Throw("ERR_CRYPTO_INVALID_KEYTYPE");
  return false;
}

// TryParsePrivateKey (243-260).
KeyObjectData TryParsePrivateKey(const EVPKeyPointer::PrivateKeyEncodingConfig& config,
                                 const ncrypto::Buffer<const unsigned char>& buffer) {
  auto res = EVPKeyPointer::TryParsePrivateKey(config, buffer);
  if (res) return KeyObjectData::CreateAsymmetric(kKeyTypePrivate, std::move(res.value));
  if (res.error.value() == EVPKeyPointer::PKParseError::NEED_PASSPHRASE) {
    Throw("ERR_MISSING_PASSPHRASE", "Passphrase required for encrypted key");
  } else {
    ThrowCrypto(res.openssl_error.value_or(0), "Failed to read private key");
  }
  return {};
}

// GetNidFromName (272-290).
int GetNidFromName(const char* name) {
  static constexpr struct {
    const char* name;
    int nid;
  } kNameToNid[] = {
      {"Ed25519", EVP_PKEY_ED25519},
      {"Ed448", EVP_PKEY_ED448},
      {"X25519", EVP_PKEY_X25519},
      {"X448", EVP_PKEY_X448},
  };
  for (const auto& entry : kNameToNid) {
    if (StringEqualNoCase(name, entry.name)) return entry.nid;
  }
#if OPENSSL_WITH_PQC
  return GetPqcNidFromName(name);
#else
  return NID_undef;
#endif
}

// IsUnavailablePqcKeyType, IsUnsupportedRawKeyType (292-318).
bool IsUnavailablePqcKeyType(const std::string& key_type) {
  static constexpr const char* kNames[] = {
      "ml-dsa-44", "ml-dsa-65", "ml-dsa-87", "ml-kem-512", "ml-kem-768", "ml-kem-1024",
      "slh-dsa-sha2-128f", "slh-dsa-sha2-128s", "slh-dsa-sha2-192f", "slh-dsa-sha2-192s", "slh-dsa-sha2-256f",
      "slh-dsa-sha2-256s", "slh-dsa-shake-128f", "slh-dsa-shake-128s", "slh-dsa-shake-192f", "slh-dsa-shake-192s",
      "slh-dsa-shake-256f", "slh-dsa-shake-256s"};
  for (const char* name : kNames) {
    if (key_type == name) return true;
  }
  return false;
}
bool IsUnsupportedRawKeyType(const std::string& key_type) {
  return key_type == "rsa" || key_type == "rsa-pss" || key_type == "dsa" || key_type == "dh";
}

// ValidateRawKeyImportFormat (320-370).
void ValidateRawKeyImportFormat(const std::string& key_type, int id, EVPKeyPointer::PKFormatType format) {
  auto validate_raw_format = [&](EVPKeyPointer::PKFormatType expected_private_format) {
    if (format == EVPKeyPointer::PKFormatType::RAW_PUBLIC || format == expected_private_format) return;
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
  };
  if (key_type == "ec") return validate_raw_format(EVPKeyPointer::PKFormatType::RAW_PRIVATE);
  switch (id) {
    case EVP_PKEY_X25519:
    case EVP_PKEY_X448:
    case EVP_PKEY_ED25519:
    case EVP_PKEY_ED448:
      return validate_raw_format(EVPKeyPointer::PKFormatType::RAW_PRIVATE);
    default:
      break;
  }
#if OPENSSL_WITH_PQC
  if (IsPqcSeedKeyId(id)) return validate_raw_format(EVPKeyPointer::PKFormatType::RAW_SEED);
  if (IsPqcRawPrivateKeyId(id)) return validate_raw_format(EVPKeyPointer::PKFormatType::RAW_PRIVATE);
#endif
  if (IsUnavailablePqcKeyType(key_type)) {
    Throw("ERR_INVALID_ARG_VALUE", "Unsupported key type");
    return;
  }
  if (IsUnsupportedRawKeyType(key_type)) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return;
  }
  Throw("ERR_INVALID_ARG_VALUE", "Invalid asymmetricKeyType: %s", key_type.c_str());
}

// ImportRawKey (580-700).
KeyObjectData ImportRawKey(const unsigned char* key_data, size_t key_data_len, EVPKeyPointer::PKFormatType format,
                           const std::string& key_type, const char* named_curve, KeyType target_type) {
  auto throw_invalid = [&]() {
    if (!HasThrown()) Throw("ERR_INVALID_ARG_VALUE", "Invalid key data");
  };
  const int id = GetNidFromName(key_type.c_str());
  ValidateRawKeyImportFormat(key_type, id, format);
  if (HasThrown()) return {};
  if (key_type == "ec") {
    int curve_nid = ncrypto::Ec::GetCurveIdFromName(named_curve);
    if (curve_nid == NID_undef) {
      Throw("ERR_CRYPTO_INVALID_CURVE");
      return {};
    }
    auto eckey = ECKeyPointer::NewByCurveName(curve_nid);
    if (!eckey) {
      throw_invalid();
      return {};
    }
    if (format == EVPKeyPointer::PKFormatType::RAW_PUBLIC) {
      const auto group = eckey.getGroup();
      auto pub = ECPointPointer::New(group);
      if (!pub) {
        throw_invalid();
        return {};
      }
      ncrypto::Buffer<const unsigned char> buffer{.data = key_data, .len = key_data_len};
      if (!pub.setFromBuffer(buffer, group) || !eckey.setPublicKey(pub)) {
        throw_invalid();
        return {};
      }
    } else {
      const auto group = eckey.getGroup();
      auto order = BignumPointer::New();
      if (!order || !EC_GROUP_get_order(group, order.get(), nullptr)) abort();
      if (key_data_len != order.byteLength()) {
        throw_invalid();
        return {};
      }
      BignumPointer priv_bn(key_data, key_data_len);
      if (!priv_bn || !eckey.setPrivateKey(priv_bn)) {
        throw_invalid();
        return {};
      }
      auto pub_point = ECPointPointer::New(group);
      if (!pub_point || !pub_point.mul(group, priv_bn.get()) || !eckey.setPublicKey(pub_point)) {
        throw_invalid();
        return {};
      }
    }
    auto pkey = EVPKeyPointer::New();
    if (!pkey.assign(eckey)) {
      throw_invalid();
      return {};
    }
#if NCRYPTO_USE_LEGACY_KEY_TYPES
    eckey.release();
#endif
    return KeyObjectData::CreateAsymmetric(target_type, std::move(pkey));
  }
  typedef EVPKeyPointer (*new_key_fn)(int, const ncrypto::Buffer<const unsigned char>&);
  new_key_fn fn = nullptr;
  switch (id) {
    case EVP_PKEY_X25519:
    case EVP_PKEY_X448:
    case EVP_PKEY_ED25519:
    case EVP_PKEY_ED448:
      fn = target_type == kKeyTypePrivate ? EVPKeyPointer::NewRawPrivate : EVPKeyPointer::NewRawPublic;
      break;
    default:
#if OPENSSL_WITH_PQC
      if (IsPqcKeyId(id)) {
        if (target_type == kKeyTypePrivate) {
          fn = IsPqcSeedKeyId(id) ? EVPKeyPointer::NewRawSeed : EVPKeyPointer::NewRawPrivate;
        } else {
          fn = EVPKeyPointer::NewRawPublic;
        }
      }
#endif
      break;
  }
  if (fn != nullptr) {
    auto pkey = fn(id, ncrypto::Buffer<const unsigned char>{.data = key_data, .len = key_data_len});
    if (!pkey) {
      throw_invalid();
      return {};
    }
    return KeyObjectData::CreateAsymmetric(target_type, std::move(pkey));
  }
  return {};
}

// ImportJWKFromArgs (702-732).
KeyObjectData ImportJWKFromArgs(const TnValue& jwk) {
  const TnValue& kty = jwk.Get("kty");
  if (!kty.IsString()) {
    Throw("ERR_CRYPTO_INVALID_JWK");
    return {};
  }
  std::string kty_string = kty.String();
  if (kty_string == "RSA") return ImportJWKRsaKey(jwk);
  if (kty_string == "EC") return ImportJWKEcKey(jwk);
  if (kty_string == "OKP") return ImportJWKEdKey(jwk);
  if (kty_string == "AKP") {
#if OPENSSL_WITH_PQC
    return ImportJWKPqcKey(jwk);
#else
    Throw("ERR_INVALID_ARG_VALUE", "Unsupported key type");
    return {};
#endif
  }
  Throw("ERR_CRYPTO_INVALID_JWK", "%s is not a supported JWK key type", kty_string.c_str());
  return {};
}

// ImportRawKeyFromArgs (734-768).
KeyObjectData ImportRawKeyFromArgs(const TnValue* args, unsigned int offset) {
  auto format = static_cast<EVPKeyPointer::PKFormatType>(args[offset + 1].Int32());
  KeyType type = format == EVPKeyPointer::PKFormatType::RAW_PUBLIC ? kKeyTypePublic : kKeyTypePrivate;
  const TnValue& key_data = args[offset];
  if (key_data.length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "keyData is too big");
    return {};
  }
  if (!args[offset + 2].IsString()) abort();
  std::string key_type = args[offset + 2].String();
  std::string curve = args[offset + 4].IsString() ? args[offset + 4].String() : std::string();
  return ImportRawKey(key_data.data, key_data.length, format, key_type, curve.c_str(), type);
}
}  // namespace

// ---- KeyObjectData (1044-1130) ----------------------------------------------------------------------------------

KeyObjectData::KeyObjectData(std::nullptr_t) : key_type_(kKeyTypeSecret) {}
KeyObjectData::KeyObjectData(ByteSource symmetric_key)
    : key_type_(kKeyTypeSecret),
      mutex_(std::make_shared<std::mutex>()),
      data_(std::make_shared<Data>(std::move(symmetric_key))) {}
KeyObjectData::KeyObjectData(KeyType type, EVPKeyPointer&& pkey)
    : key_type_(type), mutex_(std::make_shared<std::mutex>()), data_(std::make_shared<Data>(std::move(pkey))) {}

std::mutex& KeyObjectData::mutex() const {
  if (!mutex_) mutex_ = std::make_shared<std::mutex>();
  return *mutex_.get();
}
KeyObjectData KeyObjectData::CreateSecret(ByteSource key) { return KeyObjectData(std::move(key)); }
KeyObjectData KeyObjectData::CreateAsymmetric(KeyType key_type, EVPKeyPointer&& pkey) {
  if (!pkey) abort();
  return KeyObjectData(key_type, std::move(pkey));
}
KeyType KeyObjectData::GetKeyType() const {
  if (!data_) abort();
  return key_type_;
}
const EVPKeyPointer& KeyObjectData::GetAsymmetricKey() const {
  if (key_type_ == kKeyTypeSecret || !data_) abort();
  return data_->asymmetric_key;
}
const char* KeyObjectData::GetSymmetricKey() const {
  if (key_type_ != kKeyTypeSecret || !data_) abort();
  return data_->symmetric_key.data<char>();
}
size_t KeyObjectData::GetSymmetricKeySize() const {
  if (key_type_ != kKeyTypeSecret || !data_) abort();
  return data_->symmetric_key.size();
}

KeyObjectData* NewHandleData(const KeyObjectData& data) { return new KeyObjectData(data.addRef()); }

bool ExportJWK(const KeyObjectData& key, TnFields* target, bool handle_rsa_pss) {
  return key.GetKeyType() == kKeyTypeSecret ? ExportJWKSecretKey(key, target)
                                            : ExportJWKAsymmetricKey(key, target, handle_rsa_pss);
}

// ToEncodedPublicKey (372-426), the encodings other than a key object (the engine makes that one).
bool KeyObjectData::ToEncodedPublicKey(const EVPKeyPointer::PublicKeyEncodingConfig& config, ByteSource* out,
                                       TnFields* jwk) const {
  if (key_type_ == kKeyTypeSecret || config.output_key_object) abort();
  if (config.format == EVPKeyPointer::PKFormatType::JWK) {
    return ExportJWK(addRefWithType(kKeyTypePublic), jwk, false);
  } else if (config.format == EVPKeyPointer::PKFormatType::RAW_PUBLIC) {
    std::lock_guard<std::mutex> lock(mutex());
    const auto& pkey = GetAsymmetricKey();
    if (pkey.id() == EVP_PKEY_EC) {
      ECKeyPointer ec_key(pkey);
      if (!ec_key) {
        Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
        return false;
      }
      if (ec_key.getPublicKey() == nullptr) {
        Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC public key");
        return false;
      }
      auto form = static_cast<point_conversion_form_t>(config.ec_point_form);
      return ECPointToBuffer(ec_key.getGroup(), ec_key.getPublicKey(), form, out);
    }
    const int id = pkey.id();
    bool is_raw_supported = id == EVP_PKEY_ED25519 || id == EVP_PKEY_ED448 || id == EVP_PKEY_X25519 ||
                            id == EVP_PKEY_X448;
#if OPENSSL_WITH_PQC
    is_raw_supported = is_raw_supported || IsPqcKeyId(id);
#endif
    if (!is_raw_supported) {
      Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
      return false;
    }
    auto raw_data = pkey.rawPublicKey();
    if (!raw_data) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get raw public key");
      return false;
    }
    *out = ByteSource::CopyOf(raw_data.get(), raw_data.size());
    return true;
  }
  return WritePublicKey(GetAsymmetricKey(), config, out);
}

// ToEncodedPrivateKey (428-511).
bool KeyObjectData::ToEncodedPrivateKey(const EVPKeyPointer::PrivateKeyEncodingConfig& config, ByteSource* out,
                                        TnFields* jwk) const {
  if (key_type_ == kKeyTypeSecret || config.output_key_object) abort();
  if (config.format == EVPKeyPointer::PKFormatType::JWK) {
    return ExportJWK(addRefWithType(kKeyTypePrivate), jwk, false);
  } else if (config.format == EVPKeyPointer::PKFormatType::RAW_PRIVATE) {
    std::lock_guard<std::mutex> lock(mutex());
    const auto& pkey = GetAsymmetricKey();
    if (pkey.id() == EVP_PKEY_EC) {
      ECKeyPointer ec_key(pkey);
      if (!ec_key) {
        Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
        return false;
      }
      const BIGNUM* private_key = ec_key.getPrivateKey();
      if (private_key == nullptr) {
        Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC private key");
        return false;
      }
      auto order = BignumPointer::New();
      if (!order || !EC_GROUP_get_order(ec_key.getGroup(), order.get(), nullptr)) {
        Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC private key");
        return false;
      }
      auto buf = BignumPointer::EncodePadded(private_key, order.byteLength());
      if (!buf) {
        Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC private key");
        return false;
      }
      *out = ByteSource::CopyOf(buf.get(), buf.size());
      return true;
    }
    const int id = pkey.id();
    bool is_raw_supported = id == EVP_PKEY_ED25519 || id == EVP_PKEY_ED448 || id == EVP_PKEY_X25519 ||
                            id == EVP_PKEY_X448;
#if OPENSSL_WITH_PQC
    is_raw_supported = is_raw_supported || IsPqcRawPrivateKeyId(id);
#endif
    if (!is_raw_supported) {
      Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
      return false;
    }
    auto raw_data = pkey.rawPrivateKey();
    if (!raw_data) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get raw private key");
      return false;
    }
    *out = ByteSource::CopyOf(raw_data.get(), raw_data.size());
    return true;
  } else if (config.format == EVPKeyPointer::PKFormatType::RAW_SEED) {
#if OPENSSL_WITH_PQC
    std::lock_guard<std::mutex> lock(mutex());
    const auto& pkey = GetAsymmetricKey();
    if (!IsPqcSeedKeyId(pkey.id())) {
      Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
      return false;
    }
    auto raw_data = pkey.rawSeed();
    if (!raw_data) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get raw seed");
      return false;
    }
    *out = ByteSource::CopyOf(raw_data.get(), raw_data.size());
    return true;
#else
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return false;
#endif
  }
  return WritePrivateKey(GetAsymmetricKey(), config, out);
}

// GetPrivateKeyEncodingFromJs (513-569).
bool KeyObjectData::GetPrivateKeyEncoding(const TnValue* args, unsigned int* offset, KeyEncodingContext context,
                                          EVPKeyPointer::PrivateKeyEncodingConfig* config) {
  if (!GetKeyFormatAndType(args, offset, context, config)) return false;
  if (config->output_key_object) {
    if (context != kKeyContextInput) (*offset)++;
  } else if (config->format == EVPKeyPointer::PKFormatType::RAW_PRIVATE ||
             config->format == EVPKeyPointer::PKFormatType::RAW_SEED) {
    if (context != kKeyContextInput) {
      if (!args[*offset].IsNullOrUndefined()) abort();
      (*offset)++;
    }
    if (!args[*offset].IsNullOrUndefined()) abort();
  } else {
    bool needs_passphrase = false;
    if (context != kKeyContextInput) {
      if (args[*offset].IsString()) {
        std::string cipher_name = args[*offset].String();
        config->cipher = ncrypto::getCipherByName(cipher_name.c_str());
        if (config->cipher == nullptr) {
          Throw("ERR_CRYPTO_UNKNOWN_CIPHER");
          return false;
        }
        needs_passphrase = true;
      } else {
        if (!args[*offset].IsNullOrUndefined()) abort();
        config->cipher = nullptr;
      }
      (*offset)++;
    }
    if (args[*offset].IsAnyBufferSource()) {
      if (context != kKeyContextInput && config->cipher == nullptr) abort();
      const TnValue& passphrase = args[*offset];
      if (passphrase.length > INT_MAX) {
        Throw("ERR_OUT_OF_RANGE", "passphrase is too big");
        return false;
      }
      config->passphrase = ncrypto::DataPointer::Copy(
          ncrypto::Buffer<const void>{.data = passphrase.data, .len = passphrase.length});
    } else if (!args[*offset].IsNullOrUndefined() || needs_passphrase) {
      abort();
    }
  }
  (*offset)++;
  return true;
}

// GetPublicKeyEncodingFromJs (571-578).
bool KeyObjectData::GetPublicKeyEncoding(const TnValue* args, unsigned int* offset, KeyEncodingContext context,
                                         EVPKeyPointer::PublicKeyEncodingConfig* config) {
  return GetKeyFormatAndType(args, offset, context, config);
}

// GetPrivateKeyFromJs (770-923).
KeyObjectData KeyObjectData::GetPrivateKey(const TnValue* args, unsigned int* offset, bool allow_key_object) {
  if (args[*offset].kind == kTnObject && args[*offset + 1].IsInt32() &&
      static_cast<EVPKeyPointer::PKFormatType>(args[*offset + 1].Int32()) == EVPKeyPointer::PKFormatType::STORE) {
    const TnValue& store = args[*offset];
    const TnValue& uri_value = store.Get("uri");
    if (!uri_value.IsString()) abort();
    std::string uri = uri_value.String();
    const TnValue& properties_value = store.Get("properties");
    std::string properties_storage;
    std::optional<std::string_view> properties;
    if (properties_value.IsString()) {
      properties_storage = properties_value.String();
      properties = std::string_view(properties_storage);
    } else if (!properties_value.IsNullOrUndefined()) {
      abort();
    }
    // THROW_IF_INSUFFICIENT_PERMISSIONS (kOpenSSLStore): the engine runs no permission model, as Node without
    // --permission.
    std::optional<ncrypto::Buffer<const char>> passphrase;
    if (args[*offset + 3].IsAnyBufferSource()) {
      if (args[*offset + 3].length > INT_MAX) {
        Throw("ERR_OUT_OF_RANGE", "passphrase is too big");
        return {};
      }
      passphrase = ncrypto::Buffer<const char>{.data = reinterpret_cast<const char*>(args[*offset + 3].data),
                                               .len = args[*offset + 3].length};
    } else if (!args[*offset + 3].IsNullOrUndefined()) {
      abort();
    }
    *offset += 5;
    EVPKeyPointer::StorePrivateKeyConfig config{
        .uri = uri,
        .properties = properties,
        .passphrase = passphrase,
    };
    auto res = EVPKeyPointer::TryLoadPrivateKeyFromStore(config);
    if (res) return CreateAsymmetric(kKeyTypePrivate, std::move(res.value));
    switch (res.error.value()) {
      case EVPKeyPointer::PKParseError::NEED_PASSPHRASE:
        ERR_clear_error();
        Throw("ERR_MISSING_PASSPHRASE", "Passphrase required for encrypted key");
        break;
      case EVPKeyPointer::PKParseError::NOT_RECOGNIZED:
        ERR_clear_error();
        Throw("ERR_CRYPTO_OPERATION_FAILED", "No private key found through the OpenSSL STORE loader");
        break;
      default: {
        static constexpr const char* msg = "Failed to load private key through an OpenSSL STORE loader";
        if (res.openssl_error.value_or(0) == 0) {
          Throw("ERR_CRYPTO_OPERATION_FAILED", "%s", msg);
        } else {
          ThrowCrypto(res.openssl_error.value(), msg);
        }
        break;
      }
    }
    return {};
  }
  if (args[*offset].kind == kTnObject && args[*offset + 1].IsInt32()) {
    auto format = static_cast<EVPKeyPointer::PKFormatType>(args[*offset + 1].Int32());
    if (format == EVPKeyPointer::PKFormatType::JWK) {
      auto data = ImportJWKFromArgs(args[*offset]);
      *offset += 5;
      return data;
    }
  }
  if (args[*offset].IsString() || args[*offset].IsAnyBufferSource()) {
    if (args[*offset + 1].IsInt32()) {
      auto format = static_cast<EVPKeyPointer::PKFormatType>(args[*offset + 1].Int32());
      if (format == EVPKeyPointer::PKFormatType::RAW_PRIVATE || format == EVPKeyPointer::PKFormatType::RAW_SEED) {
        auto data = ImportRawKeyFromArgs(args, *offset);
        *offset += 5;
        return data;
      }
    }
    ByteSource key = args[(*offset)++].Bytes();
    EVPKeyPointer::PrivateKeyEncodingConfig config;
    if (!GetPrivateKeyEncoding(args, offset, kKeyContextInput, &config)) return {};
    (*offset)++;
    return TryParsePrivateKey(config, ncrypto::Buffer<const unsigned char>{
                                          .data = key.data<unsigned char>(),
                                          .len = key.size(),
                                      });
  }
  if (!args[*offset].IsKey() || !allow_key_object) abort();
  const KeyObjectData& key = args[*offset].Key();
  if (key.GetKeyType() != kKeyTypePrivate) abort();
  (*offset) += 5;
  return key.addRef();
}

// GetPublicOrPrivateKeyFromJs (925-1042).
KeyObjectData KeyObjectData::GetPublicOrPrivateKey(const TnValue* args, unsigned int* offset,
                                                   bool allow_private_key_store) {
  if (args[*offset].kind == kTnObject && args[*offset + 1].IsInt32()) {
    auto format = static_cast<EVPKeyPointer::PKFormatType>(args[*offset + 1].Int32());
    if (format == EVPKeyPointer::PKFormatType::JWK) {
      auto data = ImportJWKFromArgs(args[*offset]);
      *offset += 5;
      return data;
    }
    if (format == EVPKeyPointer::PKFormatType::STORE) {
      if (allow_private_key_store) return GetPrivateKey(args, offset, false);
      Throw("ERR_INVALID_ARG_VALUE", "URLs for OpenSSL STORE loaders are only accepted for private keys");
      return {};
    }
  }
  if (args[*offset].IsString() || args[*offset].IsAnyBufferSource()) {
    if (args[*offset + 1].IsInt32()) {
      auto format = static_cast<EVPKeyPointer::PKFormatType>(args[*offset + 1].Int32());
      if (format == EVPKeyPointer::PKFormatType::RAW_PUBLIC || format == EVPKeyPointer::PKFormatType::RAW_PRIVATE ||
          format == EVPKeyPointer::PKFormatType::RAW_SEED) {
        auto data = ImportRawKeyFromArgs(args, *offset);
        *offset += 5;
        return data;
      }
    }
    const TnValue& data = args[(*offset)++];
    if (data.length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "keyData is too big");
      return {};
    }
    EVPKeyPointer::PrivateKeyEncodingConfig config;
    if (!GetPrivateKeyEncoding(args, offset, kKeyContextInput, &config)) return {};
    (*offset)++;
    ncrypto::Buffer<const unsigned char> buffer = data.View();
    if (config.format == EVPKeyPointer::PKFormatType::PEM) {
      auto res = EVPKeyPointer::TryParsePublicKeyPEM(buffer);
      if (res) return CreateAsymmetric(kKeyTypePublic, std::move(res.value));
      if (res.error.value() == EVPKeyPointer::PKParseError::NOT_RECOGNIZED) return TryParsePrivateKey(config, buffer);
      ThrowCrypto(res.openssl_error.value_or(0), "Failed to read asymmetric key");
      return {};
    }
    bool is_public;
    switch (config.type) {
      case EVPKeyPointer::PKEncodingType::PKCS1:
        is_public = !EVPKeyPointer::IsRSAPrivateKey(buffer);
        break;
      case EVPKeyPointer::PKEncodingType::SPKI:
        is_public = true;
        break;
      case EVPKeyPointer::PKEncodingType::PKCS8:
      case EVPKeyPointer::PKEncodingType::SEC1:
        is_public = false;
        break;
      default:
        abort();
    }
    if (is_public) {
      auto res = EVPKeyPointer::TryParsePublicKey(config, buffer);
      if (res) return CreateAsymmetric(kKeyTypePublic, std::move(res.value));
      ThrowCrypto(res.openssl_error.value_or(0), "Failed to read asymmetric key");
      return {};
    }
    return TryParsePrivateKey(config, buffer);
  }
  if (!args[*offset].IsKey()) abort();
  const KeyObjectData& key = args[*offset].Key();
  if (key.GetKeyType() == kKeyTypeSecret) abort();
  (*offset) += 5;
  return key.addRef();
}

// ---- WebCrypto's SPKI and PKCS#8 exports (1836-1860) ------------------------------------------------------------

WebCryptoKeyExportStatus PKEY_SPKI_Export(const KeyObjectData& key_data, ByteSource* out) {
  if (key_data.GetKeyType() != kKeyTypePublic) abort();
  std::lock_guard<std::mutex> lock(key_data.mutex());
  auto bio = key_data.GetAsymmetricKey().derPublicKey();
  if (!bio) return WebCryptoKeyExportStatus::FAILED;
  *out = ByteSource::FromBIO(bio);
  return WebCryptoKeyExportStatus::OK;
}
WebCryptoKeyExportStatus PKEY_PKCS8_Export(const KeyObjectData& key_data, ByteSource* out) {
  if (key_data.GetKeyType() != kKeyTypePrivate) abort();
  std::lock_guard<std::mutex> lock(key_data.mutex());
  const auto& m_pkey = key_data.GetAsymmetricKey();
  auto bio = BIOPointer::NewMem();
  if (!bio) abort();
  PKCS8Pointer p8inf(EVP_PKEY2PKCS8(m_pkey.get()));
  if (!i2d_PKCS8_PRIV_KEY_INFO_bio(bio.get(), p8inf.get())) return WebCryptoKeyExportStatus::FAILED;
  *out = ByteSource::FromBIO(bio);
  return WebCryptoKeyExportStatus::OK;
}

// ---- KeyObjectHandle (1132-1690) --------------------------------------------------------------------------------

// The handle's data let go (its object collected, as Node's BaseObject drops its data_).
CRYPTO_EXPORT(tabnode_key_free) void tabnode_key_free(KeyObjectData* key) { delete key; }

// KeyObjectHandle::Init (1220-1303): the data its arguments name, or null where it threw. `*returned` is what Init
// answers (the JWK branch's key type), -1 for undefined.
CRYPTO_EXPORT(tabnode_key_init) KeyObjectData* tabnode_key_init(const TnValue* args, uint32_t length,
                                                               int32_t* returned) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  *returned = -1;
  if (!args[0].IsInt32()) abort();
  KeyType type = static_cast<KeyType>(args[0].Uint32());
  KeyObjectData data;
  unsigned int offset;
  switch (type) {
    case kKeyTypeSecret: {
      if (length == 5 && args[2].IsInt32() &&
          static_cast<EVPKeyPointer::PKFormatType>(args[2].Int32()) == EVPKeyPointer::PKFormatType::JWK) {
        if (!args[1].IsObject()) abort();
        data = ImportJWKSecretKey(args[1]);
        break;
      }
      if (length != 2) abort();
      data = KeyObjectData::CreateSecret(args[1].Bytes());
      break;
    }
    case kKeyTypePublic:
    case kKeyTypePrivate: {
      if (length != 6) abort();
      if (args[2].IsInt32()) {
        auto format = static_cast<EVPKeyPointer::PKFormatType>(args[2].Int32());
        if (format == EVPKeyPointer::PKFormatType::RAW_PUBLIC || format == EVPKeyPointer::PKFormatType::RAW_PRIVATE ||
            format == EVPKeyPointer::PKFormatType::RAW_SEED) {
          auto raw = ImportRawKeyFromArgs(args, 1);
          if (!raw) return nullptr;
          data = type == kKeyTypePublic && raw.GetKeyType() == kKeyTypePrivate ? raw.addRefWithType(kKeyTypePublic)
                                                                              : std::move(raw);
          break;
        }
        if (format == EVPKeyPointer::PKFormatType::JWK) {
          if (!args[1].IsObject()) abort();
          data = ImportJWKFromArgs(args[1]);
          if (!data) return nullptr;
          if (type == kKeyTypePublic && data.GetKeyType() == kKeyTypePrivate) {
            data = data.addRefWithType(kKeyTypePublic);
          } else if (type == kKeyTypePrivate && data.GetKeyType() == kKeyTypePublic) {
            Throw("ERR_CRYPTO_INVALID_JWK", "JWK does not contain private key material");
            return nullptr;
          }
          *returned = data.GetKeyType();
          break;
        }
      }
      offset = 1;
      if (type == kKeyTypePublic) {
        auto parsed = KeyObjectData::GetPublicOrPrivateKey(args, &offset);
        if (!parsed) return nullptr;
        data = parsed.addRefWithType(kKeyTypePublic);
      } else {
        data = KeyObjectData::GetPrivateKey(args, &offset, false);
      }
      break;
    }
    default:
      abort();
  }
  if (!data) return nullptr;
  return new KeyObjectData(std::move(data));
}

// GetKeyType (1305-1311), GetSymmetricKeySize (1438-1444).
CRYPTO_EXPORT(tabnode_key_type) int tabnode_key_type(const KeyObjectData* key) { return key->GetKeyType(); }
CRYPTO_EXPORT(tabnode_key_symmetric_size) uint32_t tabnode_key_symmetric_size(const KeyObjectData* key) {
  return static_cast<uint32_t>(key->GetSymmetricKeySize());
}

// Equals (1313-1358): 1 or 0, -1 where it threw.
CRYPTO_EXPORT(tabnode_key_equals) int tabnode_key_equals(const KeyObjectData* key, const KeyObjectData* key2) {
  KeyType key_type = key->GetKeyType();
  if (key_type != key2->GetKeyType()) abort();
  switch (key_type) {
    case kKeyTypeSecret: {
      size_t size = key->GetSymmetricKeySize();
      if (size != key2->GetSymmetricKeySize()) return 0;
      return CRYPTO_memcmp(key->GetSymmetricKey(), key2->GetSymmetricKey(), size) == 0 ? 1 : 0;
    }
    case kKeyTypePublic:
    case kKeyTypePrivate: {
      int ok = EVP_PKEY_eq(key->GetAsymmetricKey().get(), key2->GetAsymmetricKey().get());
      if (ok == -2) {
        Throw("ERR_CRYPTO_UNSUPPORTED_OPERATION");
        return -1;
      }
      return ok == 1 ? 1 : 0;
    }
  }
  abort();
}

// GetKeyDetail (1360-1379): the members Node sets on its argument; null where it threw.
CRYPTO_EXPORT(tabnode_key_detail) char* tabnode_key_detail(const KeyObjectData* key, size_t* length) {
  TnFields target;
  bool ok = key->GetKeyType() == kKeyTypeSecret ? GetSecretKeyDetail(*key, &target)
                                                : GetAsymmetricKeyDetail(*key, &target);
  return ok ? target.Answer(length) : nullptr;
}

// GetAsymmetricKeyType (1381-1409): the type's name, or null for undefined.
CRYPTO_EXPORT(tabnode_key_asymmetric_type) const char* tabnode_key_asymmetric_type(const KeyObjectData* key) {
  int id = key->GetAsymmetricKey().id();
  switch (id) {
    case EVP_PKEY_RSA:
      return "rsa";
    case EVP_PKEY_RSA_PSS:
      return "rsa-pss";
    case EVP_PKEY_DSA:
      return "dsa";
    case EVP_PKEY_DH:
      return "dh";
    case EVP_PKEY_EC:
      return "ec";
    case EVP_PKEY_ED25519:
      return "ed25519";
    case EVP_PKEY_ED448:
      return "ed448";
    case EVP_PKEY_X25519:
      return "x25519";
    case EVP_PKEY_X448:
      return "x448";
    default:
#if OPENSSL_WITH_PQC
      return GetPqcAsymmetricKeyType(id);
#else
      return nullptr;
#endif
  }
}

// CheckEcKeyData (1419-1436).
CRYPTO_EXPORT(tabnode_key_check_ec) int tabnode_key_check_ec(const KeyObjectData* data) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  const auto& key = data->GetAsymmetricKey();
  EVPKeyCtxPointer ctx = key.newCtx();
  if (!ctx || key.id() != EVP_PKEY_EC) abort();
  return (data->GetKeyType() == kKeyTypePrivate ? ctx.privateCheck() : ctx.publicCheck()) ? 1 : 0;
}

// Export (1446-1502): the encoded key, `*text` 1 where it is a PEM's string (ToV8Value), 0 for a Buffer; null where
// it threw. A secret's is its bytes.
CRYPTO_EXPORT(tabnode_key_export) char* tabnode_key_export(const KeyObjectData* key, const TnValue* args,
                                                          uint32_t length, size_t* out_length, int* text) {
  KeyType type = key->GetKeyType();
  unsigned int offset = 0;
  *text = 0;
  ByteSource out;
  if (type == kKeyTypeSecret) {
    return Copy(key->GetSymmetricKey(), key->GetSymmetricKeySize(), out_length);
  }
  if (type == kKeyTypePublic) {
    EVPKeyPointer::PublicKeyEncodingConfig config;
    if (!KeyObjectData::GetPublicKeyEncoding(args, &offset, kKeyContextExport, &config)) return nullptr;
    if (offset != length) abort();
    if (!WritePublicKey(key->GetAsymmetricKey(), config, &out)) return nullptr;
    *text = config.format == EVPKeyPointer::PKFormatType::PEM ? 1 : 0;
    return out.Answer(out_length);
  }
  EVPKeyPointer::PrivateKeyEncodingConfig config;
  if (!KeyObjectData::GetPrivateKeyEncoding(args, &offset, kKeyContextExport, &config)) return nullptr;
  if (offset != length) abort();
  if (!WritePrivateKey(key->GetAsymmetricKey(), config, &out)) return nullptr;
  *text = config.format == EVPKeyPointer::PKFormatType::PEM ? 1 : 0;
  return out.Answer(out_length);
}

namespace {
bool IsRawSupported(int id, bool private_key) {
  bool supported = id == EVP_PKEY_ED25519 || id == EVP_PKEY_ED448 || id == EVP_PKEY_X25519 || id == EVP_PKEY_X448;
#if OPENSSL_WITH_PQC
  supported = supported || (private_key ? IsPqcRawPrivateKeyId(id) : IsPqcKeyId(id));
#endif
  return supported;
}
}  // namespace

// RawPublicKey (1504-1535), RawPrivateKey (1537-1568): null where it threw.
CRYPTO_EXPORT(tabnode_key_raw_public) char* tabnode_key_raw_public(const KeyObjectData* data, size_t* length) {
  if (data->GetKeyType() == kKeyTypeSecret) abort();
  std::lock_guard<std::mutex> lock(data->mutex());
  const auto& pkey = data->GetAsymmetricKey();
  if (!IsRawSupported(pkey.id(), false)) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return nullptr;
  }
  auto raw_data = pkey.rawPublicKey();
  if (!raw_data) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get raw public key");
    return nullptr;
  }
  return Copy(raw_data.get<const char>(), raw_data.size(), length);
}
CRYPTO_EXPORT(tabnode_key_raw_private) char* tabnode_key_raw_private(const KeyObjectData* data, size_t* length) {
  if (data->GetKeyType() != kKeyTypePrivate) abort();
  std::lock_guard<std::mutex> lock(data->mutex());
  const auto& pkey = data->GetAsymmetricKey();
  if (!IsRawSupported(pkey.id(), true)) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return nullptr;
  }
  auto raw_data = pkey.rawPrivateKey();
  if (!raw_data) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get raw private key");
    return nullptr;
  }
  return Copy(raw_data.get<const char>(), raw_data.size(), length);
}

// ExportECPublicRaw (1570-1604), ExportECPrivateRaw (1606-1645).
CRYPTO_EXPORT(tabnode_key_ec_public_raw) char* tabnode_key_ec_public_raw(const KeyObjectData* data, int form,
                                                                        size_t* length) {
  if (data->GetKeyType() == kKeyTypeSecret) abort();
  std::lock_guard<std::mutex> lock(data->mutex());
  const auto& m_pkey = data->GetAsymmetricKey();
  if (m_pkey.id() != EVP_PKEY_EC) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return nullptr;
  }
  ECKeyPointer ec_key(m_pkey);
  if (!ec_key) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return nullptr;
  }
  if (ec_key.getPublicKey() == nullptr) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC public key");
    return nullptr;
  }
  ByteSource out;
  if (!ECPointToBuffer(ec_key.getGroup(), ec_key.getPublicKey(), static_cast<point_conversion_form_t>(form), &out)) {
    return nullptr;
  }
  return out.Answer(length);
}
CRYPTO_EXPORT(tabnode_key_ec_private_raw) char* tabnode_key_ec_private_raw(const KeyObjectData* data,
                                                                          size_t* length) {
  if (data->GetKeyType() != kKeyTypePrivate) abort();
  std::lock_guard<std::mutex> lock(data->mutex());
  const auto& m_pkey = data->GetAsymmetricKey();
  if (m_pkey.id() != EVP_PKEY_EC) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return nullptr;
  }
  ECKeyPointer ec_key(m_pkey);
  if (!ec_key) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return nullptr;
  }
  const BIGNUM* private_key = ec_key.getPrivateKey();
  if (private_key == nullptr) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC private key");
    return nullptr;
  }
  auto order = BignumPointer::New();
  if (!order || !EC_GROUP_get_order(ec_key.getGroup(), order.get(), nullptr)) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC private key");
    return nullptr;
  }
  auto buf = BignumPointer::EncodePadded(private_key, order.byteLength());
  if (!buf) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export EC private key");
    return nullptr;
  }
  return Copy(buf.get<const char>(), buf.size(), length);
}

// RawSeed (1647-1674).
CRYPTO_EXPORT(tabnode_key_raw_seed) char* tabnode_key_raw_seed(const KeyObjectData* data, size_t* length) {
  if (data->GetKeyType() != kKeyTypePrivate) abort();
#if OPENSSL_WITH_PQC
  std::lock_guard<std::mutex> lock(data->mutex());
  const auto& pkey = data->GetAsymmetricKey();
  if (!IsPqcSeedKeyId(pkey.id())) {
    Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    return nullptr;
  }
  auto raw_data = pkey.rawSeed();
  if (!raw_data) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get raw seed");
    return nullptr;
  }
  return Copy(raw_data.get<const char>(), raw_data.size(), length);
#else
  Throw("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
  return nullptr;
#endif
}

// ExportJWK (1676-1690): the JWK's members, null where it threw.
CRYPTO_EXPORT(tabnode_key_export_jwk) char* tabnode_key_export_jwk(const KeyObjectData* key, int handle_rsa_pss,
                                                                  size_t* length) {
  TnFields target;
  if (ExportJWK(*key, &target, handle_rsa_pss != 0)) return target.Answer(length);
  if (!HasThrown()) Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export JWK");
  return nullptr;
}

// A handle's new reference to the same data (KeyObjectHandle::Create of Data(): NativeKeyObject's and
// NativeCryptoKey's slots, a job's key).
CRYPTO_EXPORT(tabnode_key_ref) KeyObjectData* tabnode_key_ref(const KeyObjectData* key) { return NewHandleData(*key); }

// The OpenSSL values Node's initializers define on the binding (NODE_DEFINE_CONSTANT: Keys::Initialize 2190-2217,
// Sign::Initialize, the keygen and RSA initializers' and X509Certificate's), name NUL value NUL each.
CRYPTO_EXPORT(tabnode_crypto_binding_values) char* tabnode_crypto_binding_values(size_t* length) {
  std::string out;
  auto define = [&](const char* name, long value) {  // NOLINT(runtime/int)
    out += name;
    out.push_back('\0');
    out += std::to_string(value);
    out.push_back('\0');
  };
#define V(name) define(#name, name);
  V(EVP_PKEY_ED25519)
  V(EVP_PKEY_ED448)
  V(EVP_PKEY_X25519)
  V(EVP_PKEY_X448)
#if OPENSSL_WITH_PQC
  V(EVP_PKEY_ML_DSA_44)
  V(EVP_PKEY_ML_DSA_65)
  V(EVP_PKEY_ML_DSA_87)
#if OPENSSL_WITH_PQC_ML_KEM_512
  V(EVP_PKEY_ML_KEM_512)
#endif
  V(EVP_PKEY_ML_KEM_768)
  V(EVP_PKEY_ML_KEM_1024)
#if OPENSSL_WITH_PQC_SLH_DSA
  V(EVP_PKEY_SLH_DSA_SHA2_128F)
  V(EVP_PKEY_SLH_DSA_SHA2_128S)
  V(EVP_PKEY_SLH_DSA_SHA2_192F)
  V(EVP_PKEY_SLH_DSA_SHA2_192S)
  V(EVP_PKEY_SLH_DSA_SHA2_256F)
  V(EVP_PKEY_SLH_DSA_SHA2_256S)
  V(EVP_PKEY_SLH_DSA_SHAKE_128F)
  V(EVP_PKEY_SLH_DSA_SHAKE_128S)
  V(EVP_PKEY_SLH_DSA_SHAKE_192F)
  V(EVP_PKEY_SLH_DSA_SHAKE_192S)
  V(EVP_PKEY_SLH_DSA_SHAKE_256F)
  V(EVP_PKEY_SLH_DSA_SHAKE_256S)
#endif
#endif
  V(RSA_PKCS1_PSS_PADDING)
  // What the binding's routing reads (crypto_sig.ts): the key types and curves WebCrypto signs with.
  V(RSA_PKCS1_PADDING)
  V(EVP_PKEY_RSA)
  V(EVP_PKEY_EC)
  V(NID_X9_62_prime256v1)
  V(NID_secp384r1)
  V(NID_secp521r1)
  V(OPENSSL_EC_NAMED_CURVE)
  V(OPENSSL_EC_EXPLICIT_CURVE)
  V(X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT)
  V(X509_CHECK_FLAG_NO_WILDCARDS)
  V(X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS)
  V(X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS)
  V(X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS)
  V(X509_CHECK_FLAG_NEVER_CHECK_SUBJECT)
#undef V
  return Copy(out.data(), out.size(), length);
}
