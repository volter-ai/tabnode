// ELLIPTIC CURVES OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_ec.cc and crypto_common.cc's ECPointToBuffer, over ncrypto and OpenSSL in libnode.so: an EC, an
// Ed25519/Ed448 or an X25519/X448 key's JWK and its details.
#include <openssl/ec.h>
#include <openssl/err.h>

#include <cstring>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::ECKeyPointer;
using ncrypto::EVPKeyPointer;

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
