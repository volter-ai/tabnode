// RSA KEYS OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_rsa.cc, over ncrypto and OpenSSL in libnode.so: a key's JWK and its details.
#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::EVPKeyPointer;

// ExportJWKRsaKey (319-369).
bool ExportJWKRsaKey(const KeyObjectData& key, TnFields* target) {
  std::lock_guard<std::mutex> lock(key.mutex());
  const auto& m_pkey = key.GetAsymmetricKey();
  const ncrypto::Rsa rsa = m_pkey;
  if (!rsa) return false;
  target->String("kty", "RSA");
  auto pub_key = rsa.getPublicKey();
  SetEncodedValue(target, "n", pub_key.n);
  SetEncodedValue(target, "e", pub_key.e);
  if (key.GetKeyType() == kKeyTypePrivate) {
    auto pvt_key = rsa.getPrivateKey();
    if (pub_key.d == nullptr || pvt_key.p == nullptr || pvt_key.q == nullptr || pvt_key.dp == nullptr ||
        pvt_key.dq == nullptr || pvt_key.qi == nullptr) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to export RSA private key");
      return false;
    }
    SetEncodedValue(target, "d", pub_key.d);
    SetEncodedValue(target, "p", pvt_key.p);
    SetEncodedValue(target, "q", pvt_key.q);
    SetEncodedValue(target, "dp", pvt_key.dp);
    SetEncodedValue(target, "dq", pvt_key.dq);
    SetEncodedValue(target, "qi", pvt_key.qi);
  }
  return true;
}

// ImportJWKRsaKey (371-462), with OpenSSL 3's provider (NCRYPTO_USE_OPENSSL3_PROVIDER).
KeyObjectData ImportJWKRsaKey(const TnValue& jwk) {
  const TnValue& n_value = jwk.Get("n");
  const TnValue& e_value = jwk.Get("e");
  const TnValue& d_value = jwk.Get("d");
  if (!n_value.IsString() || !e_value.IsString() || (!d_value.IsUndefined() && !d_value.IsString())) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK RSA key");
    return {};
  }
  KeyType type = d_value.IsString() ? kKeyTypePrivate : kKeyTypePublic;
#if NCRYPTO_USE_OPENSSL3_PROVIDER
  ncrypto::Rsa rsa_view;
#else
  ncrypto::RSAPointer rsa(RSA_new());
  if (!rsa) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Unable to create RSA pointer");
    return {};
  }
  ncrypto::Rsa rsa_view(rsa.get());
#endif
  ByteSource n = n_value.Decoded();
  ByteSource e = e_value.Decoded();
  if (!rsa_view.setPublicKey(n.ToBN(), e.ToBN())) {
    Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK RSA key");
    return {};
  }
  if (type == kKeyTypePrivate) {
    const TnValue& p_value = jwk.Get("p");
    const TnValue& q_value = jwk.Get("q");
    const TnValue& dp_value = jwk.Get("dp");
    const TnValue& dq_value = jwk.Get("dq");
    const TnValue& qi_value = jwk.Get("qi");
    if (!p_value.IsString() || !q_value.IsString() || !dp_value.IsString() || !dq_value.IsString() ||
        !qi_value.IsString()) {
      Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK RSA key");
      return {};
    }
    ByteSource d = d_value.Decoded();
    ByteSource q = q_value.Decoded();
    ByteSource p = p_value.Decoded();
    ByteSource dp = dp_value.Decoded();
    ByteSource dq = dq_value.Decoded();
    ByteSource qi = qi_value.Decoded();
    if (!rsa_view.setPrivateKey(d.ToBN(), q.ToBN(), p.ToBN(), dp.ToBN(), dq.ToBN(), qi.ToBN())) {
      Throw("ERR_CRYPTO_INVALID_JWK", "Invalid JWK RSA key");
      return {};
    }
  }
#if NCRYPTO_USE_OPENSSL3_PROVIDER
  auto pkey = EVPKeyPointer::NewRSA(rsa_view);
#else
  auto pkey = EVPKeyPointer::NewRSA(std::move(rsa));
#endif
  if (!pkey) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "Unable to create key pointer");
    return {};
  }
  return KeyObjectData::CreateAsymmetric(type, std::move(pkey));
}

// GetRsaKeyDetail (464-551).
bool GetRsaKeyDetail(const KeyObjectData& key, TnFields* target) {
  std::lock_guard<std::mutex> lock(key.mutex());
  const auto& m_pkey = key.GetAsymmetricKey();
  const ncrypto::Rsa rsa = m_pkey;
  if (!rsa) return false;
  auto pub_key = rsa.getPublicKey();
  target->Number("modulusLength", static_cast<double>(BignumPointer::GetBitCount(pub_key.n)));
  std::vector<unsigned char> public_exponent(BignumPointer::GetByteCount(pub_key.e));
  if (BignumPointer::EncodePaddedInto(pub_key.e, public_exponent.data(), public_exponent.size()) !=
      public_exponent.size()) {
    abort();
  }
  target->ArrayBuffer("publicExponent", public_exponent.data(), public_exponent.size());
  if (m_pkey.id() == EVP_PKEY_RSA_PSS) {
    auto maybe_params = rsa.getPssParams();
    if (maybe_params.has_value()) {
      auto& params = maybe_params.value();
      target->String("hashAlgorithm", std::string(params.digest));
      if (params.mgf1_digest.has_value()) target->String("mgf1HashAlgorithm", std::string(params.mgf1_digest.value()));
      target->Number("saltLength", params.salt_length);
    }
  }
  return true;
}
