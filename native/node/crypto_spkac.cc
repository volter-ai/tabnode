// SPKAC OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's src/crypto/crypto_spkac.cc
// (crypto.Certificate), over ncrypto and OpenSSL in libnode.so. Each answers Node's empty string for empty input
// before it calls here (the engine's half).
#include "crypto_util.h"

// VerifySpkac (21-33): 1 or 0; -1 where it threw.
CRYPTO_EXPORT(tabnode_spkac_verify) int tabnode_spkac_verify(const char* data, size_t size) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "spkac is too large");
    return -1;
  }
  return ncrypto::VerifySpkac(data, size) ? 1 : 0;
}

// ExportPublicKey (35-52): the key's PEM bytes; null with nothing thrown for Node's empty string.
CRYPTO_EXPORT(tabnode_spkac_export_public_key) char* tabnode_spkac_export_public_key(const char* data, size_t size,
                                                                                    size_t* length) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "spkac is too large");
    return nullptr;
  }
  ncrypto::BIOPointer bio = ncrypto::ExportPublicKey(data, size);
  if (!bio) return nullptr;
  return ByteSource::FromBIO(bio).Answer(length);
}

// ExportChallenge (54-79): the challenge's bytes; null with nothing thrown for Node's empty string.
CRYPTO_EXPORT(tabnode_spkac_export_challenge) char* tabnode_spkac_export_challenge(const char* data, size_t size,
                                                                                  size_t* length) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "spkac is too large");
    return nullptr;
  }
  auto cert = ByteSource::Allocated(ncrypto::ExportChallenge(data, size));
  if (!cert) return nullptr;
  return cert.Answer(length);
}
