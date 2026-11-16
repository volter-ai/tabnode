// THE SIGNATURES OF THE crypto BINDING (Tabnode ADR-0018 §5, item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_sig.cc, over ncrypto and OpenSSL in libnode.so: Sign, Verify and SignJob, and the signature
// conversions the engine device's answers take (P1363 to DER and back). Which signatures OpenSSL answers and which the
// device answers is the binding's routing (src/node-lib/binding/crypto_sig.ts). The helpers from ApplyRSAOptions to
// VerifyPrehashed (crypto_sig.cc:76-226, 289-335, 382-504) are Node's, unchanged but for DCHECK, CHECK and their
// `env` argument.
#include <openssl/core_names.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/obj_mac.h>

#include <cstring>
#include <optional>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::ClearErrorOnReturn;
using ncrypto::DataPointer;
using ncrypto::Digest;
using ncrypto::ECDSASigPointer;
using ncrypto::ECKeyPointer;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;
using ncrypto::EVPMDCtxPointer;

#define DCHECK(condition)
#define CHECK(condition) \
  if (!(condition)) abort()
#define CHECK_NOT_NULL(value) CHECK((value) != nullptr)
#define Environment void
#ifndef OPENSSL_WITH_SIGNATURE_CONTEXT_STRING
#define OPENSSL_WITH_SIGNATURE_CONTEXT_STRING 0
#endif

static const unsigned int kNoDsaSignature = static_cast<unsigned int>(-1);
enum class DSASigEnc { DER, P1363, Invalid };

#if OPENSSL_WITH_PQC
bool IsPqcSignatureKeyId(int id);
#endif

namespace {
// SignBase::Error (crypto_sig.h:20-30).
enum class Error { Ok, UnknownDigest, Init, NotInitialised, Update, PrivateKey, PublicKey, MalformedSignature,
  ContextUnsupported };

// GetPaddingFromJS, GetSaltLenFromJS, GetDSASigEncFromJS (49-74), over a TnValue.
int GetPaddingFromJS(const EVPKeyPointer& key, const TnValue& val) {
  int padding = key.getDefaultSignPadding();
  if (!val.IsUndefined()) {
    CHECK(val.IsInt32());
    padding = val.Int32();
  }
  return padding;
}
std::optional<int> GetSaltLenFromJS(const TnValue& val) {
  std::optional<int> salt_len;
  if (!val.IsUndefined()) {
    CHECK(val.IsInt32());
    salt_len = val.Int32();
  }
  return salt_len;
}
DSASigEnc GetDSASigEncFromJS(const TnValue& val) {
  CHECK(val.IsInt32());
  int i = val.Int32();
  if (i < 0 || i >= static_cast<int>(DSASigEnc::Invalid)) return DSASigEnc::Invalid;
  return static_cast<DSASigEnc>(i);
}

bool ApplyRSAOptions(const EVPKeyPointer& pkey,
                     EVP_PKEY_CTX* pkctx,
                     int padding,
                     std::optional<int> salt_len) {
  if (pkey.isRsaVariant()) {
    return EVPKeyCtxPointer::setRsaPadding(pkctx, padding, salt_len);
  }
  return true;
}

constexpr size_t kEd25519PointSize = 32;
constexpr size_t kEd448PointSize = 57;

// Ed25519 has cofactor 8, so the first eight entries are the full
// canonical small-order subgroup: identity, one point of order 2,
// two points of order 4, and four points of order 8.
constexpr unsigned char kEd25519SmallOrderPoints[][kEd25519PointSize] = {
    // Identity.
    {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
    // Order 2.
    {0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
    // Order 4.
    {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80},
    {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
    // Order 8.
    {0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b,
     0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39,
     0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a},
    {0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b,
     0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39,
     0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0xfa},
    {0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4,
     0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6,
     0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05},
    {0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4,
     0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6,
     0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x85},
    // Non-canonical encodings of the same small-order points.
    {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80},
    {0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
    {0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
    {0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
    {0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
    {0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
};

// Ed448 has cofactor 4, so these four entries are the full canonical
// small-order subgroup: identity, one point of order 2, and two points
// of order 4.
constexpr unsigned char kEd448SmallOrderPoints[][kEd448PointSize] = {
    // Identity.
    {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
    // Order 2.
    {0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00},
    // Order 4.
    {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
    {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80},
};

template <size_t PointSize, size_t Count>
bool ContainsPoint(const unsigned char* candidate,
                   const unsigned char (&points)[Count][PointSize]) {
  for (const auto& point : points) {
    if (memcmp(candidate, point, PointSize) == 0) return true;
  }
  return false;
}

bool IsSmallOrderEdDsaPoint(int id,
                            const unsigned char* candidate,
                            size_t size) {
  switch (id) {
    case EVP_PKEY_ED25519:
      return size == kEd25519PointSize &&
             ContainsPoint(candidate, kEd25519SmallOrderPoints);
    case EVP_PKEY_ED448:
      return size == kEd448PointSize &&
             ContainsPoint(candidate, kEd448SmallOrderPoints);
    default:
      return false;
  }
}

bool HasSmallOrderEdDsaPoint(const EVPKeyPointer& key,
                             const ByteSource& signature) {
  const int id = key.id();
  size_t point_size;

  switch (id) {
    case EVP_PKEY_ED25519:
      point_size = kEd25519PointSize;
      break;
    case EVP_PKEY_ED448:
      point_size = kEd448PointSize;
      break;
    default:
      return false;
  }

  if (signature.size() != point_size * 2) return false;

  if (IsSmallOrderEdDsaPoint(id, signature.data<unsigned char>(), point_size)) {
    return true;
  }

  unsigned char raw_public_key[kEd448PointSize];
  size_t raw_public_key_size = point_size;
  if (EVP_PKEY_get_raw_public_key(
          key.get(), raw_public_key, &raw_public_key_size) != 1) {
    return false;
  }

  return IsSmallOrderEdDsaPoint(id, raw_public_key, raw_public_key_size);
}


// Node_SignFinal (227-263), its signature a ByteSource.
ByteSource Node_SignFinal(EVPMDCtxPointer&& mdctx, const EVPKeyPointer& pkey, int padding,
                          std::optional<int> pss_salt_len) {
  auto data = mdctx.digestFinal(mdctx.getExpectedSize());
  if (!data) return {};
  auto sig = DataPointer::Alloc(pkey.size());
  ncrypto::Buffer<unsigned char> sig_buf{.data = sig.get<unsigned char>(), .len = pkey.size()};
  EVPKeyCtxPointer pkctx = pkey.newCtx();
  if (pkctx.initForSign() > 0 && ApplyRSAOptions(pkey, pkctx.get(), padding, pss_salt_len) &&
      pkctx.setSignatureMd(mdctx) && pkctx.signInto(data, &sig_buf)) {
    return ByteSource::CopyOf(sig.get(), sig_buf.len);
  }
  return {};
}

ByteSource ConvertSignatureToP1363(Environment* env,
                                   const EVPKeyPointer& pkey,
                                   const ByteSource& signature) {
  unsigned int n = pkey.getBytesOfRS().value_or(kNoDsaSignature);
  if (n == kNoDsaSignature) [[unlikely]]
    return {};

  auto data = DataPointer::Alloc(n * 2);
  if (!data) [[unlikely]]
    return {};
  unsigned char* out = static_cast<unsigned char*>(data.get());

  // Extracting the signature may not actually use all of the allocated space.
  // We need to ensure that the buffer is zeroed out before use.
  data.zero();

  if (!ncrypto::extractP1363(signature, out, n)) [[unlikely]] {
    return {};
  }

  return ByteSource::Allocated(data.release());
}

ByteSource ConvertSignatureToDER(const EVPKeyPointer& pkey, ByteSource&& out) {
  unsigned int n = pkey.getBytesOfRS().value_or(kNoDsaSignature);
  if (n == kNoDsaSignature) return std::move(out);

  const unsigned char* sig_data = out.data<unsigned char>();

  if (out.size() != 2 * n) return {};

  auto asn1_sig = ECDSASigPointer::New();
  CHECK(asn1_sig);
  BignumPointer r(sig_data, n);
  CHECK(r);
  BignumPointer s(sig_data + n, n);
  CHECK(s);
  CHECK(asn1_sig.setParams(std::move(r), std::move(s)));

  auto buf = asn1_sig.encode();
  if (buf.len <= 0) [[unlikely]]
    return {};

  CHECK_NOT_NULL(buf.data);
  return ByteSource::Allocated(buf);
}


// CheckThrow (336-380).
void CheckThrow(Error error) {
  switch (error) {
    case Error::UnknownDigest:
      return Throw("ERR_CRYPTO_INVALID_DIGEST");
    case Error::NotInitialised:
      return Throw("ERR_CRYPTO_INVALID_STATE", "Not initialised");
    case Error::MalformedSignature:
      return Throw("ERR_CRYPTO_OPERATION_FAILED", "Malformed signature");
    case Error::ContextUnsupported:
      return Throw("ERR_CRYPTO_OPERATION_FAILED", "Context parameter is unsupported");
    case Error::Init:
    case Error::Update:
    case Error::PrivateKey:
    case Error::PublicKey: {
      unsigned long err = ERR_get_error();  // NOLINT(runtime/int)
      if (err) return ThrowCrypto(err);
      switch (error) {
        case Error::Init:
          return Throw("ERR_CRYPTO_OPERATION_FAILED", "EVP_SignInit_ex failed");
        case Error::Update:
          return Throw("ERR_CRYPTO_OPERATION_FAILED", "EVP_SignUpdate failed");
        case Error::PrivateKey:
          return Throw("ERR_CRYPTO_OPERATION_FAILED", "PEM_read_bio_PrivateKey failed");
        case Error::PublicKey:
          return Throw("ERR_CRYPTO_OPERATION_FAILED", "PEM_read_bio_PUBKEY failed");
        default:
          abort();
      }
    }
    case Error::Ok:
      return;
  }
}

bool UseP1363Encoding(const EVPKeyPointer& key, const DSASigEnc dsa_encoding) {
  return key.isSigVariant() && dsa_encoding == DSASigEnc::P1363;
}

bool SupportsContextString(const EVPKeyPointer& key) {
  if (!OPENSSL_WITH_SIGNATURE_CONTEXT_STRING) return false;

  const int id = key.id();
#if OPENSSL_WITH_PQC
  if (IsPqcSignatureKeyId(id)) return true;
#endif
#ifndef OPENSSL_IS_BORINGSSL
  if (id == EVP_PKEY_ED25519 || id == EVP_PKEY_ED448) return true;
#endif
  return false;
}

// Returns true unless the key is known not to be SM2, so that a key whose curve
// cannot be determined opts out of the prehashed fallback rather than into it.
bool MayBeSM2Key(const EVPKeyPointer& key) {
#ifdef OPENSSL_IS_BORINGSSL
  return false;
#else
  if (key.id() == EVP_PKEY_SM2) return true;
  if (key.id() != EVP_PKEY_EC) return false;

#if NCRYPTO_USE_OPENSSL3_PROVIDER
  // An ECKeyPointer would also need the public point, which a provider-backed
  // key need not expose.
  char group_name[64];
  size_t group_name_len = 0;
  if (EVP_PKEY_get_utf8_string_param(key.get(),
                                     OSSL_PKEY_PARAM_GROUP_NAME,
                                     group_name,
                                     sizeof(group_name),
                                     &group_name_len) != 1) {
    return true;
  }
  return OBJ_sn2nid(group_name) == NID_sm2 ||
         EC_curve_nist2nid(group_name) == NID_sm2;
#else
  ECKeyPointer ec(key);
  if (!ec) return true;

  const EC_GROUP* group = ec.getGroup();
  if (group == nullptr) return true;
  return EC_GROUP_get_curve_name(group) == NID_sm2;
#endif
#endif
}

bool CanUsePrehashedFallback(const EVPKeyPointer& key,
                             const Digest& digest,
                             bool has_context) {
  if (!digest || has_context) return false;

  if (key.isRsaVariant()) return true;

  // SM2 digest signing first hashes the algorithm-specific Z value, so the
  // lower-level prehashed sign/verify operation is not equivalent.
  return key.isSigVariant() && !MayBeSM2Key(key);
}

ByteSource SignPrehashed(Environment* env,
                         const EVPKeyPointer& key,
                         const Digest& digest,
                         const ByteSource& input,
                         int padding,
                         std::optional<int> salt_length,
                         DSASigEnc dsa_encoding) {
  EVPMDCtxPointer context = EVPMDCtxPointer::New();
  if (!context || !context.digestInit(digest) || !context.digestUpdate(input))
      [[unlikely]] {
    return {};
  }

  auto data = context.digestFinal(context.getExpectedSize());
  if (!data) [[unlikely]] {
    return {};
  }

  EVPKeyCtxPointer pkctx = key.newCtx();
  if (!pkctx || pkctx.initForSign() <= 0 ||
      !ApplyRSAOptions(key, pkctx.get(), padding, salt_length) ||
      !pkctx.setSignatureMd(context)) [[unlikely]] {
    return {};
  }

  auto signature = pkctx.sign(data);
  if (!signature) [[unlikely]] {
    return {};
  }

  DCHECK(!signature.isSecure());
  auto out = ByteSource::Allocated(signature.release());
  if (UseP1363Encoding(key, dsa_encoding)) {
    return ConvertSignatureToP1363(env, key, std::move(out));
  }
  return out;
}

bool VerifyPrehashed(const EVPKeyPointer& key,
                     const Digest& digest,
                     const ByteSource& input,
                     const ByteSource& signature,
                     int padding,
                     std::optional<int> salt_length) {
  EVPMDCtxPointer context = EVPMDCtxPointer::New();
  if (!context || !context.digestInit(digest) || !context.digestUpdate(input))
      [[unlikely]] {
    return false;
  }

  auto data = context.digestFinal(context.getExpectedSize());
  if (!data) [[unlikely]] {
    return false;
  }

  EVPKeyCtxPointer pkctx = key.newCtx();
  return pkctx && pkctx.initForVerify() > 0 &&
         ApplyRSAOptions(key, pkctx.get(), padding, salt_length) &&
         pkctx.setSignatureMd(context) && pkctx.verify(signature, data);
}
}  // namespace

// ---- Sign and Verify (507-796) ----------------------------------------------------------------------------------

// SignBase: its digest context.
struct TnSign {
  EVPMDCtxPointer mdctx;
};
CRYPTO_EXPORT(tabnode_sign_new) TnSign* tabnode_sign_new() { return new TnSign(); }
CRYPTO_EXPORT(tabnode_sign_free) void tabnode_sign_free(TnSign* sign) { delete sign; }

// SignInit, VerifyInit (588-595, 698-705): SignBase::Init (507-521); 0 where it threw.
CRYPTO_EXPORT(tabnode_sign_init) int tabnode_sign_init(TnSign* sign, const char* digest) {
  if (sign->mdctx) abort();
  auto md = Digest::FromName(digest);
  Error error = Error::Ok;
  if (!md) {
    error = Error::UnknownDigest;
  } else {
    sign->mdctx = EVPMDCtxPointer::New();
    if (!sign->mdctx.digestInit(md)) {
      sign->mdctx.reset();
      error = Error::Init;
    }
  }
  CheckThrow(error);
  return error == Error::Ok ? 1 : 0;
}

// SignUpdate, VerifyUpdate (597-606, 707-718): SignBase::Update (523-533); 0 where it threw.
CRYPTO_EXPORT(tabnode_sign_update) int tabnode_sign_update(TnSign* sign, const char* data, size_t size) {
  if (size > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too long");
    return 0;
  }
  Error error = Error::Ok;
  if (sign->mdctx == nullptr) {
    error = Error::NotInitialised;
  } else if (!sign->mdctx.digestUpdate(ncrypto::Buffer<const void>{.data = data, .len = size})) {
    error = Error::Update;
  }
  CheckThrow(error);
  return error == Error::Ok ? 1 : 0;
}

// Sign::SignFinal (608-669): the key's five slots, then padding, salt length and DSA encoding; the signature, null
// where it threw.
CRYPTO_EXPORT(tabnode_sign_final) char* tabnode_sign_final(TnSign* sign, const TnValue* args, uint32_t count,
                                                          size_t* length) {
  ClearErrorOnReturn clear_error_on_return;
  unsigned int offset = 0;
  auto data = KeyObjectData::GetPrivateKey(args, &offset, true);
  if (!data) return nullptr;
  const auto& key = data.GetAsymmetricKey();
  if (!key) return nullptr;
  if (key.isOneShotVariant()) {
    Throw("ERR_CRYPTO_UNSUPPORTED_OPERATION");
    return nullptr;
  }
  int padding = GetPaddingFromJS(key, args[offset]);
  std::optional<int> salt_len = GetSaltLenFromJS(args[offset + 1]);
  DSASigEnc dsa_sig_enc = GetDSASigEncFromJS(args[offset + 2]);
  if (dsa_sig_enc == DSASigEnc::Invalid) {
    Throw("ERR_OUT_OF_RANGE", "invalid signature encoding");
    return nullptr;
  }
  if (!sign->mdctx) {
    CheckThrow(Error::NotInitialised);
    return nullptr;
  }
  EVPMDCtxPointer mdctx = std::move(sign->mdctx);
  if (!key.validateDsaParameters()) {
    CheckThrow(Error::PrivateKey);
    return nullptr;
  }
  ByteSource signature = Node_SignFinal(std::move(mdctx), key, padding, salt_len);
  if (!signature) {
    CheckThrow(Error::PrivateKey);
    return nullptr;
  }
  if (dsa_sig_enc == DSASigEnc::P1363) {
    // ConvertSignatureToP1363's BackingStore form (265-287): the DER as it is where it is no DSA signature.
    ByteSource p1363 = ConvertSignatureToP1363(nullptr, key, signature);
    if (p1363) signature = std::move(p1363);
  }
  return signature.Answer(length);
}

// Verify::VerifyFinal (720-796): the key's five slots, then the signature, padding, salt length and DSA encoding;
// 1 or 0, -1 where it threw.
CRYPTO_EXPORT(tabnode_verify_final) int tabnode_verify_final(TnSign* verify, const TnValue* args, uint32_t count) {
  ClearErrorOnReturn clear_error_on_return;
  unsigned int offset = 0;
  auto data = KeyObjectData::GetPublicOrPrivateKey(args, &offset);
  if (!data) return -1;
  const auto& key = data.GetAsymmetricKey();
  if (!key) return -1;
  if (key.isOneShotVariant()) {
    Throw("ERR_CRYPTO_UNSUPPORTED_OPERATION");
    return -1;
  }
  const TnValue& hbuf = args[offset];
  if (hbuf.length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "buffer is too big");
    return -1;
  }
  int padding = GetPaddingFromJS(key, args[offset + 1]);
  std::optional<int> salt_len = GetSaltLenFromJS(args[offset + 2]);
  DSASigEnc dsa_sig_enc = GetDSASigEncFromJS(args[offset + 3]);
  if (dsa_sig_enc == DSASigEnc::Invalid) {
    Throw("ERR_OUT_OF_RANGE", "invalid signature encoding");
    return -1;
  }
  ByteSource signature = hbuf.Bytes();
  if (dsa_sig_enc == DSASigEnc::P1363) {
    signature = ConvertSignatureToDER(key, hbuf.Bytes());
    if (signature.data() == nullptr) {
      CheckThrow(Error::MalformedSignature);
      return -1;
    }
  }
  if (!verify->mdctx) {
    CheckThrow(Error::NotInitialised);
    return -1;
  }
  bool verify_result = false;
  EVPMDCtxPointer mdctx = std::move(verify->mdctx);
  auto digest = mdctx.digestFinal(mdctx.getExpectedSize());
  if (!digest) {
    CheckThrow(Error::PublicKey);
    return -1;
  }
  EVPKeyCtxPointer pkctx = key.newCtx();
  if (pkctx) {
    const int init_ret = pkctx.initForVerify();
    if (init_ret == -2) {
      CheckThrow(Error::PublicKey);
      return -1;
    }
    if (init_ret > 0 && ApplyRSAOptions(key, pkctx.get(), padding, salt_len) && pkctx.setSignatureMd(mdctx)) {
      verify_result = pkctx.verify(signature, digest);
    }
  }
  return verify_result ? 1 : 0;
}

// ---- SignJob (798-1062) -----------------------------------------------------------------------------------------

namespace {
struct SignConfiguration {
  enum Mode { Sign, Verify };
  enum Flags { kHasNone = 0, kHasSaltLength = 1, kHasPadding = 2, kHasContextString = 4 };
  Mode mode;
  KeyObjectData key;
  ByteSource data;
  ByteSource signature;
  // Node's config keeps a Digest, which cannot move; its EVP_MD is the same.
  const EVP_MD* digest = nullptr;
  int flags = kHasNone;
  int padding = 0;
  int salt_length = 0;
  DSASigEnc dsa_encoding = DSASigEnc::DER;
  ByteSource context_string;
};

// SignTraits::DeriveBits (917-1049): a synchronous job's failure is thrown (CheckThrow), as Node's.
bool DeriveSign(const SignConfiguration& params, ByteSource* out, CryptoJobMode mode) {
  bool can_throw = mode == kCryptoJobSync;
  const auto& key = params.key.GetAsymmetricKey();
  Digest digest(params.digest);
  bool has_context = (params.flags & SignConfiguration::kHasContextString && params.context_string.size() > 0);
  if (has_context && !SupportsContextString(key)) {
    if (can_throw) CheckThrow(Error::ContextUnsupported);
    return false;
  }
  int padding = params.flags & SignConfiguration::kHasPadding ? params.padding : key.getDefaultSignPadding();
  std::optional<int> salt_length = params.flags & SignConfiguration::kHasSaltLength
                                       ? std::optional<int>(params.salt_length)
                                       : std::nullopt;
  auto context = EVPMDCtxPointer::New();
  if (!context) return false;
  std::optional<EVP_PKEY_CTX*> ctx;
  if (has_context) {
    ncrypto::Buffer<const unsigned char> context_buf{.data = params.context_string.data<unsigned char>(),
                                                     .len = params.context_string.size()};
    ctx = params.mode == SignConfiguration::Sign ? context.signInitWithContext(key, digest, context_buf)
                                                 : context.verifyInitWithContext(key, digest, context_buf);
  } else {
    ctx = params.mode == SignConfiguration::Sign ? context.signInit(key, digest) : context.verifyInit(key, digest);
  }
  if (!ctx.has_value()) {
    if (can_throw) CheckThrow(Error::Init);
    return false;
  }
  if (!ApplyRSAOptions(key, *ctx, padding, salt_length)) {
    if (can_throw) CheckThrow(Error::PrivateKey);
    return false;
  }
  switch (params.mode) {
    case SignConfiguration::Sign: {
      if (key.isOneShotVariant()) {
        auto data = context.signOneShot(params.data);
        if (!data) {
          if (can_throw) CheckThrow(Error::PrivateKey);
          return false;
        }
        *out = ByteSource::Allocated(data.release());
      } else {
        auto data = context.sign(params.data);
        if (!data && CanUsePrehashedFallback(key, digest, has_context)) {
          *out = SignPrehashed(nullptr, key, digest, params.data, padding, salt_length, params.dsa_encoding);
          if (!*out && can_throw) CheckThrow(Error::PrivateKey);
          return static_cast<bool>(*out);
        }
        if (!data) {
          if (can_throw) CheckThrow(Error::PrivateKey);
          return false;
        }
        auto bs = ByteSource::Allocated(data.release());
        if (UseP1363Encoding(key, params.dsa_encoding)) {
          *out = ConvertSignatureToP1363(nullptr, key, std::move(bs));
        } else {
          *out = std::move(bs);
        }
      }
      break;
    }
    case SignConfiguration::Verify: {
      auto buf = DataPointer::Alloc(1);
      static_cast<char*>(buf.get())[0] = 0;
      int verify_result = context.verifyOneShot(params.data, params.signature);
      if (verify_result == 1 && !HasSmallOrderEdDsaPoint(key, params.signature)) {
        static_cast<char*>(buf.get())[0] = 1;
      } else if (verify_result < 0 && CanUsePrehashedFallback(key, digest, has_context) &&
                 VerifyPrehashed(key, digest, params.data, params.signature, padding, salt_length)) {
        static_cast<char*>(buf.get())[0] = 1;
      }
      *out = ByteSource::Allocated(buf.release());
    }
  }
  return true;
}
}  // namespace

// SignTraits::AdditionalConfig (824-915): `args` from the sign mode on (Node's `offset`); null where it threw.
CRYPTO_EXPORT(tabnode_sign_job_new) CryptoJob* tabnode_sign_job_new(int32_t mode, const TnValue* args,
                                                                   uint32_t count) {
  ClearErrorOnReturn clear_error_on_return;
  SignConfiguration params;
  const unsigned int offset = 0;
  CHECK(args[offset].IsUint32());
  params.mode = static_cast<SignConfiguration::Mode>(args[offset].Uint32());
  unsigned int keyParamOffset = offset + 1;
  if (params.mode == SignConfiguration::Verify) {
    auto data = KeyObjectData::GetPublicOrPrivateKey(args, &keyParamOffset);
    if (!data) return nullptr;
    params.key = std::move(data);
  } else {
    auto data = KeyObjectData::GetPrivateKey(args, &keyParamOffset, true);
    if (!data) return nullptr;
    params.key = std::move(data);
  }
  const TnValue& data = args[offset + 6];
  if (data.length > INT_MAX) {
    Throw("ERR_OUT_OF_RANGE", "data is too big");
    return nullptr;
  }
  params.data = data.Bytes();
  if (args[offset + 7].IsString()) {
    std::string digest = args[offset + 7].String();
    params.digest = Digest::FromName(digest.c_str()).get();
    if (params.digest == nullptr) {
      Throw("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: %s", digest.c_str());
      return nullptr;
    }
  }
  if (args[offset + 8].IsInt32()) {
    params.flags |= SignConfiguration::kHasSaltLength;
    params.salt_length = GetSaltLenFromJS(args[offset + 8]).value_or(params.salt_length);
  }
  if (args[offset + 9].IsUint32()) {
    params.flags |= SignConfiguration::kHasPadding;
    params.padding = GetPaddingFromJS(params.key.GetAsymmetricKey(), args[offset + 9]);
  }
  if (args[offset + 10].IsUint32()) {
    params.dsa_encoding = GetDSASigEncFromJS(args[offset + 10]);
    if (params.dsa_encoding == DSASigEnc::Invalid) {
      Throw("ERR_OUT_OF_RANGE", "invalid signature encoding");
      return nullptr;
    }
  }
  if (!args[offset + 11].IsUndefined()) {
    if (args[offset + 11].length > 255) {
      Throw("ERR_OUT_OF_RANGE", "context string must be at most 255 bytes");
      return nullptr;
    }
    params.flags |= SignConfiguration::kHasContextString;
    params.context_string = args[offset + 11].Bytes();
  }
  if (params.mode == SignConfiguration::Verify) {
    const TnValue& signature = args[offset + 12];
    if (signature.length > INT_MAX) {
      Throw("ERR_OUT_OF_RANGE", "signature is too big");
      return nullptr;
    }
    std::lock_guard<std::mutex> lock(params.key.mutex());
    const auto& akey = params.key.GetAsymmetricKey();
    params.signature = UseP1363Encoding(akey, params.dsa_encoding) ? ConvertSignatureToDER(akey, signature.Bytes())
                                                                   : signature.Bytes();
  }
  return new DeriveBitsJob<SignConfiguration>(JobMode(mode), std::move(params), DeriveSign);
}

// SignTraits::EncodeOutput's verify branch (1051-1061).
CRYPTO_EXPORT(tabnode_sign_job_verified) int tabnode_sign_job_verified(CryptoJob* job) {
  return job->out.size() > 0 && job->out.data<char>()[0] == 1 ? 1 : 0;
}

// ---- What the engine device's signatures take (ADR-0018 §5) -----------------------------------------------------

// The key's EVP_PKEY id, which the routing reads to name its WebCrypto algorithm.
CRYPTO_EXPORT(tabnode_key_id) int tabnode_key_id(const KeyObjectData* key) { return key->GetAsymmetricKey().id(); }
// The key's curve's NID (EC_GROUP_get_curve_name), NID_undef for none.
CRYPTO_EXPORT(tabnode_key_curve) int tabnode_key_curve(const KeyObjectData* key) {
  ECKeyPointer ec(key->GetAsymmetricKey());
  return ec ? EC_GROUP_get_curve_name(ec.getGroup()) : NID_undef;
}
// A handle's data of the public half of the key (addRefWithType(kKeyTypePublic)).
CRYPTO_EXPORT(tabnode_key_public_of) KeyObjectData* tabnode_key_public_of(const KeyObjectData* key) {
  return new KeyObjectData(key->addRefWithType(kKeyTypePublic));
}
// A WebCrypto signature (P1363, the device's) as Node's DER (ConvertSignatureToDER), and Node's DER as P1363
// (ConvertSignatureToP1363); null where it is malformed.
CRYPTO_EXPORT(tabnode_sig_to_der) char* tabnode_sig_to_der(const KeyObjectData* key, const void* sig, size_t size,
                                                          size_t* length) {
  ByteSource out = ConvertSignatureToDER(key->GetAsymmetricKey(), ByteSource::CopyOf(sig, size));
  return out ? out.Answer(length) : nullptr;
}
CRYPTO_EXPORT(tabnode_sig_to_p1363) char* tabnode_sig_to_p1363(const KeyObjectData* key, const void* sig, size_t size,
                                                              size_t* length) {
  ByteSource der = ByteSource::CopyOf(sig, size);
  ByteSource out = ConvertSignatureToP1363(nullptr, key->GetAsymmetricKey(), der);
  return out ? out.Answer(length) : nullptr;
}
