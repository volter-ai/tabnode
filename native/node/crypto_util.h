// What the crypto binding's glue shares (Tabnode ADR-0018 §1, §5, item 7; ADR-0016 §3), as Node v24.21.0's
// src/crypto/crypto_util.h declares it for src/crypto/*.cc: the OpenSSL half of Node's crypto_*.cc, over ncrypto and
// OpenSSL in libnode.so, with the V8 half (argument unwrapping, result objects, MakeCallback) removed. That half is the
// engine's TypeScript (src/node-lib/binding/openssl.ts, crypto_util.ts and the bindings over them), which calls these
// files' exports through the program and reads their answers in the process's memory. Every function names the lines
// it carries. Nothing here is a policy of the engine's own: where a body differs from Node's, the difference is said
// at the site. Which calls OpenSSL answers and which the engine device answers is ADR-0018 §5's routing, the
// binding's (crypto_util.ts `route`); this file is the OpenSSL side.
//
// The three shapes the exports share, in place of V8's:
// - **A thrown error.** Where Node's C++ throws (THROW_ERR_* of src/node_errors.h, ThrowCryptoError), the glue records
//   the error (Throw, ThrowCrypto) and answers its failure (0, -1 or NULL as the export says); the engine reads the
//   record (tabnode_thrown_*) and throws it, so the decision and its message are the C++'s and the Error object is
//   V8's half.
// - **A value whose kind Node's C++ decides on** (the key arguments' five slots, a JWK's members): a TnValue, which the
//   engine writes as V8 answers IsString(), IsInt32(), IsArrayBufferView() and the rest of that value.
// - **An answer of several members** (a key's details, a JWK): a TnFields, whose members the engine sets on the object
//   Node's C++ fills.
// A JavaScript value's bytes are not in the process's memory (a browser's APIs refuse a view of shared memory), so the
// engine copies them in for a call and frees them after it: where Node's config keeps a borrowed view for a synchronous
// job (ArrayBufferOrViewContents::ToByteSource), the glue copies, as Node does for an asynchronous one (ToCopy).
#ifndef TABNODE_CRYPTO_UTIL_H
#define TABNODE_CRYPTO_UTIL_H

#include <openssl/bio.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include <climits>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "engine.h"
#include "ncrypto.h"

#define CRYPTO_EXPORT(name) extern "C" __attribute__((export_name(#name)))

// SecureContext (crypto_context.cc): its SSL_CTX and what Node's object keeps beside it.
struct TnContext {
  SSL_CTX* ctx = nullptr;
  X509_STORE* own_cert_store = nullptr;
  unsigned char ticket_key_name[16];
  unsigned char ticket_key_hmac[16];
  unsigned char ticket_key_aes[16];
};

// TLSWrap (crypto_tls.cc): its SSL, its two memory BIOs and the state Node's wrap keeps in C++. Its address names the
// connection in every call of the engine's and every callback into it (engine.h tls_*), as Node's SSL app data names
// its wrap.
struct TnSsl {
  SSL* ssl = nullptr;
  BIO* enc_in = nullptr;
  BIO* enc_out = nullptr;
  TnContext* sc = nullptr;
  bool is_server = false;
  bool session_callbacks = false;
  bool alpn_callback_enabled = false;
  std::vector<unsigned char> alpn_protos;
};

// The process's root store (crypto_context.cc GetOrCreateRootCertStore); null until its first ask.
X509_STORE* RootStore();
extern X509_STORE* root_store;

// The TnContext an SSL_CTX belongs to (its ex_data).
TnContext* ContextOf(const SSL_CTX* ctx);

// A malloc'd copy of `text`, NUL-terminated, its length in *length; null where memory is out.
char* Copy(const char* text, size_t size, size_t* length);
// A memory BIO's bytes, copied as Copy copies; null for an empty pointer ("undefined" in Node's object).
char* CopyBio(const ncrypto::BIOPointer& bio, size_t* length);
// A certificate's DER (i2d_X509, malloc'd by OpenSSL) at *out; answers its length, 0 for none.
size_t ToDer(X509* cert, unsigned char** out);

// ---- A thrown error ------------------------------------------------------------------------------------------------

// THROW_ERR_<code>(env, message) (src/node_errors.h): `code` is Node's (ERR_CRYPTO_INVALID_JWK), whose error class and
// default message (a null `format`) are the engine's table of node_errors.h:44-236; printf-formatted as SPrintF formats.
void Throw(const char* code, const char* format = nullptr, ...) __attribute__((format(printf, 2, 3)));
// ThrowCryptoError (crypto_util.cc:653-677): the message is ERR_error_string_n's of `err` where it is nonzero (or
// there is no `message`), else `message`; the rest of OpenSSL's queue is the error's opensslErrorStack (Capture), and
// error::Decorate names `err`'s library, reason and code.
void ThrowCrypto(unsigned long err, const char* message = nullptr);  // NOLINT(runtime/int)
// Whether an error is recorded (V8's HasPendingException).
bool HasThrown();

// ---- Bytes ---------------------------------------------------------------------------------------------------------

// ByteSource (crypto_util.h:150-247): bytes the glue owns (Allocated, freed by OPENSSL_clear_free) or borrows
// (Foreign).
class ByteSource final {
 public:
  ByteSource() = default;
  ByteSource(ByteSource&& other) noexcept;
  ~ByteSource();
  ByteSource& operator=(ByteSource&& other) noexcept;
  ByteSource(const ByteSource&) = delete;
  ByteSource& operator=(const ByteSource&) = delete;

  template <typename T = void>
  inline const T* data() const {
    return reinterpret_cast<const T*>(data_);
  }
  template <typename T = void>
  operator ncrypto::Buffer<const T>() const {
    return ncrypto::Buffer<const T>{.data = data<T>(), .len = size()};
  }
  inline size_t size() const { return size_; }
  inline bool empty() const { return size_ == 0; }
  inline operator bool() const { return data_ != nullptr; }
  inline ncrypto::BignumPointer ToBN() const { return ncrypto::BignumPointer(data<unsigned char>(), size()); }

  // The bytes as the engine takes them (an ArrayBuffer or a Buffer of them): a malloc'd copy, *length its length.
  char* Answer(size_t* length) const;

  static ByteSource Allocated(void* data, size_t size);
  template <typename T>
  static ByteSource Allocated(const ncrypto::Buffer<T>& buffer) {
    return Allocated(buffer.data, buffer.len);
  }
  static ByteSource Foreign(const void* data, size_t size);
  // A copy of `size` bytes (ArrayBufferOrViewContents::ToCopy).
  static ByteSource CopyOf(const void* data, size_t size);
  static ByteSource FromBIO(const ncrypto::BIOPointer& bio);

 private:
  friend void TruncateToBitLength(size_t length_bits, ByteSource* bytes);
  const void* data_ = nullptr;
  void* allocated_data_ = nullptr;
  size_t size_ = 0;
  ByteSource(const void* data, void* allocated_data, size_t size)
      : data_(data), allocated_data_(allocated_data), size_(size) {}
};

void TruncateToBitLength(size_t length_bits, ByteSource* bytes);

template <typename T>
constexpr T NumBitsToBytes(T bits) {
  return (bits / CHAR_BIT) + ((CHAR_BIT - 1 + (bits % CHAR_BIT)) / CHAR_BIT);
}

// ---- A value whose kind Node's C++ reads ---------------------------------------------------------------------------

enum TnKind : int32_t {
  kTnUndefined = 0,
  kTnNull = 1,
  kTnInt32 = 2,    // a number IsInt32() answers true for: `number`
  kTnNumber = 3,   // any other number: `number`
  kTnBoolean = 4,  // `number` 1 or 0
  kTnString = 5,   // `data`: its UTF-8 (Utf8Value), `length` bytes; `decoded`: its bytes as base64 (FromEncodedString)
  kTnBuffer = 6,   // an ArrayBuffer, a SharedArrayBuffer or an ArrayBufferView (IsAnyBufferSource): `data`'s bytes
  kTnKey = 7,      // a KeyObjectHandle: `data` is its KeyObjectData*
  kTnObject = 8,   // any other object: `data` is a TnProperty array of `length` members (its own enumerable ones)
};

struct TnValue {
  int32_t kind;
  uint32_t reserved;
  double number;
  const unsigned char* data;
  uint32_t length;
  const unsigned char* decoded;
  uint32_t decoded_length;

  bool IsUndefined() const { return kind == kTnUndefined; }
  bool IsNullOrUndefined() const { return kind == kTnUndefined || kind == kTnNull; }
  bool IsInt32() const { return kind == kTnInt32; }
  bool IsUint32() const { return kind == kTnInt32 && number >= 0; }
  bool IsString() const { return kind == kTnString; }
  bool IsTrue() const { return kind == kTnBoolean && number != 0; }
  bool IsAnyBufferSource() const { return kind == kTnBuffer; }
  bool IsKey() const { return kind == kTnKey; }
  // V8's IsObject(): a buffer source and a handle are objects too.
  bool IsObject() const { return kind == kTnBuffer || kind == kTnKey || kind == kTnObject; }
  int32_t Int32() const { return static_cast<int32_t>(number); }
  uint32_t Uint32() const { return static_cast<uint32_t>(number); }
  std::string String() const { return std::string(reinterpret_cast<const char*>(data), length); }
  // ByteSource::FromStringOrBuffer: a string's UTF-8 or a buffer's bytes, copied.
  ByteSource Bytes() const { return ByteSource::CopyOf(data, length); }
  // ByteSource::FromEncodedString(BASE64).
  ByteSource Decoded() const { return ByteSource::CopyOf(decoded, decoded_length); }
  // The KeyObjectData a handle holds.
  const class KeyObjectData& Key() const { return *reinterpret_cast<const class KeyObjectData*>(data); }
  // A member of an object (kTnObject) by name: undefined where it has none (V8's Get).
  const TnValue& Get(const char* name) const;
  ncrypto::Buffer<const unsigned char> View() const { return {.data = data, .len = length}; }
};
static_assert(sizeof(TnValue) == 32, "the engine lays a TnValue out in 32 bytes (kind 0, number 8, data 16, length 20, decoded 24, decoded_length 28)");

struct TnProperty {
  const char* name;
  uint32_t reserved;
  TnValue value;
};
static_assert(sizeof(TnProperty) == 40, "the engine lays a TnProperty out in 40 bytes (name 0, value 8)");

// ---- An answer of several members ----------------------------------------------------------------------------------

// The members Node's C++ sets on a JavaScript object (target->Set), in order, as the engine sets them: each a kind
// byte, the name's length (u32) and the name, the value's length (u32) and the value.
class TnFields final {
 public:
  enum Kind : uint8_t {
    kString = 1,       // a string of the bytes' UTF-8
    kBase64Url = 2,    // a string of the bytes in base64url (StringBytes::Encode BASE64URL, EncodeBignum)
    kNumber = 3,       // a number (8 bytes, a double)
    kArrayBuffer = 4,  // an ArrayBuffer of the bytes
    kBoolean = 5,      // a boolean (1 byte)
    kBuffer = 6,       // a Buffer of the bytes
  };
  void String(const char* name, const std::string& value) { Add(kString, name, value.data(), value.size()); }
  void Base64Url(const char* name, const void* value, size_t size) { Add(kBase64Url, name, value, size); }
  void Number(const char* name, double value) { Add(kNumber, name, &value, sizeof(value)); }
  void ArrayBuffer(const char* name, const void* value, size_t size) { Add(kArrayBuffer, name, value, size); }
  void Buffer(const char* name, const void* value, size_t size) { Add(kBuffer, name, value, size); }
  void Boolean(const char* name, bool value) {
    unsigned char byte = value ? 1 : 0;
    Add(kBoolean, name, &byte, 1);
  }
  bool empty() const { return bytes_.empty(); }
  // The record as the engine takes it (malloc'd), *length its length.
  char* Answer(size_t* length) const;

 private:
  void Add(Kind kind, const char* name, const void* value, size_t size);
  std::string bytes_;
};

// SetEncodedValue (crypto_util.cc:829-844): a BIGNUM in base64url, padded to `size` bytes (0: its own length).
void SetEncodedValue(TnFields* target, const char* name, const BIGNUM* bn, int size = 0);

// ---- Keys ----------------------------------------------------------------------------------------------------------

enum KeyType { kKeyTypeSecret, kKeyTypePublic, kKeyTypePrivate };
enum KeyEncodingContext { kKeyContextInput, kKeyContextExport, kKeyContextGenerate };
enum class WebCryptoKeyExportStatus { OK, INVALID_KEY_TYPE, FAILED };

// KeyObjectData (crypto_keys.h:73-160): a secret's bytes or an asymmetric key, shared by every handle of it.
class KeyObjectData final {
 public:
  static KeyObjectData CreateSecret(ByteSource key);
  static KeyObjectData CreateAsymmetric(KeyType type, ncrypto::EVPKeyPointer&& pkey);

  KeyObjectData(std::nullptr_t = nullptr);

  inline operator bool() const { return data_ != nullptr; }

  KeyType GetKeyType() const;
  const ncrypto::EVPKeyPointer& GetAsymmetricKey() const;
  const char* GetSymmetricKey() const;
  size_t GetSymmetricKeySize() const;

  // GetPrivateKeyEncodingFromJs, GetPublicKeyEncodingFromJs (crypto_keys.cc:513-578): false where it threw.
  static bool GetPrivateKeyEncoding(const TnValue* args, unsigned int* offset, KeyEncodingContext context,
                                    ncrypto::EVPKeyPointer::PrivateKeyEncodingConfig* config);
  static bool GetPublicKeyEncoding(const TnValue* args, unsigned int* offset, KeyEncodingContext context,
                                   ncrypto::EVPKeyPointer::PublicKeyEncodingConfig* config);
  // GetPrivateKeyFromJs, GetPublicOrPrivateKeyFromJs (crypto_keys.cc:770-1042): empty where it threw.
  static KeyObjectData GetPrivateKey(const TnValue* args, unsigned int* offset, bool allow_key_object);
  static KeyObjectData GetPublicOrPrivateKey(const TnValue* args, unsigned int* offset,
                                             bool allow_private_key_store = false);

  // ToEncodedPublicKey / ToEncodedPrivateKey (crypto_keys.cc:372-511) where the encoding is not a key object: the
  // encoded key's bytes (PEM text or DER, raw bytes), or a JWK's members in `jwk`. False where it threw.
  bool ToEncodedPublicKey(const ncrypto::EVPKeyPointer::PublicKeyEncodingConfig& config, ByteSource* out,
                          TnFields* jwk) const;
  bool ToEncodedPrivateKey(const ncrypto::EVPKeyPointer::PrivateKeyEncodingConfig& config, ByteSource* out,
                           TnFields* jwk) const;

  inline KeyObjectData addRef() const { return KeyObjectData(key_type_, mutex_, data_); }
  inline KeyObjectData addRefWithType(KeyType type) const { return KeyObjectData(type, mutex_, data_); }

  std::mutex& mutex() const;

 private:
  explicit KeyObjectData(ByteSource symmetric_key);
  explicit KeyObjectData(KeyType type, ncrypto::EVPKeyPointer&& pkey);

  KeyType key_type_;
  mutable std::shared_ptr<std::mutex> mutex_;
  struct Data {
    const ByteSource symmetric_key;
    const ncrypto::EVPKeyPointer asymmetric_key;
    explicit Data(ByteSource symmetric_key) : symmetric_key(std::move(symmetric_key)) {}
    explicit Data(ncrypto::EVPKeyPointer asymmetric_key) : asymmetric_key(std::move(asymmetric_key)) {}
  };
  std::shared_ptr<Data> data_;

  KeyObjectData(KeyType type, std::shared_ptr<std::mutex> mutex, std::shared_ptr<Data> data)
      : key_type_(type), mutex_(mutex), data_(data) {}
};

// A KeyObjectHandle's data, as the engine's handle holds it: one reference, freed with the handle
// (tabnode_key_free).
KeyObjectData* NewHandleData(const KeyObjectData& data);

// ExportJWKInner (crypto_keys.cc:262-270): the key's JWK members; false where it threw.
bool ExportJWK(const KeyObjectData& key, TnFields* target, bool handle_rsa_pss);
// What crypto_keys.cc calls of crypto_rsa.cc, crypto_ec.cc, crypto_dsa.cc, crypto_dh.cc and crypto_pqc.cc.
bool ExportJWKRsaKey(const KeyObjectData& key, TnFields* target);
KeyObjectData ImportJWKRsaKey(const TnValue& jwk);
bool GetRsaKeyDetail(const KeyObjectData& key, TnFields* target);
bool ExportJWKEcKey(const KeyObjectData& key, TnFields* target);
KeyObjectData ImportJWKEcKey(const TnValue& jwk);
bool GetEcKeyDetail(const KeyObjectData& key, TnFields* target);
bool ExportJWKEdKey(const KeyObjectData& key, TnFields* target);
KeyObjectData ImportJWKEdKey(const TnValue& jwk);
bool GetDsaKeyDetail(const KeyObjectData& key, TnFields* target);
bool GetDhKeyDetail(const KeyObjectData& key, TnFields* target);
#if OPENSSL_WITH_PQC
bool IsPqcKeyId(int id);
bool IsPqcSeedKeyId(int id);
bool IsPqcRawPrivateKeyId(int id);
int GetPqcNidFromName(const char* name);
const char* GetPqcAsymmetricKeyType(int id);
bool ExportJwkPqcKey(const KeyObjectData& key, TnFields* target);
KeyObjectData ImportJWKPqcKey(const TnValue& jwk);
#endif
// ECPointToBuffer (crypto_ec.cc): a point's encoding in `form`; false where it threw.
bool ECPointToBuffer(const EC_GROUP* group, const EC_POINT* point, point_conversion_form_t form, ByteSource* out);
WebCryptoKeyExportStatus PKEY_SPKI_Export(const KeyObjectData& key_data, ByteSource* out);
WebCryptoKeyExportStatus PKEY_PKCS8_Export(const KeyObjectData& key_data, ByteSource* out);

// ---- Jobs ----------------------------------------------------------------------------------------------------------

enum CryptoJobMode { kCryptoJobAsync, kCryptoJobSync, kCryptoJobWebCrypto };
inline bool IsCryptoJobAsync(CryptoJobMode mode) { return mode == kCryptoJobAsync || mode == kCryptoJobWebCrypto; }
// GetCryptoJobMode (crypto_util.cc:732-737).
CryptoJobMode JobMode(int32_t mode);

// CryptoErrorStore (crypto_util.h:115-133, crypto_util.cc:247-259): the queue's errors as text, the last the message.
struct CryptoErrorStore final {
  void Capture();
  bool Empty() const { return errors_.empty(); }
  void Insert(const char* message) { errors_.emplace_back(message); }
  const std::vector<std::string>& errors() const { return errors_; }

 private:
  std::vector<std::string> errors_;
};

// CryptoJob (crypto_util.h:271-480) without V8: the work libuv's threadpool runs (ThreadPoolWork's uv_queue_work), its
// errors, and what its ToResult reads. Its address names it to the engine, in its exports and in `crypto_job_done`.
// A job of the async or WebCrypto mode is the loop's from its schedule and freed once its completion is made (Node's
// AfterThreadPoolWork, `std::unique_ptr<CryptoJob> ptr(this)`); a synchronous one is the engine's (MakeWeak), freed
// with its object.
class CryptoJob {
 public:
  explicit CryptoJob(CryptoJobMode mode) : mode_(mode) { work.data = this; }
  virtual ~CryptoJob() = default;
  virtual void DoThreadPoolWork() = 0;

  CryptoJobMode mode() const { return mode_; }
  CryptoErrorStore* errors() { return &errors_; }

  // What ToResult reads: success, the job's bytes, and a key pair's or a secret key's data.
  bool success = false;
  ByteSource out;
  KeyObjectData key;
  KeyObjectData second_key;

  uv_work_t work;

 private:
  const CryptoJobMode mode_;
  CryptoErrorStore errors_;
};

// DeriveBitsJob<Traits>::DoThreadPoolWork (crypto_util.h:516-531): `derive` fills `out`; a failure is the queue's
// errors, or Node's DERIVING_BITS_FAILED (or the job's own failure) where it has none.
template <typename Params>
class DeriveBitsJob final : public CryptoJob {
 public:
  using Derive = bool (*)(const Params& params, ByteSource* out, CryptoJobMode mode);
  DeriveBitsJob(CryptoJobMode mode, Params&& params, Derive derive, const char* failure = "Deriving bits failed")
      : CryptoJob(mode), params(std::move(params)), derive_(derive), failure_(failure) {}
  void DoThreadPoolWork() override {
    ncrypto::ClearErrorOnReturn clear_error_on_return;
    if (!derive_(params, &out, mode())) {
      errors()->Capture();
      if (errors()->Empty()) errors()->Insert(failure_);
      return;
    }
    success = true;
  }
  Params params;

 private:
  Derive derive_;
  const char* failure_;
};

// Node's messages for a job's failure (NODE_CRYPTO_ERROR_CODES_MAP, crypto_util.h:89-96).
constexpr const char* kCipherJobFailed = "Cipher job failed";
constexpr const char* kDerivingBitsFailed = "Deriving bits failed";
constexpr const char* kInvalidKeyType = "Invalid key type";
constexpr const char* kKeyGenerationJobFailed = "Key generation job failed";

#endif
