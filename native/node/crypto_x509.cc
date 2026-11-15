// THE CERTIFICATES OF THE crypto BINDING (Tabnode ADR-0018 item 7, ADR-0016 §3): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_x509.cc (X509ToObject and X509Certificate's fields) and of crypto_common.cc's issuer walk, over
// ncrypto's X509View and OpenSSL in libnode.so. A certificate is an X509* the engine holds until it frees it.
#include <openssl/ec.h>
#include <openssl/x509v3.h>

#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>

#include "crypto_util.h"

// ---- Certificates as objects (crypto_x509.cc X509ToObject, 720-855) --------------------------------------

CRYPTO_EXPORT(tabnode_x509_from_der) X509* tabnode_x509_from_der(const unsigned char* der, size_t length) {
  const unsigned char* p = der;
  return d2i_X509(nullptr, &p, static_cast<long>(length));
}
CRYPTO_EXPORT(tabnode_x509_free) void tabnode_x509_free(X509* x) { X509_free(x); }

// GetX509NameObject's entries (611-667), as key NUL value NUL pairs; the binding builds Node's null-prototype
// object, with an array where a key repeats.
CRYPTO_EXPORT(tabnode_x509_name) char* tabnode_x509_name(X509* x, int issuer, size_t* length) {
  ncrypto::X509View view(x);
  const ncrypto::X509Name name = issuer ? view.getIssuerName() : view.getSubjectName();
  *length = 0;
  if (!name) return nullptr;
  std::string out;
  for (auto entry : name) {
    auto pair = entry;
    out.append(pair.first);
    out.push_back('\0');
    out.append(pair.second);
    out.push_back('\0');
  }
  return Copy(out.data(), out.size(), length);
}

// The text fields of X509ToObject and X509Certificate's methods; null answers "undefined".
//  0 subjectaltname  1 infoAccess  2 valid_from  3 valid_to  4 fingerprint  5 fingerprint256  6 fingerprint512
//  7 serialNumber    8 modulus     9 exponent    10 asn1Curve  11 nistCurve 12 pem 13 signatureAlgorithm
//  14 signatureAlgorithmOid
CRYPTO_EXPORT(tabnode_x509_text) char* tabnode_x509_text(X509* x, int field, size_t* length) {
  ncrypto::X509View view(x);
  *length = 0;
  switch (field) {
    case 0: return CopyBio(view.getSubjectAltName(), length);
    case 1: return CopyBio(view.getInfoAccess(), length);
    case 2: return CopyBio(view.getValidFrom(), length);
    case 3: return CopyBio(view.getValidTo(), length);
    case 4: case 5: case 6: {
      const ncrypto::Digest& digest =
          field == 4 ? ncrypto::Digest::SHA1 : field == 5 ? ncrypto::Digest::SHA256 : ncrypto::Digest::SHA512;
      auto fingerprint = view.getFingerprint(digest);
      if (!fingerprint.has_value()) return nullptr;
      return Copy(fingerprint->data(), fingerprint->size(), length);
    }
    case 7: {
      // GetSerialNumber (260-266): upper-cased.
      auto serial = view.getSerialNumber();
      if (!serial) return nullptr;
      std::string text(static_cast<char*>(serial.get()));
      for (auto& c : text) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
      return Copy(text.data(), text.size(), length);
    }
    case 8: case 9: {
      char* result = nullptr;
      view.ifRsa([&](const ncrypto::Rsa& rsa) {
        auto key = rsa.getPublicKey();
        if (field == 8) {
          result = CopyBio(ncrypto::BIOPointer::New(key.n), length);  // GetModulusString (676-681)
        } else if (key.e != nullptr) {
          // GetExponentString (683-691): "0x" and BN_print.
          ncrypto::BIOPointer bio = ncrypto::BIOPointer::NewMem();
          BIO_puts(bio.get(), "0x");
          BN_print(bio.get(), key.e);
          result = CopyBio(bio, length);
        }
        return true;
      });
      return result;
    }
    case 10: case 11: {
      char* result = nullptr;
      view.ifEc([&](const ncrypto::Ec& ec) {
        int nid = ec.getCurve();
        if (nid != 0) {
          const char* name = field == 10 ? OBJ_nid2sn(nid) : EC_curve_nid2nist(nid);
          if (name != nullptr && name[0] != 0) result = Copy(name, strlen(name), length);
        }
        return true;
      });
      return result;
    }
    case 12: return CopyBio(view.toPEM(), length);
    case 13: {
      auto algorithm = view.getSignatureAlgorithm();
      return algorithm.has_value() ? Copy(algorithm->data(), algorithm->size(), length) : nullptr;
    }
    case 14: {
      auto oid = view.getSignatureAlgorithmOID();
      return oid.has_value() ? Copy(oid->data(), oid->size(), length) : nullptr;
    }
  }
  return nullptr;
}

CRYPTO_EXPORT(tabnode_x509_is_ca) int tabnode_x509_is_ca(X509* x) { return ncrypto::X509View(x).isCA(); }

// bits: the RSA modulus's bit count (BignumPointer::GetBitCount) or the EC group's order bits
// (GetECGroupBits, 703-712); -1 for "undefined".
CRYPTO_EXPORT(tabnode_x509_bits) int tabnode_x509_bits(X509* x) {
  ncrypto::X509View view(x);
  int bits = -1;
  view.ifRsa([&](const ncrypto::Rsa& rsa) {
    bits = ncrypto::BignumPointer::GetBitCount(rsa.getPublicKey().n);
    return true;
  });
  view.ifEc([&](const ncrypto::Ec& ec) {
    const EC_GROUP* group = ec.getGroup();
    int b = group ? EC_GROUP_order_bits(group) : 0;
    bits = b > 0 ? b : -1;
    return true;
  });
  return bits;
}

// pubkey: the RSA key's DER (GetPubKey, 669-674) or the EC point in the key's conversion form (GetECPubKey,
// 693-701); null for "undefined".
CRYPTO_EXPORT(tabnode_x509_pubkey) unsigned char* tabnode_x509_pubkey(X509* x, size_t* length) {
  ncrypto::X509View view(x);
  unsigned char* result = nullptr;
  *length = 0;
  view.ifRsa([&](const ncrypto::Rsa& rsa) {
    auto bio = rsa.derPublicKey();
    if (bio) result = reinterpret_cast<unsigned char*>(CopyBio(bio, length));
    return true;
  });
  view.ifEc([&](const ncrypto::Ec& ec) {
    const EC_GROUP* group = ec.getGroup();
    const EC_POINT* point = ec.getPublicKey();
    if (group == nullptr || point == nullptr) return true;
    point_conversion_form_t form = ec.getPointConversionForm();
    size_t size = EC_POINT_point2oct(group, point, form, nullptr, 0, nullptr);
    if (size == 0) return true;
    result = static_cast<unsigned char*>(malloc(size));
    if (EC_POINT_point2oct(group, point, form, result, size, nullptr) != size) {
      free(result);
      result = nullptr;
      return true;
    }
    *length = size;
    return true;
  });
  return result;
}

// ext_key_usage (GetKeyUsage, 268-275): the usages NUL-separated; null for "undefined".
CRYPTO_EXPORT(tabnode_x509_key_usage) char* tabnode_x509_key_usage(X509* x, size_t* length) {
  std::string out;
  *length = 0;
  bool ok = ncrypto::X509View(x).enumUsages([&](const char* usage) {
    out.append(usage);
    out.push_back('\0');
  });
  if (!ok) return nullptr;
  return Copy(out.data(), out.size(), length);
}

// The DER, malloc'd (GetDer, 172-181).
CRYPTO_EXPORT(tabnode_x509_der) size_t tabnode_x509_der(X509* x, unsigned char** out) { return ToDer(x, out); }

// X509Certificate::GetIssuerCert's walk (GetPeerCertificate's chain, crypto_common.cc): whether `issuer` issued `x`.
CRYPTO_EXPORT(tabnode_x509_issued_by) int tabnode_x509_issued_by(X509* x, X509* issuer) {
  return ncrypto::X509View(x).isIssuedBy(ncrypto::X509View(issuer));
}

