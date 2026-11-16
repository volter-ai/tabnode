// ELLIPTIC CURVES OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_ec.cc and crypto_common.cc's ECPointToBuffer, over ncrypto and OpenSSL in the program: an EC, an
// Ed25519/Ed448 or an X25519/X448 key's JWK and its details, the ECDH class, ECDHConvertKey, getCurves, and
// EcKeyPairGenJob's configuration and Setup. Where the engine device answers an agreement or a key generation is the
// binding's routing (src/node-lib/binding/crypto_dh.ts, crypto_keygen.ts).
#include <openssl/ec.h>
#include <openssl/err.h>

#include <cstring>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::ECGroupPointer;
using ncrypto::ECKeyPointer;
using ncrypto::ECPointPointer;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;
using ncrypto::MarkPopErrorOnReturn;

#define CHECK(condition) \
  if (!(condition)) abort()

// ECPointToBuffer (crypto_common.cc:261-288).
bool ECPointToBuffer(const EC_GROUP* group, const EC_POINT* point, point_conversion_form_t form, ByteSource* out) {
  size_t len = EC_POINT_point2oct(group, point, form, nullptr, 0, nullptr);
  if (len == 0) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get public key length");
    return false;
  }
  auto data = ncrypto::DataPointer::Alloc(len);
  len = EC_POINT_point2oct(group, point, form, data.get<unsigned char>(), len, nullptr);
  if (len == 0) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get public key");
    return false;
  }
  *out = ByteSource::Allocated(data.release());
  return true;
}

// ExportJWKEcKey (603-691).
bool ExportJWKEcKey(const KeyObjectData& key, TnFields* target) {
  std::lock_guard<std::mutex> lock(key.mutex());
  const auto& m_pkey = key.GetAsymmetricKey();
  if (m_pkey.id() != EVP_PKEY_EC) abort();
  ECKeyPointer ec(m_pkey);
  if (!ec) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key");
    return false;
  }
  if (ec.getPublicKey() == nullptr) return false;
  const auto pub = ec.getPublicKey();
  const auto group = ec.getGroup();
  int degree_bits = EC_GROUP_get_degree(group);
  int degree_bytes = (degree_bits / CHAR_BIT) + (7 + (degree_bits % CHAR_BIT)) / 8;
  auto x = BignumPointer::New();
  auto y = BignumPointer::New();
  if (!EC_POINT_get_affine_coordinates(group, pub, x.get(), y.get(), nullptr)) {
    ThrowCrypto(ERR_get_error(), "Failed to get elliptic-curve point coordinates");
    return false;
  }
  const char* crv_name;
  const int nid = EC_GROUP_get_curve_name(group);
  switch (nid) {
    case NID_X9_62_prime256v1:
      crv_name = "P-256";
      break;
    case NID_secp256k1:
      crv_name = "secp256k1";
      break;
    case NID_secp384r1:
      crv_name = "P-384";
      break;
    case NID_secp521r1:
      crv_name = "P-521";
      break;
    default:
      Throw("ERR_CRYPTO_JWK_UNSUPPORTED_CURVE", "Unsupported JWK EC curve: %s.", OBJ_nid2sn(nid));
      return false;
  }
  target->String("kty", "EC");
  SetEncodedValue(target, "x", x.get(), degree_bytes);
  SetEncodedValue(target, "y", y.get(), degree_bytes);
  target->String("crv", crv_name);
  if (key.GetKeyType() == kKeyTypePrivate) {
    auto pvt = ec.getPrivateKey();
    if (pvt == nullptr) return false;
    SetEncodedValue(target, "d", pvt, degree_bytes);
  }
  return true;
}

// ExportJWKEdKey (693-739).
bool ExportJWKEdKey(const KeyObjectData& key, TnFields* target) {
  std::lock_guard<std::mutex> lock(key.mutex());
  const auto& pkey = key.GetAsymmetricKey();
  const char* curve;
  switch (pkey.id()) {
    case EVP_PKEY_ED25519:
      curve = "Ed25519";
      break;
    case EVP_PKEY_ED448:
      curve = "Ed448";
      break;
    case EVP_PKEY_X25519:
      curve = "X25519";
      break;
    case EVP_PKEY_X448:
      curve = "X448";
      break;
    default:
      abort();
  }
  auto trySetKey = [&](ncrypto::DataPointer data, const char* name) {
    if (!data) return false;
    target->Base64Url(name, data.get(), data.size());
    return true;
  };
  target->String("crv", curve);
  if (key.GetKeyType() == kKeyTypePrivate && !trySetKey(pkey.rawPrivateKey(), "d")) return false;
  if (!trySetKey(pkey.rawPublicKey(), "x")) return false;
  target->String("kty", "OKP");
  return true;
}

// ImportJWKEdKey (741-807).
KeyObjectData ImportJWKEdKey(const TnValue& jwk) {
  const TnValue& crv_value = jwk.Get("crv");
  const TnValue& x_value = jwk.Get("x");
  const TnValue& d_value = jwk.Get("d");
  if (!crv_value.IsString() || !x_value.IsString() || (!d_value.IsUndefined() && !d_value.IsString())) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK OKP key");
    return {};
  }
  std::string crv = crv_value.String();
  static constexpr struct {
    const char* name;
    int nid;
  } kCurveToNid[] = {
      {"Ed25519", EVP_PKEY_ED25519},
      {"Ed448", EVP_PKEY_ED448},
      {"X25519", EVP_PKEY_X25519},
      {"X448", EVP_PKEY_X448},
  };
  int id = NID_undef;
  for (const auto& entry : kCurveToNid) {
    if (strcmp(crv.c_str(), entry.name) == 0) {
      id = entry.nid;
      break;
    }
  }
  if (id == NID_undef) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK OKP key");
    return {};
  }
  KeyType type = d_value.IsString() ? kKeyTypePrivate : kKeyTypePublic;
  ByteSource raw = type == kKeyTypePrivate ? d_value.Decoded() : x_value.Decoded();
  auto fn = type == kKeyTypePrivate ? EVPKeyPointer::NewRawPrivate : EVPKeyPointer::NewRawPublic;
  auto pkey = fn(id, ncrypto::Buffer<const unsigned char>{.data = raw.data<unsigned char>(), .len = raw.size()});
  if (!pkey) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK OKP key");
    return {};
  }
  return KeyObjectData::CreateAsymmetric(type, std::move(pkey));
}

// ImportJWKEcKey (809-872).
KeyObjectData ImportJWKEcKey(const TnValue& jwk) {
  const TnValue& crv_value = jwk.Get("crv");
  if (!crv_value.IsString()) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key");
    return {};
  }
  std::string curve = crv_value.String();
  int nid = ncrypto::Ec::GetCurveIdFromName(curve.c_str());
  if (nid == NID_undef) {
    Throw("ERR_CRYPTO_INVALID_CURVE");
    return {};
  }
  const TnValue& x_value = jwk.Get("x");
  const TnValue& y_value = jwk.Get("y");
  const TnValue& d_value = jwk.Get("d");
  if (!x_value.IsString() || !y_value.IsString() || (!d_value.IsUndefined() && !d_value.IsString())) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key");
    return {};
  }
  KeyType type = d_value.IsString() ? kKeyTypePrivate : kKeyTypePublic;
  auto ec = ECKeyPointer::NewByCurveName(nid);
  if (!ec) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key");
    return {};
  }
  ByteSource x = x_value.Decoded();
  ByteSource y = y_value.Decoded();
  if (!ec.setPublicKeyRaw(x.ToBN(), y.ToBN())) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key");
    return {};
  }
  if (type == kKeyTypePrivate) {
    ByteSource d = d_value.Decoded();
    if (!ec.setPrivateKey(d.ToBN())) {
      Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key");
      return {};
    }
  }
  auto pkey = EVPKeyPointer::New();
  if (!pkey) return {};
  if (!pkey.set(ec)) abort();
  return KeyObjectData::CreateAsymmetric(type, std::move(pkey));
}

// GetEcKeyDetail (874-898).
bool GetEcKeyDetail(const KeyObjectData& key, TnFields* target) {
  std::lock_guard<std::mutex> lock(key.mutex());
  const auto& m_pkey = key.GetAsymmetricKey();
  if (m_pkey.id() != EVP_PKEY_EC) abort();
  ECKeyPointer ec(m_pkey);
  if (!ec) return true;
  int nid = EC_GROUP_get_curve_name(ec.getGroup());
  if (nid == NID_undef) return true;
  target->String("namedCurve", OBJ_nid2sn(nid));
  return true;
}

// ---- ECDH (crypto_ec.cc:41-416) ---------------------------------------------------------------------------------

// ECDH::GetCurves (77-86): each curve's name, NUL-terminated.
CRYPTO_EXPORT(tabnode_curve_list) char* tabnode_curve_list(size_t* length) {
  std::string joined;
  ncrypto::Ec::GetCurves([&](std::string_view curve) -> bool {
    joined.append(curve);
    joined.push_back('\0');
    return true;
  });
  return Copy(joined.data(), joined.size(), length);
}

// ECDH's C++ state (crypto_ec.h:40-79).
struct TnECDH {
  ECKeyPointer key_;
  const EC_GROUP* group_;

  // ECDH::IsKeyValidForCurve (363-376).
  bool IsKeyValidForCurve(const BignumPointer& private_key) {
    CHECK(group_);
    CHECK(private_key);
    if (private_key < BignumPointer::One()) return false;
    auto order = BignumPointer::New();
    CHECK(order);
    return EC_GROUP_get_order(group_, order.get(), nullptr) && private_key < order;
  }
  // ECDH::IsKeyPairValid (378-381).
  bool IsKeyPairValid() {
    MarkPopErrorOnReturn mark_pop_error_on_return;
    return key_.checkKey();
  }
};

namespace {
// ECDH::BufferToPoint (134-159): null where it threw or where the bytes are no point.
ECPointPointer BufferToPoint(const EC_GROUP* group, const unsigned char* data, size_t size) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "buffer is too big");
    return {};
  }
  auto pub = ECPointPointer::New(group);
  if (!pub) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to allocate EC_POINT for a public key");
    return pub;
  }
  ncrypto::Buffer<const unsigned char> buffer{.data = data, .len = size};
  if (!pub.setFromBuffer(buffer, group)) return {};
  return pub;
}
}  // namespace

// ECDH::New (98-117): null where it threw.
CRYPTO_EXPORT(tabnode_ecdh_new) TnECDH* tabnode_ecdh_new(const char* curve) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  int nid = OBJ_sn2nid(curve);
  if (nid == NID_undef) {
    Throw("ERR_CRYPTO_INVALID_CURVE");
    return nullptr;
  }
  auto key = ECKeyPointer::NewByCurveName(nid);
  if (!key) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to create key using named curve");
    return nullptr;
  }
  auto* ecdh = new TnECDH();
  ecdh->key_ = std::move(key);
  ecdh->group_ = ecdh->key_.getGroup();
  CHECK(ecdh->group_ != nullptr);
  return ecdh;
}
CRYPTO_EXPORT(tabnode_ecdh_free) void tabnode_ecdh_free(TnECDH* ecdh) { delete ecdh; }

// ECDH::GenerateKeys (119-132): 1, or 0 where it threw.
CRYPTO_EXPORT(tabnode_ecdh_generate_keys) int tabnode_ecdh_generate_keys(TnECDH* ecdh) {
  if (!ecdh->key_.generate()) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to generate key");
    return 0;
  }
  return 1;
}

// The checks of ECDH::ComputeSecret (161-201) before its derivation, which the engine device may answer: 1 to
// derive, 0 where it threw, 2 where the peer's bytes are no point (Node answers the string
// ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY).
CRYPTO_EXPORT(tabnode_ecdh_check_secret) int tabnode_ecdh_check_secret(TnECDH* ecdh, const unsigned char* data,
                                                                      size_t size) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  if (!ecdh->IsKeyPairValid()) {
    Throw("ERR_CRYPTO_INVALID_KEYPAIR");
    return 0;
  }
  auto pub = BufferToPoint(ecdh->group_, data, size);
  if (!pub) return HasThrown() ? 0 : 2;
  return 1;
}

// ECDH::ComputeSecret (161-201), after tabnode_ecdh_check_secret answered 1: the secret, or null where it threw.
CRYPTO_EXPORT(tabnode_ecdh_compute_secret) char* tabnode_ecdh_compute_secret(TnECDH* ecdh, const unsigned char* data,
                                                                            size_t size, size_t* length) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  auto pub = BufferToPoint(ecdh->group_, data, size);
  if (!pub) return nullptr;
  auto secret = ecdh->key_.computeSecret(pub);
  if (!secret) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to compute ECDH key");
    return nullptr;
  }
  return Copy(static_cast<const char*>(secret.get()), secret.size(), length);
}

// ECDH::GetPublicKey (203-228): the point in `form`, or null where it threw.
CRYPTO_EXPORT(tabnode_ecdh_get_public_key) char* tabnode_ecdh_get_public_key(TnECDH* ecdh, uint32_t form,
                                                                            size_t* length) {
  const auto group = ecdh->key_.getGroup();
  const auto pub = ecdh->key_.getPublicKey();
  if (pub == nullptr) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get ECDH public key");
    return nullptr;
  }
  ByteSource out;
  if (!ECPointToBuffer(group, pub, static_cast<point_conversion_form_t>(form), &out)) return nullptr;
  return out.Answer(length);
}

// ECDH::GetPrivateKey (230-254).
CRYPTO_EXPORT(tabnode_ecdh_get_private_key) char* tabnode_ecdh_get_private_key(TnECDH* ecdh, size_t* length) {
  auto b = ecdh->key_.getPrivateKey();
  if (b == nullptr) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get ECDH private key");
    return nullptr;
  }
  auto encoded = BignumPointer::EncodePadded(b, BignumPointer::GetByteCount(b));
  return Copy(static_cast<const char*>(encoded.get()), encoded.size(), length);
}

// ECDH::SetPrivateKey (256-312): 1, or 0 where it threw.
CRYPTO_EXPORT(tabnode_ecdh_set_private_key) int tabnode_ecdh_set_private_key(TnECDH* ecdh, const unsigned char* data,
                                                                            size_t size) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "key is too big");
    return 0;
  }
  BignumPointer priv(data, size);
  if (!priv) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to convert Buffer to BN");
    return 0;
  }
  if (!ecdh->IsKeyValidForCurve(priv)) {
    Throw("ERR_CRYPTO_INVALID_KEYTYPE", "Private key is not valid for specified curve.");
    return 0;
  }
  auto new_key = ecdh->key_.clone();
  CHECK(new_key);
  bool result = new_key.setPrivateKey(priv);
  priv.reset();
  if (!result) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to convert BN to a private key");
    return 0;
  }
  MarkPopErrorOnReturn mark_pop_error_on_return;
  auto priv_key = new_key.getPrivateKey();
  CHECK(priv_key != nullptr);
  auto pub = ECPointPointer::New(ecdh->group_);
  CHECK(pub);
  if (!pub.mul(ecdh->group_, priv_key)) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to generate ECDH public key");
    return 0;
  }
  if (!new_key.setPublicKey(pub)) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to set generated public key");
    return 0;
  }
  ecdh->key_ = std::move(new_key);
  ecdh->group_ = ecdh->key_.getGroup();
  return 1;
}

// ECDH::SetPublicKey (314-336): 1, or 0 where it threw.
CRYPTO_EXPORT(tabnode_ecdh_set_public_key) int tabnode_ecdh_set_public_key(TnECDH* ecdh, const unsigned char* data,
                                                                          size_t size) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  auto pub = BufferToPoint(ecdh->group_, data, size);
  if (!pub) {
    if (!HasThrown()) Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to convert Buffer to EC_POINT");
    return 0;
  }
  if (!ecdh->key_.setPublicKey(pub)) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to set EC_POINT as the public key");
    return 0;
  }
  return 1;
}

// What the engine device's agreement takes (ADR-0018 §5): the curve's NID, and the key as a JWK's members (its d, x
// and y, ExportJWKEcKey's), which the device imports.
CRYPTO_EXPORT(tabnode_ecdh_curve) int tabnode_ecdh_curve(TnECDH* ecdh) { return EC_GROUP_get_curve_name(ecdh->group_); }
CRYPTO_EXPORT(tabnode_ecdh_key_data) KeyObjectData* tabnode_ecdh_key_data(TnECDH* ecdh) {
  auto pkey = EVPKeyPointer::New();
  if (!pkey || !pkey.set(ecdh->key_)) return nullptr;
  return NewHandleData(KeyObjectData::CreateAsymmetric(kKeyTypePrivate, std::move(pkey)));
}

// ECDH::ConvertKey (384-416), for a non-empty key (Node answers an empty string for an empty one): the point in
// `form`, or null where it threw.
CRYPTO_EXPORT(tabnode_ecdh_convert_key) char* tabnode_ecdh_convert_key(const unsigned char* data, size_t size,
                                                                      const char* curve, uint32_t form,
                                                                      size_t* length) {
  MarkPopErrorOnReturn mark_pop_error_on_return;
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "key is too big");
    return nullptr;
  }
  int nid = OBJ_sn2nid(curve);
  if (nid == NID_undef) {
    Throw("ERR_CRYPTO_INVALID_CURVE");
    return nullptr;
  }
  auto group = ECGroupPointer::NewByCurveName(nid);
  if (!group) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to get EC_GROUP");
    return nullptr;
  }
  auto pub = BufferToPoint(group, data, size);
  if (!pub) {
    if (!HasThrown()) Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to convert Buffer to EC_POINT");
    return nullptr;
  }
  ByteSource out;
  if (!ECPointToBuffer(group, pub, static_cast<point_conversion_form_t>(form), &out)) return nullptr;
  return out.Answer(length);
}

// ---- EcKeyPairGenJob (crypto_ec.cc:418-491) ---------------------------------------------------------------------

namespace {
// EcKeyPairParams (crypto_ec.h:90-95).
struct EcKeyPairParams {
  int curve_nid;
  int param_encoding;
};

// EcKeyGenTraits::Setup (418-447).
EVPKeyCtxPointer EcSetup(EcKeyPairParams* params) {
  EVPKeyCtxPointer key_ctx;
  switch (params->curve_nid) {
    case EVP_PKEY_ED25519:
    case EVP_PKEY_ED448:
    case EVP_PKEY_X25519:
    case EVP_PKEY_X448:
      key_ctx = EVPKeyCtxPointer::NewFromID(params->curve_nid);
      break;
    default: {
      auto param_ctx = EVPKeyCtxPointer::NewFromID(EVP_PKEY_EC);
      if (!param_ctx.initForParamgen() || !param_ctx.setEcParameters(params->curve_nid, params->param_encoding)) {
        return {};
      }
      auto key_params = param_ctx.paramgen();
      if (!key_params) return {};
      key_ctx = key_params.newCtx();
    }
  }
  if (!key_ctx.initForKeygen()) return {};
  return key_ctx;
}
}  // namespace

// EcKeyGenTraits::AdditionalConfig (459-491).
KeyGenJob* NewEcKeyGenJob(CryptoJobMode mode, const TnValue* args, unsigned int* offset) {
  CHECK(args[*offset].IsString());
  std::string curve_name = args[*offset].String();
  EcKeyPairParams params;
  params.curve_nid = ncrypto::Ec::GetCurveIdFromName(curve_name.c_str());
  if (params.curve_nid == NID_undef) {
    Throw("ERR_CRYPTO_INVALID_CURVE");
    return nullptr;
  }
  if (args[*offset + 1].IsNullOrUndefined()) {
    params.param_encoding = OPENSSL_EC_NAMED_CURVE;
  } else {
    CHECK(args[*offset + 1].IsInt32());
    params.param_encoding = args[*offset + 1].Int32();
    if (params.param_encoding != OPENSSL_EC_NAMED_CURVE && params.param_encoding != OPENSSL_EC_EXPLICIT_CURVE) {
      Throw("ERR_OUT_OF_RANGE", "Invalid param_encoding specified");
      return nullptr;
    }
  }
  *offset += 2;
  return new KeyPairGenJob<EcKeyPairParams>(mode, std::move(params), EcSetup);
}
