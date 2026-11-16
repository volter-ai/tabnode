// THE RANDOMNESS OF THE crypto BINDING (Tabnode ADR-0018 item 7): the OpenSSL half of Node v24.21.0's
// src/crypto/crypto_random.cc, over ncrypto and OpenSSL in the program, whose randomness is the kernel's getrandom
// (ADR-0018 item 7, "The process's OpenSSL"): RandomBytesJob, RandomPrimeJob and CheckPrimeJob. WebCrypto's
// randomness is not a call of the engine device's (its getRandomValues is the process's own), so OpenSSL answers
// every one of these.
#include <openssl/err.h>

#include "crypto_util.h"

using ncrypto::BignumPointer;
using ncrypto::ClearErrorOnReturn;

namespace {
// getPrimeCheckCallback (32-37): Node stops a search when its environment stops; a job here runs to its end, and the
// process's exit ends it with the process.
BignumPointer::PrimeCheckCallback PrimeCheck() {
  return [](int a, int b) -> bool { return true; };
}

// RandomBytesConfig: the bytes are filled in the job's own room, which the V8 half copies into the JavaScript buffer
// at the offset it was given when the job completes, as Node's job fills that buffer in place (its bytes are not in
// the process's memory).
struct RandomBytesConfig {
  uint32_t size;
};
bool DeriveRandomBytes(const RandomBytesConfig& params, ByteSource* out, CryptoJobMode mode) {
  auto buffer = ncrypto::DataPointer::Alloc(params.size);
  if (!ncrypto::CSPRNG(buffer.get(), params.size)) return false;
  *out = ByteSource::Allocated(buffer.release());
  return true;
}

struct RandomPrimeConfig {
  BignumPointer prime;
  BignumPointer rem;
  BignumPointer add;
  int bits;
  bool safe;
};
bool DeriveRandomPrime(const RandomPrimeConfig& params, ByteSource* out, CryptoJobMode mode) {
  if (!const_cast<BignumPointer&>(params.prime).generate(
          BignumPointer::PrimeConfig{.bits = params.bits, .safe = params.safe, .add = params.add, .rem = params.rem},
          PrimeCheck())) {
    return false;
  }
  // RandomPrimeTraits::EncodeOutput (77-87): the prime's bytes, big-endian.
  size_t size = params.prime.byteLength();
  auto data = ncrypto::DataPointer::Alloc(size);
  if (BignumPointer::EncodePaddedInto(params.prime.get(), data.get<unsigned char>(), size) != size) abort();
  *out = ByteSource::Allocated(data.release());
  return true;
}

struct CheckPrimeConfig {
  BignumPointer candidate;
  int checks = 1;
};
bool DeriveCheckPrime(const CheckPrimeConfig& params, ByteSource* out, CryptoJobMode mode) {
  int ret = params.candidate.isPrime(params.checks, PrimeCheck());
  if (ret < 0) return false;
  auto buf = ncrypto::DataPointer::Alloc(1);
  static_cast<char*>(buf.get())[0] = ret;
  *out = ByteSource::Allocated(buf.release());
  return true;
}
}  // namespace

// RandomBytesTraits::AdditionalConfig (44-62): `byte_offset` and `size` checked against the buffer's length.
CRYPTO_EXPORT(tabnode_random_bytes_job_new) CryptoJob* tabnode_random_bytes_job_new(int32_t mode, size_t buffer_size,
                                                                                   uint32_t byte_offset,
                                                                                   uint32_t size) {
  if (byte_offset + size < byte_offset || byte_offset + size > buffer_size) abort();
  return new DeriveBitsJob<RandomBytesConfig>(JobMode(mode), RandomBytesConfig{size}, DeriveRandomBytes);
}

// RandomPrimeTraits::AdditionalConfig (89-139): a null `add` or `rem` is undefined; null where it threw.
CRYPTO_EXPORT(tabnode_random_prime_job_new) CryptoJob* tabnode_random_prime_job_new(
    int32_t mode, uint32_t size, int safe, const unsigned char* add, size_t add_size, const unsigned char* rem,
    size_t rem_size) {
  ClearErrorOnReturn clear_error;
  RandomPrimeConfig params;
  if (add != nullptr) {
    params.add.reset(add, add_size);
    if (!params.add) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "could not generate prime");
      return nullptr;
    }
  }
  if (rem != nullptr) {
    params.rem.reset(rem, rem_size);
    if (!params.rem) {
      Throw("ERR_CRYPTO_OPERATION_FAILED", "could not generate prime");
      return nullptr;
    }
  }
  int bits = static_cast<int>(size);
  if (bits <= 0) abort();
  if (params.add) {
    if (BignumPointer::GetBitCount(params.add.get()) > bits) {
      Throw("ERR_OUT_OF_RANGE", "invalid options.add");
      return nullptr;
    }
    if (params.rem && params.add <= params.rem) {
      Throw("ERR_OUT_OF_RANGE", "invalid options.rem");
      return nullptr;
    }
  }
  params.bits = bits;
  params.safe = safe != 0;
  params.prime = BignumPointer::NewSecure();
  if (!params.prime) {
    Throw("ERR_CRYPTO_OPERATION_FAILED", "could not generate prime");
    return nullptr;
  }
  return new DeriveBitsJob<RandomPrimeConfig>(JobMode(mode), std::move(params), DeriveRandomPrime);
}

// CheckPrimeTraits::AdditionalConfig (154-172).
CRYPTO_EXPORT(tabnode_check_prime_job_new) CryptoJob* tabnode_check_prime_job_new(int32_t mode,
                                                                                 const unsigned char* candidate,
                                                                                 size_t size, int32_t checks) {
  CheckPrimeConfig params;
  params.candidate = BignumPointer(candidate, size);
  if (!params.candidate) {
    ThrowCrypto(ERR_get_error(), "BignumPointer");
    return nullptr;
  }
  if (checks < 0) abort();
  params.checks = checks;
  return new DeriveBitsJob<CheckPrimeConfig>(JobMode(mode), std::move(params), DeriveCheckPrime);
}

// SecureBuffer (crypto_util.cc:795-845): OpenSSL's secure heap, as DataPointer::SecureAlloc allocates it, is the
// process's; a JavaScript Uint8Array cannot be a view of the process's memory, so the binding's buffer is the
// engine's (crypto_random.ts), as a V8 sandbox's is not the secure heap either. This answers whether an allocation of
// `size` would succeed (Node's "Allocation failed").
CRYPTO_EXPORT(tabnode_secure_alloc_check) int tabnode_secure_alloc_check(uint32_t size) {
  auto data = ncrypto::DataPointer::SecureAlloc(size);
  return data ? 1 : 0;
}
