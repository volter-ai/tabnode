// THE zlib BINDING'S C (Tabnode ADR-0018 §1, item 10): Node v24.21.0's src/node_zlib.cc below V8, over the zlib
// (Chromium's, as Node's deps/zlib ships it), brotli and zstd that libnode.so holds. A stream (tabnode_zlib_t) is
// Node's CompressionStream over its context: ZlibContext, BrotliEncoderContext, BrotliDecoderContext,
// ZstdCompressContext or ZstdDecompressContext, each as Node's C++ writes it. A write runs the context's
// DoThreadPoolWork in the call (writeSync) or on libuv's threadpool (write: uv_queue_work, ThreadPoolWork::
// ScheduleWork, src/threadpoolwork-inl.h), its completion AfterThreadPoolWork on the loop, which calls the engine
// (`zlib_done`) and closes the callback's scope (`drain`). EmitError's MakeCallback of `onerror` is the engine's
// `zlib_error`, made inside whatever call raised it.
//
// What V8 holds is the engine's (src/node-lib/binding/zlib.ts): the JavaScript arguments, read as Node's
// FunctionCallbackInfo reads them; the write result's Uint32Array, which this C fills as its own `write_result` and
// the engine copies; the write callback (kWriteJSCallback). A JavaScript buffer is not in the process's memory, so a
// write's input and output are the stream's `room` here, which the engine fills and reads back.
//
// Where it is not Node's:
// - CompressionStreamMemoryOwner's allocators are Node's (the size before each block, the stream as their opaque),
//   and its count of the bytes they hold is kept, but no count is reported: AdjustAmountOfExternalAllocatedMemory
//   tells V8's external memory accounting, which a page's engine has none of.
// - PrintSyncTrace (writeSync under --trace-sync-io) is the engine's option table's, which has no such option.
#define ZSTD_STATIC_LINKING_ONLY  // NODE_BUNDLED_ZSTD (node.gypi:249-252), as node_zlib.cc:22-24 defines it.
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <brotli/decode.h>
#include <brotli/encode.h>
#include <brotli/shared_dictionary.h>
#include <uv.h>
#include <zlib.h>
#include <zstd.h>
#include <zstd_errors.h>

#include "engine.h"

#define EXPORT(name) __attribute__((export_name(#name)))
// Node's CHECK and UNREACHABLE (src/util.h): the process aborts.
#define CHECK(condition)                                                                                           \
  do {                                                                                                             \
    if (!(condition)) {                                                                                            \
      fprintf(stderr, "node: %s:%d: Assertion `%s' failed.\n", __FILE__, __LINE__, #condition);                  \
      abort();                                                                                                     \
    }                                                                                                              \
  } while (0)
#define UNREACHABLE(message) CHECK(!message)

// node_zlib.cc:74-88.
#define Z_MIN_WINDOWBITS 8
#define Z_MAX_WINDOWBITS 15
#define Z_MIN_MEMLEVEL 1
#define Z_MAX_MEMLEVEL 9
#define Z_MIN_LEVEL -1
#define Z_MAX_LEVEL 9

// node_zlib_mode (node_zlib.cc:146-159).
typedef enum {
  NONE,
  DEFLATE,
  INFLATE,
  GZIP,
  GUNZIP,
  DEFLATERAW,
  INFLATERAW,
  UNZIP,
  BROTLI_DECODE,
  BROTLI_ENCODE,
  ZSTD_COMPRESS,
  ZSTD_DECOMPRESS
} node_zlib_mode;

enum { GZIP_HEADER_ID1 = 0x1f, GZIP_HEADER_ID2 = 0x8b };

// ZlibStrerror (node_zlib.cc:90-106).
static const char *zlib_strerror(int err) {
#define V(code) \
  if (err == code) return #code;
  V(Z_OK) V(Z_STREAM_END) V(Z_NEED_DICT) V(Z_ERRNO) V(Z_STREAM_ERROR) V(Z_DATA_ERROR) V(Z_MEM_ERROR) V(Z_BUF_ERROR)
  V(Z_VERSION_ERROR)
#undef V
  return "Z_UNKNOWN_ERROR";
}

// ZstdStrerror (node_zlib.cc:108-144).
static const char *zstd_strerror(int err) {
#define V(code) \
  if (err == code) return #code;
  V(ZSTD_error_no_error) V(ZSTD_error_GENERIC) V(ZSTD_error_prefix_unknown) V(ZSTD_error_version_unsupported)
  V(ZSTD_error_frameParameter_unsupported) V(ZSTD_error_frameParameter_windowTooLarge)
  V(ZSTD_error_corruption_detected) V(ZSTD_error_checksum_wrong) V(ZSTD_error_literals_headerWrong)
  V(ZSTD_error_dictionary_corrupted) V(ZSTD_error_dictionary_wrong) V(ZSTD_error_dictionaryCreation_failed)
  V(ZSTD_error_parameter_unsupported) V(ZSTD_error_parameter_combination_unsupported)
  V(ZSTD_error_parameter_outOfBound) V(ZSTD_error_tableLog_tooLarge) V(ZSTD_error_maxSymbolValue_tooLarge)
  V(ZSTD_error_maxSymbolValue_tooSmall) V(ZSTD_error_stabilityCondition_notRespected) V(ZSTD_error_stage_wrong)
  V(ZSTD_error_init_missing) V(ZSTD_error_memory_allocation) V(ZSTD_error_workSpace_tooSmall)
  V(ZSTD_error_dstSize_tooSmall) V(ZSTD_error_srcSize_wrong) V(ZSTD_error_dstBuffer_null)
  V(ZSTD_error_noForwardProgress_destFull) V(ZSTD_error_noForwardProgress_inputEmpty)
#undef V
  return "ZSTD_error_GENERIC";
}

// CompressionError (node_zlib.cc:164-179): no error where `code` is NULL.
typedef struct {
  const char *message;
  const char *code;
  int err;
} compression_error_t;

static compression_error_t compression_error(const char *message, const char *code, int err) {
  CHECK(message != NULL);
  return (compression_error_t){message, code, err};
}
static const compression_error_t kNoError = {NULL, NULL, 0};

// ZlibContext (node_zlib.cc:181-233).
typedef struct {
  uv_mutex_t mutex;  // Protects zlib_init_done.
  bool zlib_init_done;
  int err;
  int flush;
  int level;
  int mem_level;
  node_zlib_mode mode;
  int strategy;
  int window_bits;
  bool reject_garbage_after_end;
  unsigned int gzip_id_bytes_read;
  unsigned char *dictionary;
  size_t dictionary_size;
  z_stream strm;
} zlib_context_t;

// BrotliContext, BrotliEncoderContext and BrotliDecoderContext (node_zlib.cc:237-302).
typedef struct {
  node_zlib_mode mode;
  const uint8_t *next_in;
  uint8_t *next_out;
  size_t avail_in;
  size_t avail_out;
  BrotliEncoderOperation flush;
  // The encoder's.
  bool encoder_last_result;
  BrotliEncoderState *encoder;
  BrotliEncoderPreparedDictionary *prepared_dictionary;
  // The decoder's.
  BrotliDecoderResult decoder_last_result;
  BrotliDecoderErrorCode error;
  char error_string[80];
  BrotliDecoderState *decoder;
  // Dictionary data must remain valid while the prepared dictionary (the encoder's) or the decoder is alive.
  uint8_t *dictionary;
  size_t dictionary_size;
} brotli_context_t;

// ZstdContext, ZstdCompressContext and ZstdDecompressContext (node_zlib.cc:304-382). Its error strings are
// ZstdStrerror's and ZSTD_getErrorString's, static text both.
typedef struct {
  ZSTD_EndDirective flush;
  ZSTD_inBuffer input;
  ZSTD_outBuffer output;
  ZSTD_ErrorCode error;
  const char *error_string;
  const char *error_code_string;
  // The compressor's.
  ZSTD_CCtx *cctx;
  uint64_t pledged_src_size;
  bool has_consumed_src_size;
  uint64_t consumed_src_size;
  // The decompressor's.
  ZSTD_DCtx *dctx;
  bool frame_complete;
} zstd_context_t;

enum { kZlib, kBrotliEncoder, kBrotliDecoder, kZstdCompress, kZstdDecompress };

// CompressionStream (node_zlib.cc:442-734) with its CompressionStreamMemoryOwner (384-440) and ThreadPoolWork.
typedef struct tabnode_zlib_s {
  uv_work_t work;
  int kind;
  atomic_long unreported_allocations;
  bool init_done;
  bool write_in_progress;
  bool pending_close;
  bool closed;
  // write_result_: [0] avail_out, [1] avail_in (UpdateWriteResult).
  uint32_t write_result[2];
  // The message of the error Zstd's Init or SetParameter last emitted (THROW_ERR_ZLIB_INITIALIZATION_FAILED's).
  const char *last_message;
  // The engine's copy of a write's input, then its output, in the process's memory.
  char *room;
  size_t room_size;
  union {
    zlib_context_t zlib;
    brotli_context_t brotli;
    zstd_context_t zstd;
  } ctx;
} tabnode_zlib_t;

// ---- CompressionStreamMemoryOwner (node_zlib.cc:384-440) --------------------------------------------------------

#define RESERVE_SIZE_AND_ALIGN \
  (sizeof(size_t) > _Alignof(max_align_t) ? sizeof(size_t) : _Alignof(max_align_t))

static void *alloc_for_brotli(void *data, size_t size) {
  size += RESERVE_SIZE_AND_ALIGN;
  tabnode_zlib_t *owner = data;
  char *memory = malloc(size);
  if (memory == NULL) return NULL;
  *(size_t *)memory = size;
  atomic_fetch_add_explicit(&owner->unreported_allocations, (long)size, memory_order_relaxed);
  return memory + RESERVE_SIZE_AND_ALIGN;
}

static void *alloc_for_zlib(void *data, uInt items, uInt size) {
  size_t real_size;
  CHECK(!__builtin_mul_overflow((size_t)items, (size_t)size, &real_size));  // MultiplyWithOverflowCheck
  return alloc_for_brotli(data, real_size);
}

static void free_for_zlib(void *data, void *pointer) {
  if (pointer == NULL) return;
  tabnode_zlib_t *owner = data;
  char *real_pointer = (char *)pointer - RESERVE_SIZE_AND_ALIGN;
  size_t real_size = *(size_t *)real_pointer;
  atomic_fetch_sub_explicit(&owner->unreported_allocations, (long)real_size, memory_order_relaxed);
  free(real_pointer);
}

static tabnode_zlib_t *stream_of_zlib(zlib_context_t *ctx) {
  return (tabnode_zlib_t *)((char *)ctx - offsetof(tabnode_zlib_t, ctx));
}

// ---- ZlibContext (node_zlib.cc:1036-1405) -----------------------------------------------------------------------

static compression_error_t zlib_error_for_message(const zlib_context_t *ctx, const char *message) {
  if (ctx->strm.msg != NULL) message = ctx->strm.msg;
  return compression_error(message, zlib_strerror(ctx->err), ctx->err);
}

static compression_error_t zlib_set_dictionary(zlib_context_t *ctx) {
  if (ctx->dictionary_size == 0) return kNoError;
  ctx->err = Z_OK;
  switch (ctx->mode) {
    case DEFLATE:
    case DEFLATERAW:
      ctx->err = deflateSetDictionary(&ctx->strm, ctx->dictionary, ctx->dictionary_size);
      break;
    case INFLATERAW:
      // The other inflate cases will have the dictionary set when inflate() returns Z_NEED_DICT in Process().
      ctx->err = inflateSetDictionary(&ctx->strm, ctx->dictionary, ctx->dictionary_size);
      break;
    default:
      break;
  }
  if (ctx->err != Z_OK) return zlib_error_for_message(ctx, "Failed to set dictionary");
  return kNoError;
}

static void zlib_clear_dictionary(zlib_context_t *ctx) {
  free(ctx->dictionary);
  ctx->dictionary = NULL;
  ctx->dictionary_size = 0;
}

static bool zlib_init_zlib(zlib_context_t *ctx) {
  uv_mutex_lock(&ctx->mutex);
  if (ctx->zlib_init_done) {
    uv_mutex_unlock(&ctx->mutex);
    return false;
  }
  // If deflateInit2() fails with Z_VERSION_ERROR, msg remains uninitialized. Initialize it here to avoid reading the
  // uninitialized pointer during error emission.
  ctx->strm.msg = NULL;
  switch (ctx->mode) {
    case DEFLATE:
    case GZIP:
    case DEFLATERAW:
      ctx->err = deflateInit2(&ctx->strm, ctx->level, Z_DEFLATED, ctx->window_bits, ctx->mem_level, ctx->strategy);
      break;
    case INFLATE:
    case GUNZIP:
    case INFLATERAW:
    case UNZIP:
      ctx->err = inflateInit2(&ctx->strm, ctx->window_bits);
      break;
    default:
      UNREACHABLE("invalid mode");
  }
  if (ctx->err != Z_OK) {
    zlib_clear_dictionary(ctx);
    ctx->mode = NONE;
    uv_mutex_unlock(&ctx->mutex);
    return true;
  }
  zlib_set_dictionary(ctx);
  ctx->zlib_init_done = true;
  uv_mutex_unlock(&ctx->mutex);
  return true;
}

static void zlib_close(zlib_context_t *ctx) {
  uv_mutex_lock(&ctx->mutex);
  if (!ctx->zlib_init_done) {
    zlib_clear_dictionary(ctx);
    ctx->mode = NONE;
    uv_mutex_unlock(&ctx->mutex);
    return;
  }
  uv_mutex_unlock(&ctx->mutex);
  CHECK(ctx->mode <= UNZIP);
  int status = Z_OK;
  if (ctx->mode == DEFLATE || ctx->mode == GZIP || ctx->mode == DEFLATERAW) {
    status = deflateEnd(&ctx->strm);
  } else if (ctx->mode == INFLATE || ctx->mode == GUNZIP || ctx->mode == INFLATERAW || ctx->mode == UNZIP) {
    status = inflateEnd(&ctx->strm);
  }
  CHECK(status == Z_OK || status == Z_DATA_ERROR);
  ctx->mode = NONE;
  zlib_clear_dictionary(ctx);
}

static compression_error_t zlib_reset_stream(zlib_context_t *ctx) {
  bool first_init_call = zlib_init_zlib(ctx);
  if (first_init_call && ctx->err != Z_OK) return zlib_error_for_message(ctx, "Failed to init stream before reset");
  ctx->err = Z_OK;
  switch (ctx->mode) {
    case DEFLATE:
    case DEFLATERAW:
    case GZIP:
      ctx->err = deflateReset(&ctx->strm);
      break;
    case INFLATE:
    case INFLATERAW:
    case GUNZIP:
      ctx->err = inflateReset(&ctx->strm);
      break;
    default:
      break;
  }
  if (ctx->err != Z_OK) return zlib_error_for_message(ctx, "Failed to reset stream");
  return zlib_set_dictionary(ctx);
}

static void zlib_do_thread_pool_work(zlib_context_t *ctx) {
  bool first_init_call = zlib_init_zlib(ctx);
  if (first_init_call && ctx->err != Z_OK) return;
  const Bytef *next_expected_header_byte = NULL;
  // If the avail_out is left at 0, then it means that it ran out of room. If there was avail_out left over, then it
  // means that all of the input was consumed.
  switch (ctx->mode) {
    case DEFLATE:
    case GZIP:
    case DEFLATERAW:
      ctx->err = deflate(&ctx->strm, ctx->flush);
      break;
    case UNZIP:
      if (ctx->strm.avail_in > 0) next_expected_header_byte = ctx->strm.next_in;
      switch (ctx->gzip_id_bytes_read) {
        case 0:
          if (next_expected_header_byte == NULL) break;
          if (*next_expected_header_byte == GZIP_HEADER_ID1) {
            ctx->gzip_id_bytes_read = 1;
            next_expected_header_byte++;
            // The only available byte was already read.
            if (ctx->strm.avail_in == 1) break;
          } else {
            ctx->mode = INFLATE;
            break;
          }
          __attribute__((fallthrough));
        case 1:
          if (next_expected_header_byte == NULL) break;
          if (*next_expected_header_byte == GZIP_HEADER_ID2) {
            ctx->gzip_id_bytes_read = 2;
            ctx->mode = GUNZIP;
          } else {
            // There is no actual difference between INFLATE and INFLATERAW (after initialization).
            ctx->mode = INFLATE;
          }
          break;
        default:
          UNREACHABLE("invalid number of gzip magic number bytes read");
      }
      __attribute__((fallthrough));
    case INFLATE:
    case GUNZIP:
    case INFLATERAW:
      ctx->err = inflate(&ctx->strm, ctx->flush);
      // If data was encoded with dictionary (INFLATERAW will have it set in SetDictionary, don't repeat that here).
      if (ctx->mode != INFLATERAW && ctx->err == Z_NEED_DICT && ctx->dictionary_size != 0) {
        ctx->err = inflateSetDictionary(&ctx->strm, ctx->dictionary, ctx->dictionary_size);
        if (ctx->err == Z_OK) {
          ctx->err = inflate(&ctx->strm, ctx->flush);
        } else if (ctx->err == Z_DATA_ERROR) {
          // Both inflateSetDictionary() and inflate() return Z_DATA_ERROR. Make it possible for After() to tell a
          // bad dictionary from bad input.
          ctx->err = Z_NEED_DICT;
        }
      }
      while (ctx->strm.avail_in > 0 && ctx->mode == GUNZIP && ctx->err == Z_STREAM_END &&
             !ctx->reject_garbage_after_end && ctx->strm.next_in[0] != 0x00) {
        // Bytes remain in input buffer. Perhaps this is another compressed member in the same archive, or just
        // trailing garbage. Trailing zero bytes are okay, though, since they are frequently used for padding.
        zlib_reset_stream(ctx);
        ctx->err = inflate(&ctx->strm, ctx->flush);
      }
      break;
    default:
      UNREACHABLE("invalid mode");
  }
}

static compression_error_t zlib_get_error_info(const zlib_context_t *ctx) {
  // Acceptable error states depend on the type of zlib stream.
  switch (ctx->err) {
    case Z_OK:
    case Z_BUF_ERROR:
      if (ctx->strm.avail_out != 0 && ctx->flush == Z_FINISH) return zlib_error_for_message(ctx, "unexpected end of file");
      __attribute__((fallthrough));
    case Z_STREAM_END:
      // normal statuses, not fatal
      break;
    case Z_NEED_DICT:
      if (ctx->dictionary_size == 0) return zlib_error_for_message(ctx, "Missing dictionary");
      return zlib_error_for_message(ctx, "Bad dictionary");
    default:
      // something else.
      return zlib_error_for_message(ctx, "Zlib error");
  }
  return kNoError;
}

static compression_error_t zlib_set_params(zlib_context_t *ctx, int level, int strategy) {
  bool first_init_call = zlib_init_zlib(ctx);
  if (first_init_call && ctx->err != Z_OK) {
    return zlib_error_for_message(ctx, "Failed to init stream before set parameters");
  }
  ctx->err = Z_OK;
  switch (ctx->mode) {
    case DEFLATE:
    case DEFLATERAW:
      ctx->err = deflateParams(&ctx->strm, level, strategy);
      break;
    default:
      break;
  }
  if (ctx->err != Z_OK && ctx->err != Z_BUF_ERROR) return zlib_error_for_message(ctx, "Failed to set parameters");
  return kNoError;
}

// ---- BrotliEncoderContext and BrotliDecoderContext (node_zlib.cc:1408-1614) --------------------------------------

static void brotli_clear_dictionary(brotli_context_t *ctx) {
  free(ctx->dictionary);
  ctx->dictionary = NULL;
  ctx->dictionary_size = 0;
}

static void brotli_encoder_close(brotli_context_t *ctx) {
  if (ctx->encoder) BrotliEncoderDestroyInstance(ctx->encoder);
  ctx->encoder = NULL;
  if (ctx->prepared_dictionary) BrotliEncoderDestroyPreparedDictionary(ctx->prepared_dictionary);
  ctx->prepared_dictionary = NULL;
  brotli_clear_dictionary(ctx);
  ctx->mode = NONE;
}

static void brotli_decoder_close(brotli_context_t *ctx) {
  if (ctx->decoder) BrotliDecoderDestroyInstance(ctx->decoder);
  ctx->decoder = NULL;
  brotli_clear_dictionary(ctx);
  ctx->mode = NONE;
}

static void brotli_encoder_do_thread_pool_work(brotli_context_t *ctx) {
  CHECK(ctx->mode == BROTLI_ENCODE);
  CHECK(ctx->encoder != NULL);
  const uint8_t *next_in = ctx->next_in;
  ctx->encoder_last_result = BrotliEncoderCompressStream(ctx->encoder, ctx->flush, &ctx->avail_in, &next_in,
                                                         &ctx->avail_out, &ctx->next_out, NULL);
  ctx->next_in += next_in - ctx->next_in;
}

static void brotli_decoder_do_thread_pool_work(brotli_context_t *ctx) {
  CHECK(ctx->mode == BROTLI_DECODE);
  CHECK(ctx->decoder != NULL);
  const uint8_t *next_in = ctx->next_in;
  ctx->decoder_last_result =
      BrotliDecoderDecompressStream(ctx->decoder, &ctx->avail_in, &next_in, &ctx->avail_out, &ctx->next_out, NULL);
  ctx->next_in += next_in - ctx->next_in;
  if (ctx->decoder_last_result == BROTLI_DECODER_RESULT_ERROR) {
    ctx->error = BrotliDecoderGetErrorCode(ctx->decoder);
    snprintf(ctx->error_string, sizeof ctx->error_string, "ERR_%s", BrotliDecoderErrorString(ctx->error));
  }
}

// BrotliEncoderContext::Init and BrotliDecoderContext::Init (node_zlib.cc:1451-1497, 1549-1582): the dictionary
// taken by move, here `dictionary` (malloc'd) owned from this call.
static compression_error_t brotli_encoder_init(tabnode_zlib_t *stream, uint8_t *dictionary, size_t size) {
  brotli_context_t *ctx = &stream->ctx.brotli;
  // Clean up any previous dictionary state before re-initializing.
  if (ctx->prepared_dictionary) BrotliEncoderDestroyPreparedDictionary(ctx->prepared_dictionary);
  ctx->prepared_dictionary = NULL;
  brotli_clear_dictionary(ctx);
  if (ctx->encoder) BrotliEncoderDestroyInstance(ctx->encoder);
  ctx->encoder = BrotliEncoderCreateInstance(alloc_for_brotli, free_for_zlib, stream);
  if (!ctx->encoder) {
    free(dictionary);
    return compression_error("Could not initialize Brotli instance", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  }
  if (size != 0) {
    // The dictionary data must remain valid for the lifetime of the prepared dictionary, so take ownership.
    ctx->dictionary = dictionary;
    ctx->dictionary_size = size;
    ctx->prepared_dictionary = BrotliEncoderPrepareDictionary(BROTLI_SHARED_DICTIONARY_RAW, size, ctx->dictionary,
                                                              BROTLI_MAX_QUALITY, alloc_for_brotli, free_for_zlib,
                                                              stream);
    if (!ctx->prepared_dictionary) {
      return compression_error("Failed to prepare brotli dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
    }
    if (!BrotliEncoderAttachPreparedDictionary(ctx->encoder, ctx->prepared_dictionary)) {
      return compression_error("Failed to attach brotli dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
    }
  } else {
    free(dictionary);
  }
  return kNoError;
}

static compression_error_t brotli_decoder_init(tabnode_zlib_t *stream, uint8_t *dictionary, size_t size) {
  brotli_context_t *ctx = &stream->ctx.brotli;
  // Clean up any previous dictionary state before re-initializing.
  brotli_clear_dictionary(ctx);
  if (ctx->decoder) BrotliDecoderDestroyInstance(ctx->decoder);
  ctx->decoder = BrotliDecoderCreateInstance(alloc_for_brotli, free_for_zlib, stream);
  if (!ctx->decoder) {
    free(dictionary);
    return compression_error("Could not initialize Brotli instance", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  }
  if (size != 0) {
    // The dictionary data must remain valid for the lifetime of the decoder, so take ownership.
    ctx->dictionary = dictionary;
    ctx->dictionary_size = size;
    if (!BrotliDecoderAttachDictionary(ctx->decoder, BROTLI_SHARED_DICTIONARY_RAW, size, ctx->dictionary)) {
      return compression_error("Failed to attach brotli dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
    }
  } else {
    free(dictionary);
  }
  return kNoError;
}

static compression_error_t brotli_encoder_set_params(brotli_context_t *ctx, int key, uint32_t value) {
  if (!BrotliEncoderSetParameter(ctx->encoder, (BrotliEncoderParameter)key, value)) {
    return compression_error("Setting parameter failed", "ERR_BROTLI_PARAM_SET_FAILED", -1);
  }
  return kNoError;
}

static compression_error_t brotli_decoder_set_params(brotli_context_t *ctx, int key, uint32_t value) {
  if (!BrotliDecoderSetParameter(ctx->decoder, (BrotliDecoderParameter)key, value)) {
    return compression_error("Setting parameter failed", "ERR_BROTLI_PARAM_SET_FAILED", -1);
  }
  return kNoError;
}

static compression_error_t brotli_encoder_get_error_info(const brotli_context_t *ctx) {
  if (!ctx->encoder_last_result) return compression_error("Compression failed", "ERR_BROTLI_COMPRESSION_FAILED", -1);
  return kNoError;
}

static compression_error_t brotli_decoder_get_error_info(const brotli_context_t *ctx) {
  if (ctx->error != BROTLI_DECODER_NO_ERROR) {
    return compression_error("Decompression failed", ctx->error_string, (int)ctx->error);
  }
  if (ctx->flush == BROTLI_OPERATION_FINISH && ctx->decoder_last_result == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
    // Match zlib's behaviour, as brotli doesn't have its own code for this.
    return compression_error("unexpected end of file", "Z_BUF_ERROR", Z_BUF_ERROR);
  }
  return kNoError;
}

// ---- ZstdCompressContext and ZstdDecompressContext (node_zlib.cc:1616-1817) -------------------------------------

static compression_error_t zstd_get_error_info(const zstd_context_t *ctx) {
  if (ctx->error != ZSTD_error_no_error) {
    return compression_error(ctx->error_string, ctx->error_code_string, (int)ctx->error);
  }
  return kNoError;
}

static void zstd_record_error(zstd_context_t *ctx, ZSTD_ErrorCode error) {
  ctx->error = error;
  ctx->error_code_string = zstd_strerror(error);
  ctx->error_string = ZSTD_getErrorString(error);
}

static compression_error_t zstd_compress_set_parameter(zstd_context_t *ctx, int key, int value) {
  size_t result = ZSTD_CCtx_setParameter(ctx->cctx, (ZSTD_cParameter)key, value);
  if (ZSTD_isError(result)) return compression_error("Setting parameter failed", "ERR_ZSTD_PARAM_SET_FAILED", -1);
  return kNoError;
}

static void zstd_compress_close(zstd_context_t *ctx) {
  ZSTD_freeCCtx(ctx->cctx);
  ctx->cctx = NULL;
}

static compression_error_t zstd_compress_init(tabnode_zlib_t *stream, uint64_t pledged_src_size,
                                              const char *dictionary, size_t size) {
  zstd_context_t *ctx = &stream->ctx.zstd;
  ctx->pledged_src_size = pledged_src_size;
  ctx->has_consumed_src_size = pledged_src_size != ZSTD_CONTENTSIZE_UNKNOWN;
  ctx->consumed_src_size = 0;
  ZSTD_customMem custom_mem = {alloc_for_brotli, free_for_zlib, stream};
  ZSTD_freeCCtx(ctx->cctx);
  ctx->cctx = ZSTD_createCCtx_advanced(custom_mem);
  if (!ctx->cctx) return compression_error("Could not initialize zstd instance", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  if (size != 0) {
    size_t ret = ZSTD_CCtx_loadDictionary(ctx->cctx, dictionary, size);
    if (ZSTD_isError(ret)) {
      return compression_error("Failed to load zstd dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
    }
  }
  size_t result = ZSTD_CCtx_setPledgedSrcSize(ctx->cctx, pledged_src_size);
  if (ZSTD_isError(result)) {
    return compression_error("Could not set pledged src size", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  }
  return kNoError;
}

static void zstd_compress_do_thread_pool_work(zstd_context_t *ctx) {
  // Zstd overrides a configured pledge when the first call uses ZSTD_e_end.
  size_t const input_pos = ctx->input.pos;
  size_t const remaining = ZSTD_compressStream2(ctx->cctx, &ctx->output, &ctx->input, ctx->flush);
  if (ctx->has_consumed_src_size) ctx->consumed_src_size += ctx->input.pos - input_pos;
  if (ZSTD_isError(remaining)) {
    zstd_record_error(ctx, ZSTD_getErrorCode(remaining));
  } else if (remaining == 0 && ctx->flush == ZSTD_e_end && ctx->has_consumed_src_size) {
    uint64_t const consumed_src_size = ctx->consumed_src_size;
    ctx->has_consumed_src_size = false;
    if (consumed_src_size != ctx->pledged_src_size) zstd_record_error(ctx, ZSTD_error_srcSize_wrong);
  }
}

static compression_error_t zstd_decompress_set_parameter(zstd_context_t *ctx, int key, int value) {
  size_t result = ZSTD_DCtx_setParameter(ctx->dctx, (ZSTD_dParameter)key, value);
  if (ZSTD_isError(result)) return compression_error("Setting parameter failed", "ERR_ZSTD_PARAM_SET_FAILED", -1);
  return kNoError;
}

static void zstd_decompress_close(zstd_context_t *ctx) {
  ZSTD_freeDCtx(ctx->dctx);
  ctx->dctx = NULL;
}

static compression_error_t zstd_decompress_init(tabnode_zlib_t *stream, const char *dictionary, size_t size) {
  zstd_context_t *ctx = &stream->ctx.zstd;
  ctx->frame_complete = false;
  ZSTD_customMem custom_mem = {alloc_for_brotli, free_for_zlib, stream};
  ZSTD_freeDCtx(ctx->dctx);
  ctx->dctx = ZSTD_createDCtx_advanced(custom_mem);
  if (!ctx->dctx) return compression_error("Could not initialize zstd instance", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  if (size != 0) {
    size_t ret = ZSTD_DCtx_loadDictionary(ctx->dctx, dictionary, size);
    if (ZSTD_isError(ret)) {
      return compression_error("Failed to load zstd dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
    }
  }
  return kNoError;
}

static void zstd_decompress_do_thread_pool_work(zstd_context_t *ctx) {
  // The JavaScript processing loop retries with an empty input buffer when the previous call filled the output
  // buffer. Avoid interpreting that retry as the beginning of a new, incomplete frame.
  if (ctx->frame_complete && ctx->input.size == 0) return;
  size_t const ret = ZSTD_decompressStream(ctx->dctx, &ctx->output, &ctx->input);
  if (ZSTD_isError(ret)) {
    ctx->frame_complete = false;
    zstd_record_error(ctx, ZSTD_getErrorCode(ret));
  } else {
    ctx->frame_complete = ret == 0;
  }
}

static compression_error_t zstd_decompress_get_error_info(const zstd_context_t *ctx) {
  compression_error_t error = zstd_get_error_info(ctx);
  if (error.code != NULL) return error;
  if (ctx->flush == ZSTD_e_end && !ctx->frame_complete && ctx->input.pos == ctx->input.size &&
      ctx->output.pos < ctx->output.size) {
    return compression_error("unexpected end of file", "Z_BUF_ERROR", Z_BUF_ERROR);
  }
  return kNoError;
}

// ---- the context, as CompressionStream<CompressionContext> calls it -----------------------------------------------

static void context_set_buffers(tabnode_zlib_t *s, const char *in, uint32_t in_len, char *out, uint32_t out_len) {
  switch (s->kind) {
    case kZlib:
      s->ctx.zlib.strm.avail_in = in_len;
      s->ctx.zlib.strm.next_in = (Bytef *)in;
      s->ctx.zlib.strm.avail_out = out_len;
      s->ctx.zlib.strm.next_out = (Bytef *)out;
      break;
    case kBrotliEncoder:
    case kBrotliDecoder:
      s->ctx.brotli.next_in = (const uint8_t *)in;
      s->ctx.brotli.next_out = (uint8_t *)out;
      s->ctx.brotli.avail_in = in_len;
      s->ctx.brotli.avail_out = out_len;
      break;
    default:
      s->ctx.zstd.input = (ZSTD_inBuffer){in, in_len, 0};
      s->ctx.zstd.output = (ZSTD_outBuffer){out, out_len, 0};
      break;
  }
}

static void context_set_flush(tabnode_zlib_t *s, int flush) {
  switch (s->kind) {
    case kZlib: s->ctx.zlib.flush = flush; break;
    case kBrotliEncoder:
    case kBrotliDecoder: s->ctx.brotli.flush = (BrotliEncoderOperation)flush; break;
    default: s->ctx.zstd.flush = (ZSTD_EndDirective)flush; break;
  }
}

// GetAfterWriteOffsets: avail_in, avail_out.
static void context_offsets(const tabnode_zlib_t *s, uint32_t *avail_in, uint32_t *avail_out) {
  switch (s->kind) {
    case kZlib:
      *avail_in = s->ctx.zlib.strm.avail_in;
      *avail_out = s->ctx.zlib.strm.avail_out;
      break;
    case kBrotliEncoder:
    case kBrotliDecoder:
      *avail_in = (uint32_t)s->ctx.brotli.avail_in;
      *avail_out = (uint32_t)s->ctx.brotli.avail_out;
      break;
    default:
      *avail_in = (uint32_t)(s->ctx.zstd.input.size - s->ctx.zstd.input.pos);
      *avail_out = (uint32_t)(s->ctx.zstd.output.size - s->ctx.zstd.output.pos);
      break;
  }
}

// DoThreadPoolWork, on libuv's threadpool for `write` and in the call for `writeSync`: no call into the engine.
static void context_do_work(tabnode_zlib_t *s) {
  switch (s->kind) {
    case kZlib: zlib_do_thread_pool_work(&s->ctx.zlib); break;
    case kBrotliEncoder: brotli_encoder_do_thread_pool_work(&s->ctx.brotli); break;
    case kBrotliDecoder: brotli_decoder_do_thread_pool_work(&s->ctx.brotli); break;
    case kZstdCompress: zstd_compress_do_thread_pool_work(&s->ctx.zstd); break;
    default: zstd_decompress_do_thread_pool_work(&s->ctx.zstd); break;
  }
}

static compression_error_t context_get_error_info(const tabnode_zlib_t *s) {
  switch (s->kind) {
    case kZlib: return zlib_get_error_info(&s->ctx.zlib);
    case kBrotliEncoder: return brotli_encoder_get_error_info(&s->ctx.brotli);
    case kBrotliDecoder: return brotli_decoder_get_error_info(&s->ctx.brotli);
    case kZstdCompress: return zstd_get_error_info(&s->ctx.zstd);
    default: return zstd_decompress_get_error_info(&s->ctx.zstd);
  }
}

static void context_close(tabnode_zlib_t *s) {
  switch (s->kind) {
    case kZlib: zlib_close(&s->ctx.zlib); break;
    case kBrotliEncoder: brotli_encoder_close(&s->ctx.brotli); break;
    case kBrotliDecoder: brotli_decoder_close(&s->ctx.brotli); break;
    case kZstdCompress: zstd_compress_close(&s->ctx.zstd); break;
    default: zstd_decompress_close(&s->ctx.zstd); break;
  }
}

static compression_error_t context_reset_stream(tabnode_zlib_t *s) {
  switch (s->kind) {
    case kZlib: return zlib_reset_stream(&s->ctx.zlib);
    case kBrotliEncoder: return brotli_encoder_init(s, NULL, 0);
    case kBrotliDecoder: return brotli_decoder_init(s, NULL, 0);
    // ResetStream re-inits with the pledge, and no dictionary (node_zlib.cc:1705-1707).
    case kZstdCompress: return zstd_compress_init(s, s->ctx.zstd.pledged_src_size, NULL, 0);
    // We pass ZSTD_CONTENTSIZE_UNKNOWN because the argument is ignored for decompression (node_zlib.cc:1779-1783).
    default: return zstd_decompress_init(s, NULL, 0);
  }
}

// ---- CompressionStream (node_zlib.cc:442-734) -------------------------------------------------------------------

static void stream_close(tabnode_zlib_t *s) {
  if (s->write_in_progress) {
    s->pending_close = true;
    return;
  }
  s->pending_close = false;
  s->closed = true;
  CHECK(s->init_done && "close before init");
  context_close(s);
}

// EmitError (node_zlib.cc:634-651): MakeCallback(onerror, message, err, code), the engine's; then no hope of rescue.
static void emit_error(tabnode_zlib_t *s, compression_error_t err) {
  tabnode_zlib_error(s, err.message, err.code, err.err);
  s->write_in_progress = false;
  if (s->pending_close) stream_close(s);
}

static bool check_error(tabnode_zlib_t *s) {
  compression_error_t err = context_get_error_info(s);
  if (err.code == NULL) return true;
  emit_error(s, err);
  return false;
}

static void update_write_result(tabnode_zlib_t *s) { context_offsets(s, &s->write_result[1], &s->write_result[0]); }

static void work_cb(uv_work_t *work) { context_do_work((tabnode_zlib_t *)work); }

// AfterThreadPoolWork (node_zlib.cc:601-631), on the loop.
static void after_work_cb(uv_work_t *work, int status) {
  tabnode_zlib_t *s = (tabnode_zlib_t *)work;
  CHECK(s->init_done);
  s->write_in_progress = false;
  if (status == UV_ECANCELED) {
    stream_close(s);
    tabnode_zlib_done(s, 0);
    return;
  }
  CHECK(status == 0);
  if (!check_error(s)) {
    tabnode_drain();
    tabnode_zlib_done(s, 0);
    return;
  }
  update_write_result(s);
  // call the write() cb. The pending close is Close'd before the callback's scope closes, where Node closes it after:
  // the stream's object is the engine's to collect once `zlib_done` returns, and a collection's finalizer may run
  // while the drain is suspended, so nothing here reads the stream after it. A close pending since before the
  // callback is the only one there can be (write_in_progress is false from this function's start), and no write can
  // follow it (CHECK(!pending_close)), so what the drain runs sees the same stream either way.
  tabnode_zlib_done(s, 1);
  if (s->pending_close) stream_close(s);
  tabnode_drain();
}

// ZlibStream, BrotliCompressionStream and ZstdStream's New (node_zlib.cc:743-748, 858-863, 944-947): a stream of
// `kind` (kZlib 0, kBrotliEncoder 1, kBrotliDecoder 2, kZstdCompress 3, kZstdDecompress 4) in `mode`.
EXPORT(tabnode_zlib_new) tabnode_zlib_t *tabnode_zlib_new(int kind, int mode) {
  tabnode_zlib_t *s = calloc(1, sizeof *s);
  if (!s) abort();
  s->kind = kind;
  if (kind == kZlib) {
    if (uv_mutex_init(&s->ctx.zlib.mutex)) abort();
    s->ctx.zlib.mode = (node_zlib_mode)mode;
  } else if (kind == kBrotliEncoder || kind == kBrotliDecoder) {
    s->ctx.brotli.mode = (node_zlib_mode)mode;
    s->ctx.brotli.flush = BROTLI_OPERATION_PROCESS;
    s->ctx.brotli.decoder_last_result = BROTLI_DECODER_RESULT_SUCCESS;
    s->ctx.brotli.error = BROTLI_DECODER_NO_ERROR;
  } else {
    s->ctx.zstd.flush = ZSTD_e_continue;
    s->ctx.zstd.error = ZSTD_error_no_error;
    s->ctx.zstd.pledged_src_size = ZSTD_CONTENTSIZE_UNKNOWN;
  }
  return s;
}

// ~CompressionStream (node_zlib.cc:460-465): the stream's JavaScript object is gone, with no write in flight.
EXPORT(tabnode_zlib_free) void tabnode_zlib_free(tabnode_zlib_t *s) {
  CHECK(!s->write_in_progress);
  stream_close(s);
  CHECK(atomic_load(&s->unreported_allocations) == 0);
  if (s->kind == kZlib) uv_mutex_destroy(&s->ctx.zlib.mutex);
  free(s->room);
  free(s);
}

// InitStream (node_zlib.cc:691-695): the write result and callback are the engine's.
EXPORT(tabnode_zlib_init_stream) void tabnode_zlib_init_stream(tabnode_zlib_t *s) { s->init_done = true; }

// ZlibContext::Init (node_zlib.cc:1250-1305), with ZlibStream::Init's arguments (751-820) as V8 read them;
// `dictionary` (malloc'd, or NULL) is the stream's from this call.
EXPORT(tabnode_zlib_init) void tabnode_zlib_init(tabnode_zlib_t *s, int level, uint32_t window_bits,
                                                 uint32_t mem_level, uint32_t strategy, int reject_garbage_after_end,
                                                 unsigned char *dictionary, uint32_t dictionary_size) {
  zlib_context_t *ctx = &s->ctx.zlib;
  ctx->strm.zalloc = alloc_for_zlib;
  ctx->strm.zfree = free_for_zlib;
  ctx->strm.opaque = stream_of_zlib(ctx);
  // windowBits is special. On the compression side, 0 is an invalid value. But on the decompression side, a value
  // of 0 for windowBits tells zlib to use the window size in the zlib header of the compressed stream.
  if (!(window_bits == 0 && (ctx->mode == INFLATE || ctx->mode == GUNZIP || ctx->mode == UNZIP))) {
    CHECK((window_bits >= Z_MIN_WINDOWBITS && window_bits <= Z_MAX_WINDOWBITS) && "invalid windowBits");
  }
  CHECK((level >= Z_MIN_LEVEL && level <= Z_MAX_LEVEL) && "invalid compression level");
  CHECK((mem_level >= Z_MIN_MEMLEVEL && mem_level <= Z_MAX_MEMLEVEL) && "invalid memlevel");
  CHECK((strategy == Z_FILTERED || strategy == Z_HUFFMAN_ONLY || strategy == Z_RLE || strategy == Z_FIXED ||
         strategy == Z_DEFAULT_STRATEGY) &&
        "invalid strategy");
  ctx->level = level;
  ctx->window_bits = (int)window_bits;
  ctx->mem_level = (int)mem_level;
  ctx->strategy = (int)strategy;
  ctx->reject_garbage_after_end = reject_garbage_after_end != 0;
  ctx->flush = Z_NO_FLUSH;
  ctx->err = Z_OK;
  if (ctx->mode == GZIP || ctx->mode == GUNZIP) ctx->window_bits += 16;
  if (ctx->mode == UNZIP) ctx->window_bits += 32;
  if (ctx->mode == DEFLATERAW || ctx->mode == INFLATERAW) ctx->window_bits *= -1;
  zlib_clear_dictionary(ctx);
  ctx->dictionary = dictionary_size ? dictionary : NULL;
  ctx->dictionary_size = dictionary_size;
  if (!dictionary_size) free(dictionary);
}

// ZlibStream::Init's argument count (node_zlib.cc:754-765): node-tar's old five-argument call is warned of, and a
// count other than seven or eight aborts.
EXPORT(tabnode_zlib_init_arity) void tabnode_zlib_init_arity(int argc) {
  // Refs: https://github.com/nodejs/node/issues/16649
  // Refs: https://github.com/nodejs/node/issues/14161
  if (argc == 5) {
    fprintf(stderr,
            "WARNING: You are likely using a version of node-tar or npm that "
            "is incompatible with this version of Node.js.\nPlease use "
            "either the version of npm that is bundled with Node.js, or "
            "a version of npm (> 5.5.1 or < 5.4.0) or node-tar (> 4.0.1) "
            "that is compatible with Node.js 9 and above.\n");
  }
  CHECK((argc == 7 || argc == 8) &&
        "init(windowBits, level, memLevel, strategy, writeResult, writeCallback, dictionary[, "
        "rejectGarbageAfterEnd])");
}

// ZlibStream::Params (node_zlib.cc:822-836): 1 where the error was emitted.
EXPORT(tabnode_zlib_params) int tabnode_zlib_params(tabnode_zlib_t *s, int level, int strategy) {
  compression_error_t err = zlib_set_params(&s->ctx.zlib, level, strategy);
  if (err.code == NULL) return 0;
  emit_error(s, err);
  return 1;
}

// BrotliCompressionStream::Init's context Init (node_zlib.cc:879-900): 1 where the error was emitted, and the engine
// throws ERR_ZLIB_INITIALIZATION_FAILED.
EXPORT(tabnode_brotli_init) int tabnode_brotli_init(tabnode_zlib_t *s, uint8_t *dictionary, uint32_t size) {
  compression_error_t err =
      s->kind == kBrotliEncoder ? brotli_encoder_init(s, dictionary, size) : brotli_decoder_init(s, dictionary, size);
  if (err.code == NULL) return 0;
  emit_error(s, err);
  return 1;
}

// BrotliCompressionStream::Init's parameters (node_zlib.cc:902-916): SetParams of parameter `key`, 1 where the error
// was emitted.
EXPORT(tabnode_brotli_set_param) int tabnode_brotli_set_param(tabnode_zlib_t *s, int key, uint32_t value) {
  compression_error_t err = s->kind == kBrotliEncoder ? brotli_encoder_set_params(&s->ctx.brotli, key, value)
                                                      : brotli_decoder_set_params(&s->ctx.brotli, key, value);
  if (err.code == NULL) return 0;
  emit_error(s, err);
  return 1;
}

// ZstdStream::Init's context Init (node_zlib.cc:965-1004): the pledge V8 read (ZSTD_CONTENTSIZE_UNKNOWN where
// `has_pledge` is 0) and the dictionary (in the process's memory for this call); 1 where the error was emitted, and
// the engine throws ERR_ZLIB_INITIALIZATION_FAILED with the error's message (`tabnode_zlib_error_message`).
EXPORT(tabnode_zstd_init) int tabnode_zstd_init(tabnode_zlib_t *s, int has_pledge, uint64_t pledge,
                                                const char *dictionary, uint32_t size) {
  uint64_t pledged_src_size = has_pledge ? pledge : ZSTD_CONTENTSIZE_UNKNOWN;
  compression_error_t err = s->kind == kZstdCompress ? zstd_compress_init(s, pledged_src_size, dictionary, size)
                                                     : zstd_decompress_init(s, dictionary, size);
  if (err.code == NULL) return 0;
  emit_error(s, err);
  s->last_message = err.message;
  return 1;
}

// ZstdStream::Init's parameters (node_zlib.cc:1006-1019): 1 where the error was emitted.
EXPORT(tabnode_zstd_set_param) int tabnode_zstd_set_param(tabnode_zlib_t *s, int key, int value) {
  compression_error_t err = s->kind == kZstdCompress ? zstd_compress_set_parameter(&s->ctx.zstd, key, value)
                                                     : zstd_decompress_set_parameter(&s->ctx.zstd, key, value);
  if (err.code == NULL) return 0;
  emit_error(s, err);
  s->last_message = err.message;
  return 1;
}

// CompressionStream::Reset (node_zlib.cc:653-667): -1 where a write is in progress (the engine throws "Cannot reset
// zlib stream while a write is in progress"), 1 where the reset's error was emitted.
EXPORT(tabnode_zlib_reset) int tabnode_zlib_reset(tabnode_zlib_t *s) {
  if (s->write_in_progress) return -1;
  compression_error_t err = context_reset_stream(s);
  if (err.code == NULL) return 0;
  emit_error(s, err);
  return 1;
}

// CompressionStream::Close (node_zlib.cc:469-488).
EXPORT(tabnode_zlib_close) void tabnode_zlib_close(tabnode_zlib_t *s) { stream_close(s); }

// Room for a write's input and output (`size` bytes), which the engine fills from the JavaScript buffers and the
// write reads and writes in place, as Node's in and out point into the Buffers. Write's own checks come first: a
// write never starts on a stream not initialized, finalized, or with a write in flight.
EXPORT(tabnode_zlib_room) char *tabnode_zlib_room(tabnode_zlib_t *s, uint32_t size) {
  CHECK(s->init_done && "write before init");
  CHECK(!s->closed && "already finalized");
  CHECK(!s->write_in_progress);
  CHECK(!s->pending_close);
  if (size > s->room_size) {
    char *grown = realloc(s->room, size);
    if (!grown) abort();
    s->room = grown;
    s->room_size = size;
  }
  return s->room;
}

// CompressionStream::Write<async> (node_zlib.cc:492-577) once its arguments are read: the input is the room's first
// `in_len` bytes (none where `has_in` is 0, a flush), the output the `out_len` after them. writeSync answers 0 where
// the write's result is in `tabnode_zlib_write_result`, 1 where its error was emitted; write answers 0 with the work
// scheduled, its end `zlib_done`.
EXPORT(tabnode_zlib_write) int tabnode_zlib_write(tabnode_zlib_t *s, uint32_t flush, int has_in, uint32_t in_len,
                                                  uint32_t out_len, int async) {
  if (flush != Z_NO_FLUSH && flush != Z_PARTIAL_FLUSH && flush != Z_SYNC_FLUSH && flush != Z_FULL_FLUSH &&
      flush != Z_FINISH && flush != Z_BLOCK) {
    UNREACHABLE("Invalid flush value");
  }
  CHECK(s->init_done && "write before init");
  CHECK(!s->closed && "already finalized");
  CHECK(!s->write_in_progress);
  CHECK(!s->pending_close);
  s->write_in_progress = true;
  const char *in = has_in ? s->room : NULL;
  if (!has_in) in_len = 0;
  context_set_buffers(s, in, in_len, s->room + in_len, out_len);
  context_set_flush(s, (int)flush);
  if (!async) {
    context_do_work(s);
    if (check_error(s)) {
      update_write_result(s);
      s->write_in_progress = false;
      return 0;
    }
    return 1;
  }
  if (uv_queue_work(uv_default_loop(), &s->work, work_cb, after_work_cb)) abort();
  return 0;
}

// write_result_ after a write: [0] avail_out, [1] avail_in, which the engine copies into the stream's Uint32Array.
EXPORT(tabnode_zlib_write_result) uint32_t *tabnode_zlib_write_result(tabnode_zlib_t *s) { return s->write_result; }

// The bytes the last write produced into its output (its out_len less the avail_out the context holds), which the
// engine copies into the JavaScript buffer it was given.
EXPORT(tabnode_zlib_produced) uint32_t tabnode_zlib_produced(tabnode_zlib_t *s, uint32_t out_len) {
  uint32_t avail_in, avail_out;
  context_offsets(s, &avail_in, &avail_out);
  return out_len - avail_out;
}

// The message of the error Zstd's Init or SetParameter emitted, which THROW_ERR_ZLIB_INITIALIZATION_FAILED carries.
EXPORT(tabnode_zlib_error_message) const char *tabnode_zlib_error_message(tabnode_zlib_t *s) {
  return s->last_message;
}

// CRC32 (node_zlib.cc:1862-1877): zlib's crc32 of `size` bytes.
EXPORT(tabnode_zlib_crc32) uint32_t tabnode_zlib_crc32(const unsigned char *data, uint32_t size, uint32_t value) {
  return (uint32_t)crc32(value, data, size);
}

// The binding's ZLIB_VERSION (node_zlib.cc:1905-1907) and process.versions' zlib, brotli and zstd
// (src/node_metadata.cc:104-133): ZLIB_VERSION, BrotliEncoderVersion() and ZSTD_VERSION_STRING.
EXPORT(tabnode_zlib_version) const char *tabnode_zlib_version(void) { return ZLIB_VERSION; }
EXPORT(tabnode_brotli_version) uint32_t tabnode_brotli_version(void) { return BrotliEncoderVersion(); }
EXPORT(tabnode_zstd_version) const char *tabnode_zstd_version(void) { return ZSTD_VERSION_STRING; }
