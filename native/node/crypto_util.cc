// THE crypto BINDING'S UTILITIES (Tabnode ADR-0018 item 7, ADR-0016 §3): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_util.cc, crypto_timing.cc and of the process's OpenSSL start in src/node.cc, over ncrypto and
// OpenSSL in libnode.so. The error queue as the binding reads it into Node's error shape (ThrowCryptoError), the
// process's OpenSSL configuration and InitCryptoOnce, the version string process.versions reads, the thrown error,
// ByteSource, a CryptoJob's threadpool work, and the binding's FIPS, engine, secure heap and timing calls.
#include <openssl/conf.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/provider.h>

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "crypto_util.h"

char* Copy(const char* text, size_t size, size_t* length) {
  char* out = static_cast<char*>(malloc(size + 1));
  if (out == nullptr) return nullptr;
  memcpy(out, text, size);
  out[size] = 0;
  *length = size;
  return out;
}

char* CopyBio(const ncrypto::BIOPointer& bio, size_t* length) {
  if (!bio) return nullptr;
  BUF_MEM* mem = bio;
  return Copy(mem->data, mem->length, length);
}

size_t ToDer(X509* cert, unsigned char** out) {
  *out = nullptr;
  if (cert == nullptr) return 0;
  int length = i2d_X509(cert, out);
  return length > 0 ? static_cast<size_t>(length) : 0;
}

// ---- The error queue -------------------------------------------------------------------------------------------

CRYPTO_EXPORT(tabnode_err_get) uint32_t tabnode_err_get() { return static_cast<uint32_t>(ERR_get_error()); }
CRYPTO_EXPORT(tabnode_err_peek) uint32_t tabnode_err_peek() { return static_cast<uint32_t>(ERR_peek_error()); }
CRYPTO_EXPORT(tabnode_err_clear) void tabnode_err_clear() { ERR_clear_error(); }
CRYPTO_EXPORT(tabnode_err_set_mark) void tabnode_err_set_mark() { ERR_set_mark(); }
CRYPTO_EXPORT(tabnode_err_pop_to_mark) void tabnode_err_pop_to_mark() { ERR_pop_to_mark(); }
CRYPTO_EXPORT(tabnode_err_lib) int tabnode_err_lib(uint32_t code) { return ERR_GET_LIB(code); }
CRYPTO_EXPORT(tabnode_err_lib_string) const char* tabnode_err_lib_string(uint32_t code) {
  return ERR_lib_error_string(code);
}
CRYPTO_EXPORT(tabnode_err_reason_string) const char* tabnode_err_reason_string(uint32_t code) {
  return ERR_reason_error_string(code);
}
// ThrowCryptoError's message (crypto_util.cc:653-677): ERR_error_string_n of the code.
CRYPTO_EXPORT(tabnode_err_string) void tabnode_err_string(uint32_t code, char* buffer, size_t length) {
  ERR_error_string_n(code, buffer, length);
}
// SetSessionIdContext's message (crypto_context.cc:2140-2150): ERR_print_errors into a memory BIO. Answers a malloc'd
// NUL-terminated string the caller frees.
CRYPTO_EXPORT(tabnode_err_print) char* tabnode_err_print() {
  BIO* bio = BIO_new(BIO_s_mem());
  if (bio == nullptr) return nullptr;
  ERR_print_errors(bio);
  char* data;
  long length = BIO_get_mem_data(bio, &data);
  size_t ignored;
  char* out = Copy(data, static_cast<size_t>(length), &ignored);
  BIO_free(bio);
  return out;
}
// GetBIOError (crypto_tls.cc:397-406): the last line ERR_print_errors_cb gives, malloc'd (the queue is consumed as
// Node's is), its length in *length.
CRYPTO_EXPORT(tabnode_err_bio_error) char* tabnode_err_bio_error(size_t* length) {
  std::string ret;
  ERR_print_errors_cb(
      [](const char* str, size_t len, void* opaque) {
        static_cast<std::string*>(opaque)->assign(str, len);
        return 0;
      },
      static_cast<void*>(&ret));
  return Copy(ret.data(), ret.size(), length);
}

// ---- The process's OpenSSL ---------------------------------------------------------------------------------------

// The process's OpenSSL start (src/node.cc:1183-1266, InitializeOncePerProcess) and InitCryptoOnce
// (crypto_util.cc:149-205), once. `conf_file` is --openssl-config's file, else OPENSSL_CONF's, else null (the default
// openssl.cnf in OPENSSLDIR, /etc/ssl, read through the process's kernel); `shared_config` is --openssl-shared-config,
// which reads the file's `openssl_conf` section instead of Node's `nodejs_conf` (NODE_OPENSSL_CONF_NAME, configure.py's
// default); `legacy_provider` is --openssl-legacy-provider; `secure_heap` and `secure_heap_min` are --secure-heap and
// --secure-heap-min (0: none). Answers 0, or the exit code Node's start returns for an OpenSSL configuration error
// (ERR_GET_REASON of the queue's head), with the queue left for the binding's message ("OpenSSL configuration error:"
// and GetOpenSSLErrorString, tabnode_err_print). Where Node runs this before the environment, the engine runs it at its
// crypto binding's first use, once the process's options are parsed: no OpenSSL call comes before it. Answers what the
// first call answered on every later call. A secure heap's failure is written to stderr, as Node writes it.
CRYPTO_EXPORT(tabnode_crypto_init) int tabnode_crypto_init(const char* conf_file, int shared_config,
                                                           int legacy_provider, size_t secure_heap,
                                                           size_t secure_heap_min) {
  static bool done = false;
  static int status = 0;
  if (done) return status;
  done = true;
  OPENSSL_INIT_SETTINGS* settings = OPENSSL_INIT_new();
  OPENSSL_INIT_set_config_filename(settings, conf_file);
  OPENSSL_INIT_set_config_appname(settings, shared_config ? "openssl_conf" : "nodejs_conf");
  OPENSSL_INIT_set_config_file_flags(settings, CONF_MFLAGS_IGNORE_MISSING_FILE);
  OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, settings);
  OPENSSL_INIT_free(settings);
  if (ERR_peek_error() != 0) return status = ERR_GET_REASON(ERR_peek_error());
  // Ensure CSPRNG is properly seeded (node.cc:1265-1266).
  if (!ncrypto::CSPRNG(nullptr, 0)) abort();
  // InitCryptoOnce.
  if (legacy_provider) {
    OSSL_PROVIDER* legacy = OSSL_PROVIDER_load(nullptr, "legacy");
    if (legacy == nullptr) fprintf(stderr, "Unable to load legacy provider.\n");
  }
  OPENSSL_init_ssl(0, nullptr);
  if (secure_heap != 0) {
    switch (ncrypto::DataPointer::TryInitSecureHeap(secure_heap, secure_heap_min)) {
      case ncrypto::DataPointer::InitSecureHeapResult::FAILED:
        fprintf(stderr, "Unable to initialize openssl secure heap.\n");
        break;
      case ncrypto::DataPointer::InitSecureHeapResult::UNABLE_TO_MEMORY_MAP:
        fprintf(stderr, "Unable to memory map openssl secure heap.\n");
        break;
      case ncrypto::DataPointer::InitSecureHeapResult::OK:
        break;
    }
  }
  // Turn off compression. Saves memory and protects against CRIME attacks.
  sk_SSL_COMP_zero(SSL_COMP_get_compression_methods());
#ifndef OPENSSL_NO_ENGINE
  ncrypto::EnginePointer::initEnginesOnce();
#endif
  return status;
}

// OpenSSL_version(OPENSSL_VERSION), from which process.versions.openssl is GetOpenSSLVersion's (node_metadata.cc:57-78).
CRYPTO_EXPORT(tabnode_openssl_version) const char* tabnode_openssl_version() {
  return OpenSSL_version(OPENSSL_VERSION);
}

// ---- A thrown error (Node's THROW_ERR_* and ThrowCryptoError, in place of V8's pending exception) ----------------

namespace {
struct Thrown {
  bool pending = false;
  std::string code;                 // Node's code, or "" for ThrowCryptoError's
  std::string message;              // the message, or "" for the code's default
  bool has_message = false;
  unsigned long err = 0;            // NOLINT(runtime/int) ThrowCryptoError's `err`, which Decorate reads
  std::vector<std::string> stack;   // ThrowCryptoError's opensslErrorStack
};
// The process's one: an export is called by the engine's one JavaScript thread, and a job's errors are its own store.
Thrown thrown;
}  // namespace

void Throw(const char* code, const char* format, ...) {
  thrown = Thrown();
  thrown.pending = true;
  thrown.code = code;
  if (format != nullptr) {
    char buffer[1024];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    thrown.message = buffer;
    thrown.has_message = true;
  }
}

void ThrowCrypto(unsigned long err, const char* message) {  // NOLINT(runtime/int)
  char message_buffer[128] = {0};
  if (err != 0 || message == nullptr) {
    ERR_error_string_n(err, message_buffer, sizeof(message_buffer));
    message = message_buffer;
  }
  thrown = Thrown();
  thrown.pending = true;
  thrown.message = message;
  thrown.has_message = true;
  thrown.err = err;
  CryptoErrorStore errors;
  errors.Capture();
  thrown.stack = errors.errors();
}

bool HasThrown() { return thrown.pending; }

// The record the engine throws (crypto_util.ts `rethrow`): whether one is pending, then its parts.
CRYPTO_EXPORT(tabnode_thrown) int tabnode_thrown() { return thrown.pending ? 1 : 0; }
CRYPTO_EXPORT(tabnode_thrown_code) const char* tabnode_thrown_code() { return thrown.code.c_str(); }
CRYPTO_EXPORT(tabnode_thrown_message) const char* tabnode_thrown_message() {
  return thrown.has_message ? thrown.message.c_str() : nullptr;
}
CRYPTO_EXPORT(tabnode_thrown_err) uint32_t tabnode_thrown_err() { return static_cast<uint32_t>(thrown.err); }
CRYPTO_EXPORT(tabnode_thrown_stack_count) uint32_t tabnode_thrown_stack_count() {
  return static_cast<uint32_t>(thrown.stack.size());
}
CRYPTO_EXPORT(tabnode_thrown_stack) const char* tabnode_thrown_stack(uint32_t index) {
  return thrown.stack[index].c_str();
}
CRYPTO_EXPORT(tabnode_thrown_clear) void tabnode_thrown_clear() { thrown = Thrown(); }

// ---- Bytes (crypto_util.cc:377-520) -----------------------------------------------------------------------------

ByteSource::ByteSource(ByteSource&& other) noexcept
    : data_(other.data_), allocated_data_(other.allocated_data_), size_(other.size_) {
  other.allocated_data_ = nullptr;
}
ByteSource::~ByteSource() { OPENSSL_clear_free(allocated_data_, size_); }
ByteSource& ByteSource::operator=(ByteSource&& other) noexcept {
  if (&other != this) {
    OPENSSL_clear_free(allocated_data_, size_);
    data_ = other.data_;
    allocated_data_ = other.allocated_data_;
    other.allocated_data_ = nullptr;
    size_ = other.size_;
  }
  return *this;
}
char* ByteSource::Answer(size_t* length) const { return Copy(data<char>(), size_, length); }
ByteSource ByteSource::Allocated(void* data, size_t size) { return ByteSource(data, data, size); }
ByteSource ByteSource::Foreign(const void* data, size_t size) { return ByteSource(data, nullptr, size); }
ByteSource ByteSource::CopyOf(const void* data, size_t size) {
  auto out = ncrypto::DataPointer::Alloc(size);
  if (size > 0) memcpy(out.get(), data, size);
  return Allocated(out.release());
}
ByteSource ByteSource::FromBIO(const ncrypto::BIOPointer& bio) {
  BUF_MEM* bptr = bio;
  auto out = ncrypto::DataPointer::Alloc(bptr->length);
  memcpy(out.get(), bptr->data, bptr->length);
  return Allocated(out.release());
}

void TruncateToBitLength(size_t length_bits, ByteSource* bytes) {
  const size_t length_bytes = NumBitsToBytes(length_bits);
  if (length_bytes > bytes->size()) abort();
  if (bytes->allocated_data_ == nullptr || bytes->size() != length_bytes) {
    auto data = ncrypto::DataPointer::Alloc(length_bytes);
    if (length_bytes > 0) memcpy(data.get(), bytes->data(), length_bytes);
    *bytes = ByteSource::Allocated(data.release());
  }
  const size_t remainder_bits = length_bits % CHAR_BIT;
  if (remainder_bits != 0) {
    auto* data = static_cast<unsigned char*>(bytes->allocated_data_);
    const unsigned char mask = static_cast<unsigned char>(0xff << (CHAR_BIT - remainder_bits));
    data[length_bytes - 1] &= mask;
  }
}

// ---- Values and fields ------------------------------------------------------------------------------------------

const TnValue& TnValue::Get(const char* name) const {
  static const TnValue undefined = {};
  if (kind != kTnObject) return undefined;
  const TnProperty* members = reinterpret_cast<const TnProperty*>(data);
  for (uint32_t index = 0; index < length; index++) {
    if (strcmp(members[index].name, name) == 0) return members[index].value;
  }
  return undefined;
}

void TnFields::Add(Kind kind, const char* name, const void* value, size_t size) {
  uint32_t name_length = static_cast<uint32_t>(strlen(name));
  uint32_t value_length = static_cast<uint32_t>(size);
  bytes_.push_back(static_cast<char>(kind));
  bytes_.append(reinterpret_cast<const char*>(&name_length), 4);
  bytes_.append(name, name_length);
  bytes_.append(reinterpret_cast<const char*>(&value_length), 4);
  if (size > 0) bytes_.append(static_cast<const char*>(value), size);
}
char* TnFields::Answer(size_t* length) const { return Copy(bytes_.data(), bytes_.size(), length); }

void SetEncodedValue(TnFields* target, const char* name, const BIGNUM* bn, int size) {
  if (size == 0) size = ncrypto::BignumPointer::GetByteCount(bn);
  auto buf = ncrypto::BignumPointer::EncodePadded(bn, size);
  target->Base64Url(name, buf.get(), buf.size());
}

// ---- Jobs (crypto_util.h:271-480, crypto_util.cc:247-259 and 732-741) -------------------------------------------

void CryptoErrorStore::Capture() {
  errors_.clear();
  while (const uint32_t err = ERR_get_error()) {
    char buf[256];
    ERR_error_string_n(err, buf, sizeof(buf));
    errors_.emplace_back(buf);
  }
  std::reverse(errors_.begin(), errors_.end());
}

CryptoJobMode JobMode(int32_t mode) {
  if (mode < kCryptoJobAsync || mode > kCryptoJobWebCrypto) abort();
  return static_cast<CryptoJobMode>(mode);
}

// CryptoJob::Run's synchronous branch (crypto_util.h:395-406): the work, in the caller's thread.
CRYPTO_EXPORT(tabnode_job_run) void tabnode_job_run(CryptoJob* job) { job->DoThreadPoolWork(); }

// ThreadPoolWork::ScheduleWork (src/threadpoolwork-inl.h:37-57): the work on libuv's threadpool, its completion on
// the loop, where the engine makes the job's callback (crypto_job_done) and its scope closes (drain); then the job is
// freed, as AfterThreadPoolWork's unique_ptr frees it.
CRYPTO_EXPORT(tabnode_job_schedule) int tabnode_job_schedule(CryptoJob* job) {
  return uv_queue_work(
      uv_default_loop(), &job->work,
      [](uv_work_t* req) { static_cast<CryptoJob*>(req->data)->DoThreadPoolWork(); },
      [](uv_work_t* req, int status) {
        CryptoJob* job = static_cast<CryptoJob*>(req->data);
        if (tabnode_crypto_job_done(job, status)) tabnode_drain();
        delete job;
      });
}
CRYPTO_EXPORT(tabnode_job_free) void tabnode_job_free(CryptoJob* job) { delete job; }
CRYPTO_EXPORT(tabnode_job_success) int tabnode_job_success(CryptoJob* job) { return job->success ? 1 : 0; }
// The job's bytes (its out_), borrowed: the engine copies them out before the job is freed.
CRYPTO_EXPORT(tabnode_job_out) const void* tabnode_job_out(CryptoJob* job, size_t* length) {
  *length = job->out.size();
  return job->out.data();
}
// The job's errors (CryptoErrorStore::ToException, crypto_util.cc:316-358): the count, and each, the last the message.
CRYPTO_EXPORT(tabnode_job_error_count) uint32_t tabnode_job_error_count(CryptoJob* job) {
  if (job->errors()->Empty()) job->errors()->Capture();
  return static_cast<uint32_t>(job->errors()->errors().size());
}
CRYPTO_EXPORT(tabnode_job_error) const char* tabnode_job_error(CryptoJob* job, uint32_t index) {
  return job->errors()->errors()[index].c_str();
}
// A key the job made (a key pair's public then private, or a secret), as a handle's new data.
CRYPTO_EXPORT(tabnode_job_key) KeyObjectData* tabnode_job_key(CryptoJob* job, int second) {
  const KeyObjectData& key = second ? job->second_key : job->key;
  return key ? NewHandleData(key) : nullptr;
}

// ---- The binding's utilities (crypto_util.cc:206-245, 683-701, 846-878; crypto_timing.cc) ------------------------

namespace {
std::mutex fips_mutex;
}

// GetFipsCrypto, TestFipsCrypto (crypto_util.cc:207-211, 238-242).
CRYPTO_EXPORT(tabnode_get_fips_crypto) int tabnode_get_fips_crypto() {
  std::lock_guard<std::mutex> lock(fips_mutex);
  return ncrypto::isFipsEnabled() ? 1 : 0;
}
CRYPTO_EXPORT(tabnode_test_fips_crypto) int tabnode_test_fips_crypto() {
  std::lock_guard<std::mutex> lock(fips_mutex);
  return ncrypto::testFipsEnabled() ? 1 : 0;
}
// SetFipsCrypto (213-236): a failure is cryptoErrorListToException's error, its last error the message and the rest
// its opensslErrorStack (recorded as ThrowCryptoError's shape with no code).
CRYPTO_EXPORT(tabnode_set_fips_crypto) int tabnode_set_fips_crypto(int enable) {
  std::lock_guard<std::mutex> lock(fips_mutex);
  ncrypto::CryptoErrorList errors;
  if (ncrypto::setFipsEnabled(enable != 0, &errors)) return 1;
  thrown = Thrown();
  thrown.pending = true;
  thrown.has_message = true;
  if (errors.empty()) {
    thrown.message = "Ok";
  } else {
    thrown.message = errors.peek_back();
    auto last = errors.end();
    last--;
    for (auto current = errors.begin(); current != last; ++current) thrown.stack.push_back(*current);
  }
  return 0;
}

// GetOpenSSLSecLevelCrypto (244-253).
CRYPTO_EXPORT(tabnode_get_openssl_sec_level) int tabnode_get_openssl_sec_level() {
  ncrypto::ClearErrorOnReturn clear_error_on_return;
  if (auto sec_level = ncrypto::SSLPointer::getSecurityLevel()) return sec_level.value();
  ThrowCrypto(clear_error_on_return.peekError(), "getOpenSSLSecLevel");
  return -1;
}

#ifndef OPENSSL_NO_ENGINE
// SetEngine (683-701): the permission model's refusal is the engine's (it has none enabled).
CRYPTO_EXPORT(tabnode_set_engine) int tabnode_set_engine(const char* engine_id, uint32_t flags) {
  return ncrypto::EnginePointer::getEngineByName(engine_id).setAsDefault(flags) ? 1 : 0;
}
#endif

// SecureHeapUsed (870-873).
CRYPTO_EXPORT(tabnode_secure_heap_used) double tabnode_secure_heap_used() {
  return static_cast<double>(ncrypto::DataPointer::GetSecureHeapUsed());
}

// TimingSafeEqual (crypto_timing.cc:19-76): the lengths are compared first, as Node throws.
CRYPTO_EXPORT(tabnode_timing_safe_equal) int tabnode_timing_safe_equal(const void* a, size_t a_length, const void* b,
                                                                       size_t b_length) {
  if (a_length != b_length) {
    Throw("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH");
    return -1;
  }
  return CRYPTO_memcmp(a, b, a_length) == 0 ? 1 : 0;
}
