// DIFFIE-HELLMAN OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_dh.cc, over ncrypto and OpenSSL in libnode.so: a key's details.
#include "crypto_util.h"

// GetDhKeyDetail (559-564): none.
bool GetDhKeyDetail(const KeyObjectData& key, TnFields* target) {
  if (key.GetAsymmetricKey().id() != EVP_PKEY_DH) abort();
  return true;
}
