// RSA OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's src/crypto/crypto_rsa.cc,
// over ncrypto and OpenSSL in libnode.so: a key's JWK and its details, RsaKeyPairGenJob's configuration and Setup, and
// RSACipherJob (RSA-OAEP). Which of them the engine device answers is the binding's routing
// (src/node-lib/binding/crypto_keygen.ts, crypto_webcrypto.ts).
#include <openssl/rsa.h>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::DataPointer;
using ncrypto::Digest;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;

#define CHECK(condition) \
  if (!(condition)) abort()

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

// ---- RsaKeyPairGenJob (crypto_rsa.cc:41-187) ---------------------------------------------------------------------

namespace {
// RSAKeyVariant (crypto_rsa.h:16-20).
enum RSAKeyVariant { kKeyVariantRSA_SSA_PKCS1_v1_5, kKeyVariantRSA_PSS, kKeyVariantRSA_OAEP };

// RsaKeyPairParams (crypto_rsa.h:54-71); Node's keeps Digests, which cannot move: their EVP_MDs are the same.
struct RsaKeyPairParams {
  RSAKeyVariant variant = kKeyVariantRSA_SSA_PKCS1_v1_5;
  unsigned int modulus_bits = 0;
  unsigned int exponent = 0;
  const EVP_MD* md = nullptr;
  const EVP_MD* mgf1_md = nullptr;
  int saltlen = -1;
};

// RsaKeyGenTraits::Setup (41-87).
EVPKeyCtxPointer RsaSetup(RsaKeyPairParams* params) {
  auto ctx = EVPKeyCtxPointer::NewFromID(params->variant == kKeyVariantRSA_PSS ? EVP_PKEY_RSA_PSS : EVP_PKEY_RSA);
  if (!ctx.initForKeygen() || !ctx.setRsaKeygenBits(params->modulus_bits)) return {};
  if (params->exponent != EVPKeyCtxPointer::kDefaultRsaExponent) {
    auto bn = BignumPointer::New();
    if (!bn.setWord(params->exponent) || !ctx.setRsaKeygenPubExp(std::move(bn))) return {};
  }
  if (params->variant == kKeyVariantRSA_PSS) {
    Digest md(params->md);
    if (md && !ctx.setRsaPssKeygenMd(md)) return {};
    if (params->mgf1_md == nullptr && params->md != nullptr) params->mgf1_md = params->md;
    Digest mgf1_md(params->mgf1_md);
    if (mgf1_md && !ctx.setRsaPssKeygenMgf1Md(mgf1_md)) return {};
    int saltlen = params->saltlen;
    if (saltlen < 0 && md) saltlen = md.size();
    if (saltlen >= 0 && !ctx.setRsaPssSaltlen(saltlen)) return {};
  }
  return ctx;
}
}  // namespace

// RsaKeyGenTraits::AdditionalConfig (115-187).
KeyGenJob* NewRsaKeyGenJob(CryptoJobMode mode, const TnValue* args, unsigned int* offset) {
  CHECK(args[*offset].IsUint32());
  CHECK(args[*offset + 1].IsUint32());
  CHECK(args[*offset + 2].IsUint32());
  RsaKeyPairParams params;
  params.variant = static_cast<RSAKeyVariant>(args[*offset].Uint32());
  params.modulus_bits = args[*offset + 1].Uint32();
  params.exponent = args[*offset + 2].Uint32();
  *offset += 3;
  if (params.variant == kKeyVariantRSA_PSS) {
    if (!args[*offset].IsUndefined()) {
      CHECK(args[*offset].IsString());
      std::string digest = args[*offset].String();
      params.md = Digest::FromName(digest.c_str()).get();
      if (params.md == nullptr) {
        Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", digest.c_str());
        return nullptr;
      }
    }
    if (!args[*offset + 1].IsUndefined()) {
      CHECK(args[*offset + 1].IsString());
      std::string digest = args[*offset + 1].String();
      params.mgf1_md = Digest::FromName(digest.c_str()).get();
      if (params.mgf1_md == nullptr) {
        Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid MGF1 digest: %s", digest.c_str());
        return nullptr;
      }
    }
    if (!args[*offset + 2].IsUndefined()) {
      CHECK(args[*offset + 2].IsInt32());
      params.saltlen = args[*offset + 2].Int32();
      if (params.saltlen < 0) {
        Throw("ERR_OUT_OF_RANGE", "salt length is out of range");
        return nullptr;
      }
    }
    *offset += 3;
  }
  return new KeyPairGenJob<RsaKeyPairParams>(mode, std::move(params), RsaSetup);
}

// ---- RSACipherJob (crypto_rsa.cc:193-300) ------------------------------------------------------------------------

namespace {
// RSACipherConfig (crypto_rsa.h:96-110).
struct RSACipherConfig {
  ByteSource label;
  int padding = 0;
  const EVP_MD* digest = nullptr;
};

using RsaCipher_t = DataPointer (*)(const EVPKeyPointer& key, const ncrypto::Rsa::CipherParams& params,
                                    const ncrypto::Buffer<const void> in);

// RSA_Cipher (199-219).
template <RsaCipher_t cipher>
WebCryptoCipherStatus RSA_Cipher(const KeyObjectData& key_data, const RSACipherConfig& params, const ByteSource& in,
                                 ByteSource* out) {
  CHECK(key_data.GetKeyType() != kKeyTypeSecret);
  std::lock_guard<std::mutex> lock(key_data.mutex());
  const auto& m_pkey = key_data.GetAsymmetricKey();
  const ncrypto::Rsa::CipherParams nparams{
      .padding = params.padding,
      .digest = Digest(params.digest),
      .label = params.label,
  };
  auto data = cipher(m_pkey, nparams, in);
  if (!data) return WebCryptoCipherStatus::FAILED;
  *out = ByteSource::Allocated(data.release());
  return WebCryptoCipherStatus::OK;
}

// RSACipherTraits::DoCipher (284-300).
WebCryptoCipherStatus DoRsaCipher(const KeyObjectData& key_data, WebCryptoCipherMode cipher_mode,
                                  const RSACipherConfig& params, const ByteSource& in, ByteSource* out) {
  switch (cipher_mode) {
    case kWebCryptoCipherEncrypt:
      CHECK(key_data.GetKeyType() == kKeyTypePublic);
      return RSA_Cipher<ncrypto::Rsa::encrypt>(key_data, params, in, out);
    case kWebCryptoCipherDecrypt:
      CHECK(key_data.GetKeyType() == kKeyTypePrivate);
      return RSA_Cipher<ncrypto::Rsa::decrypt>(key_data, params, in, out);
  }
  return WebCryptoCipherStatus::FAILED;
}
}  // namespace

// CipherJob<RSACipherTraits>::New (crypto_cipher.h:150-181) and RSACipherTraits::AdditionalConfig (245-282): `args`
// Node's from its fifth (the variant, the digest, the label). Null where it threw.
CRYPTO_EXPORT(tabnode_rsa_cipher_job_new) CryptoJob* tabnode_rsa_cipher_job_new(int32_t mode, uint32_t cipher_mode,
                                                                               const KeyObjectData* key,
                                                                               const void* data, size_t size,
                                                                               const TnValue* args, uint32_t count) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too large");
    return nullptr;
  }
  RSACipherConfig params;
  params.padding = RSA_PKCS1_OAEP_PADDING;
  CHECK(args[0].IsUint32());
  RSAKeyVariant variant = static_cast<RSAKeyVariant>(args[0].Uint32());
  switch (variant) {
    case kKeyVariantRSA_OAEP: {
      CHECK(args[1].IsString());
      std::string digest = args[1].String();
      params.digest = Digest::FromName(digest.c_str()).get();
      if (params.digest == nullptr) {
        Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", digest.c_str());
        return nullptr;
      }
      if (args[2].IsAnyBufferSource()) {
        if (args[2].length > INT_MAX) {
          Throw("ERR_OUT_OF_RANGE", "label is too big");
          return nullptr;
        }
        params.label = args[2].Bytes();
      }
      break;
    }
    default:
      Throw("ERR_CRYPTO_INVALID_KEYTYPE");
      return nullptr;
  }
  return new CipherJob<RSACipherConfig>(JobMode(mode), *key, static_cast<WebCryptoCipherMode>(cipher_mode),
                                        ByteSource::CopyOf(data, size), std::move(params), DoRsaCipher);
}
