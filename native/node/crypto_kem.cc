// KEY ENCAPSULATION OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_kem.cc, over ncrypto and OpenSSL 3.5 in libnode.so: KEMEncapsulateJob and KEMDecapsulateJob
// (ML-KEM, and RSA, EC and X25519/X448 DHKEM). WebCrypto's standard defines no encapsulation, so it is OpenSSL's.
#include "crypto_util.h"

#if OPENSSL_WITH_KEM
namespace {
// KEMConfiguration (crypto_kem.h).
struct KEMConfiguration {
  KeyObjectData key;
  ByteSource ciphertext;
};

// KEMEncapsulateJob (crypto_kem.cc:62-190): its two answers, the shared key (`out`) and the ciphertext.
class KEMEncapsulateJob final : public CryptoJob {
 public:
  KEMEncapsulateJob(CryptoJobMode mode, KEMConfiguration&& params) : CryptoJob(mode), params_(std::move(params)) {}
  void DoThreadPoolWork() override {
    ncrypto::ClearErrorOnReturn clear_error_on_return;
    std::lock_guard<std::mutex> lock(params_.key.mutex());
    auto result = ncrypto::KEM::Encapsulate(params_.key.GetAsymmetricKey());
    if (result) {
      ciphertext = ByteSource::Allocated(result->ciphertext.release());
      out = ByteSource::Allocated(result->shared_key.release());
      success = true;
    } else {
      // A synchronous job throws (THROW_ERR_CRYPTO_OPERATION_FAILED in the caller's thread).
      if (mode() == kCryptoJobSync) Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to perform encapsulation");
      errors()->Capture();
      if (errors()->Empty()) errors()->Insert(kDerivingBitsFailed);
    }
  }
  ByteSource ciphertext;

 private:
  KEMConfiguration params_;
};

// KEMDecapsulateTraits::DeriveBits and DoKEMDecapsulate (crypto_kem.cc:31-60, 240-250).
bool DeriveDecapsulate(const KEMConfiguration& params, ByteSource* out, CryptoJobMode mode) {
  std::lock_guard<std::mutex> lock(params.key.mutex());
  ncrypto::Buffer<const void> ciphertext_buf{params.ciphertext.data(), params.ciphertext.size()};
  auto shared_key = ncrypto::KEM::Decapsulate(params.key.GetAsymmetricKey(), ciphertext_buf);
  if (!shared_key) {
    if (mode == kCryptoJobSync) Throw("ERR_CRYPTO_OPERATION_FAILED", "Failed to perform decapsulation");
    return false;
  }
  *out = ByteSource::Allocated(shared_key.release());
  return true;
}
}  // namespace

// KEMEncapsulateTraits::AdditionalConfig and KEMEncapsulateJob::New (crypto_kem.cc:62-95): `args` the public key's
// slots. Null where it threw.
CRYPTO_EXPORT(tabnode_kem_encapsulate_job_new) CryptoJob* tabnode_kem_encapsulate_job_new(int32_t mode,
                                                                                         const TnValue* args,
                                                                                         uint32_t count) {
  unsigned int key_offset = 0;
  auto public_key_data = KeyObjectData::GetPublicOrPrivateKey(args, &key_offset);
  if (!public_key_data) return nullptr;
  KEMConfiguration params;
  params.key = std::move(public_key_data);
  return new KEMEncapsulateJob(JobMode(mode), std::move(params));
}
// An encapsulation's ciphertext, borrowed: the engine copies it out before the job is freed.
CRYPTO_EXPORT(tabnode_kem_job_ciphertext) const void* tabnode_kem_job_ciphertext(CryptoJob* job, size_t* length) {
  const ByteSource& ciphertext = static_cast<KEMEncapsulateJob*>(job)->ciphertext;
  *length = ciphertext.size();
  return ciphertext.data();
}

// KEMDecapsulateTraits::AdditionalConfig (crypto_kem.cc:212-238): `args` the private key's slots, then the
// ciphertext. Null where it threw.
CRYPTO_EXPORT(tabnode_kem_decapsulate_job_new) CryptoJob* tabnode_kem_decapsulate_job_new(int32_t mode,
                                                                                         const TnValue* args,
                                                                                         uint32_t count) {
  unsigned int key_offset = 0;
  auto private_key_data = KeyObjectData::GetPrivateKey(args, &key_offset, true);
  if (!private_key_data) return nullptr;
  KEMConfiguration params;
  params.key = std::move(private_key_data);
  if (args[key_offset].length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "ciphertext is too big");
    return nullptr;
  }
  params.ciphertext = args[key_offset].Bytes();
  return new DeriveBitsJob<KEMConfiguration>(JobMode(mode), std::move(params), DeriveDecapsulate);
}
#endif
