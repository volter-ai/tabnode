// KEY GENERATION OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_keygen.h and crypto_keygen.cc, over ncrypto and OpenSSL in the program: the key pair jobs
// (RsaKeyPairGenJob, DsaKeyPairGenJob, EcKeyPairGenJob, DhKeyPairGenJob, NidKeyPairGenJob, each algorithm's
// AdditionalConfig and Setup in its own file) and SecretKeyGenJob, and how a pair's halves are encoded (EncodeKey).
// A key WebCrypto generates is the engine device's (the binding's routing, src/node-lib/binding/crypto_keygen.ts),
// whose answer is then encoded by the same job's encodings here.
#include "crypto_util.h"

using ncrypto::DataPointer;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;

namespace {
// NidKeyPairGenTraits (crypto_keygen.cc:31-49).
struct NidKeyPairParams {
  int id;
};
EVPKeyCtxPointer NidSetup(NidKeyPairParams* params) {
  auto ctx = EVPKeyCtxPointer::NewFromID(params->id);
  if (!ctx || !ctx.initForKeygen()) return {};
  return ctx;
}

// SecretKeyGenTraits (crypto_keygen.cc:51-89).
class SecretKeyGenJob final : public KeyGenJob {
 public:
  SecretKeyGenJob(CryptoJobMode mode, size_t length, size_t length_bits, bool truncate)
      : KeyGenJob(mode), length_(length), length_bits_(length_bits), truncate_(truncate) {}
  void DoThreadPoolWork() override {
    auto bytes = DataPointer::Alloc(length_);
    if (!ncrypto::CSPRNG(static_cast<unsigned char*>(bytes.get()), length_)) return Failed();
    ByteSource out = ByteSource::Allocated(bytes.release());
    if (truncate_) TruncateToBitLength(length_bits_, &out);
    key = KeyObjectData::CreateSecret(std::move(out));
    success = true;
  }

 private:
  size_t length_;
  size_t length_bits_;
  bool truncate_;
};

// KeyPairGenTraits::AdditionalConfig (crypto_keygen.h:205-229): a WebCrypto job's halves are CryptoKeys, and every
// other job's are encoded as the arguments after the algorithm's say.
bool ReadEncodings(KeyGenJob* job, CryptoJobMode mode, const TnValue* args, unsigned int* offset) {
  if (mode == kCryptoJobWebCrypto) return true;
  return KeyObjectData::GetPublicKeyEncoding(args, offset, kKeyContextGenerate, &job->public_key_encoding) &&
         KeyObjectData::GetPrivateKeyEncoding(args, offset, kKeyContextGenerate, &job->private_key_encoding);
}
}  // namespace

// KeyGenJob::New (crypto_keygen.h:41-79): `kind` 0 RSA, 1 DSA, 2 EC, 3 DH, 4 an id's (NidKeyPairGenJob), 5 a secret
// (SecretKeyGenJob); `args` Node's from its second. The WebCrypto configuration (the algorithm, the usages and
// whether the key is extractable) is the engine's, which makes the CryptoKeys. Null where it threw.
CRYPTO_EXPORT(tabnode_keygen_job_new) CryptoJob* tabnode_keygen_job_new(int kind, int32_t mode_value,
                                                                       const TnValue* args, uint32_t count) {
  CryptoJobMode mode = JobMode(mode_value);
  unsigned int offset = 0;
  KeyGenJob* job = nullptr;
  switch (kind) {
    case 0:
      job = NewRsaKeyGenJob(mode, args, &offset);
      break;
    case 1:
      job = NewDsaKeyGenJob(mode, args, &offset);
      break;
    case 2:
      job = NewEcKeyGenJob(mode, args, &offset);
      break;
    case 3:
      job = NewDhKeyGenJob(mode, args, &offset);
      break;
    case 4: {
      if (!args[offset].IsInt32()) abort();
      NidKeyPairParams params{args[offset].Int32()};
      offset += 1;
      job = new KeyPairGenJob<NidKeyPairParams>(mode, std::move(params), NidSetup);
      break;
    }
    case 5: {
      // SecretKeyGenTraits::AdditionalConfig (68-84).
      if (!args[offset].IsUint32()) abort();
      uint32_t bits = args[offset].Uint32();
      size_t length;
      bool truncate = false;
      if (mode == kCryptoJobWebCrypto) {
        length = NumBitsToBytes(static_cast<size_t>(bits));
        truncate = bits % CHAR_BIT != 0;
      } else {
        length = bits / CHAR_BIT;
      }
      return new SecretKeyGenJob(mode, length, bits, truncate);
    }
    default:
      abort();
  }
  if (job == nullptr) return nullptr;
  if (!ReadEncodings(job, mode, args, &offset)) {
    delete job;
    return nullptr;
  }
  return job;
}

// KeyPairGenTraits::EncodeKey (crypto_keygen.h:258-268), one half: `which` 0 the public key, 1 the private; `key` the
// pair (null: the job's own, else the engine device's answer the engine took into OpenSSL). `*kind` is the answer's
// shape: 0 a key object (no bytes; the engine makes the handle, ToEncoded*Key's KeyObjectHandle::Create), 1 a PEM's
// text, 2 a Buffer's bytes (DER or raw), 3 a JWK's members. Null where it threw.
CRYPTO_EXPORT(tabnode_keygen_encode) char* tabnode_keygen_encode(CryptoJob* job, const KeyObjectData* key, int which,
                                                                size_t* length, int* kind) {
  KeyGenJob* gen = static_cast<KeyGenJob*>(job);
  const KeyObjectData& data = key != nullptr ? *key : job->key;
  ByteSource out;
  TnFields jwk;
  EVPKeyPointer::PKFormatType format;
  if (which == 0) {
    const auto& config = gen->public_key_encoding;
    if (config.output_key_object) {
      *kind = 0;
      return Copy("", 0, length);
    }
    if (!data.ToEncodedPublicKey(config, &out, &jwk)) return nullptr;
    format = config.format;
  } else {
    const auto& config = gen->private_key_encoding;
    if (config.output_key_object) {
      *kind = 0;
      return Copy("", 0, length);
    }
    if (!data.ToEncodedPrivateKey(config, &out, &jwk)) return nullptr;
    format = config.format;
  }
  if (format == EVPKeyPointer::PKFormatType::JWK) {
    *kind = 3;
    return jwk.Answer(length);
  }
  *kind = format == EVPKeyPointer::PKFormatType::PEM ? 1 : 2;
  return out.Answer(length);
}
