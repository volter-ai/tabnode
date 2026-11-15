// DSA KEYS OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_dsa.cc, over ncrypto and OpenSSL in libnode.so: a key's details.
#include "crypto_util.h"

// GetDsaKeyDetail (77-100).
bool GetDsaKeyDetail(const KeyObjectData& key, TnFields* target) {
  if (!key) return false;
  ncrypto::Dsa dsa = key.GetAsymmetricKey();
  if (!dsa) return false;
  target->Number("modulusLength", static_cast<double>(dsa.getModulusLength()));
  target->Number("divisorLength", static_cast<double>(dsa.getDivisorLength()));
  return true;
}
