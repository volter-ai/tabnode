// THE http_parser BINDING'S C (Tabnode ADR-0018 §1, item 10): Node v24.21.0's src/node_http_parser.cc below V8, over
// the llhttp 9.4.3 (Node's deps/llhttp) that the program links. A Parser (tabnode_http_parser_t) is Node's: its llhttp_t
// and settings, its StringPtrs over the bytes llhttp hands it and the slab they are saved into, its header counts and
// limits, its timestamps and its ConnectionsList; a ConnectionsList is Node's two ordered sets of parsers. Each
// callback llhttp makes runs Node's member function here; where that function calls into V8 (a callback's lookup and
// call, a Buffer of the body, `maxHeaderPairs`) it calls the engine (engine.h `http_parser_*`), inside the engine's own
// `execute`, as Node's are made inside Parser::Execute: no scope closes after them, as InternalCallbackScope's
// kSkipTaskQueues closes none. The strings a callback hands JavaScript (CreateHeaders, the URL, the status message)
// are laid out in the parser's `table` for the engine to read, the bytes still the parser's.
//
// What V8 holds is the engine's (src/node-lib/binding/http_parser.ts): the arguments as V8 reads them, the Error an
// Execute's parse error makes, the parser's AsyncWrap (its resource and context).
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <llhttp.h>
#include <uv.h>

#include "engine.h"

#define EXPORT(name) __attribute__((export_name(#name)))
// Node's CHECK (src/util.h): the process aborts.
#define CHECK(condition)                                                                                           \
  do {                                                                                                             \
    if (!(condition)) {                                                                                            \
      fprintf(stderr, "node: %s:%d: Assertion `%s' failed.\n", __FILE__, __LINE__, #condition);                  \
      abort();                                                                                                     \
    }                                                                                                              \
  } while (0)

// node_http_parser.cc:76-104.
enum {
  kOnMessageBegin = 0,
  kOnHeaders = 1,
  kOnHeadersComplete = 2,
  kOnBody = 3,
  kOnMessageComplete = 4,
  kOnExecute = 5,
  kOnTimeout = 6
};
// Any more fields than this will be flushed into JS
#define kMaxHeaderFieldsCount 32
// Maximum size of chunk extensions
#define kMaxChunkExtensionsSize 16384

enum {
  kLenientNone = 0,
  kLenientHeaders = 1 << 0,
  kLenientChunkedLength = 1 << 1,
  kLenientKeepAlive = 1 << 2,
  kLenientTransferEncoding = 1 << 3,
  kLenientVersion = 1 << 4,
  kLenientDataAfterClose = 1 << 5,
  kLenientOptionalLFAfterCR = 1 << 6,
  kLenientOptionalCRLFAfterChunk = 1 << 7,
  kLenientOptionalCRBeforeLF = 1 << 8,
  kLenientSpacesAfterChunkSize = 1 << 9,
  kLenientHeaderValueRelaxed = 1 << 10,
  kLenientAll = kLenientHeaders | kLenientChunkedLength | kLenientKeepAlive | kLenientTransferEncoding |
                kLenientVersion | kLenientDataAfterClose | kLenientOptionalLFAfterCR | kLenientOptionalCRLFAfterChunk |
                kLenientOptionalCRBeforeLF | kLenientSpacesAfterChunkSize
};

static bool is_ows(char c) { return c == ' ' || c == '\t'; }

static void *checked_malloc(size_t size) {
  void *at = malloc(size ? size : 1);
  if (!at) abort();
  return at;
}

// StringPtrAllocator (node_http_parser.cc:128-156). Memory impact: ~8KB per parser.
#define kSlabSize 8192
typedef struct {
  char buffer[kSlabSize];
  size_t length;
} string_ptr_allocator_t;

// Allocate memory from the slab. Returns NULL if full.
static char *allocator_try_allocate(string_ptr_allocator_t *allocator, size_t size) {
  if (allocator->length + size > kSlabSize) return NULL;
  char *ptr = allocator->buffer + allocator->length;
  allocator->length += size;
  return ptr;
}
// Check if pointer is within this allocator's buffer.
static bool allocator_contains(const string_ptr_allocator_t *allocator, const char *ptr) {
  return ptr >= allocator->buffer && ptr < allocator->buffer + kSlabSize;
}

// StringPtr (node_http_parser.cc:158-247).
typedef struct {
  const char *str;
  bool on_heap;
  size_t size;
} string_ptr_t;

static void string_reset(string_ptr_t *s) {
  if (s->on_heap) {
    free((char *)s->str);
    s->on_heap = false;
  }
  s->str = NULL;
  s->size = 0;
}

// If str does not point to owned storage yet, this function makes it do so. This is called at the end of each
// http_parser_execute() so as not to leak references. See issue #2438 and test-http-parser-bad-ref.js.
static void string_save(string_ptr_t *s, string_ptr_allocator_t *allocator) {
  if (s->str == NULL || s->on_heap || (allocator != NULL && allocator_contains(allocator, s->str))) return;
  // Try allocator first, fall back to heap
  if (allocator != NULL) {
    char *ptr = allocator_try_allocate(allocator, s->size);
    if (ptr != NULL) {
      memcpy(ptr, s->str, s->size);
      s->str = ptr;
      return;
    }
  }
  char *copy = checked_malloc(s->size);
  memcpy(copy, s->str, s->size);
  s->str = copy;
  s->on_heap = true;
}

static void string_update(string_ptr_t *s, const char *str, size_t size, string_ptr_allocator_t *allocator) {
  if (s->str == NULL) {
    s->str = str;
  } else if (s->on_heap || (allocator != NULL && allocator_contains(allocator, s->str)) || s->str + s->size != str) {
    // Non-consecutive input, make a copy
    const size_t new_size = s->size + size;
    char *new_str = NULL;
    // Try allocator first (if not already on heap)
    if (!s->on_heap && allocator != NULL) new_str = allocator_try_allocate(allocator, new_size);
    if (new_str != NULL) {
      memcpy(new_str, s->str, s->size);
      memcpy(new_str + s->size, str, size);
      s->str = new_str;
    } else {
      // Fall back to heap
      char *grown = checked_malloc(new_size);
      memcpy(grown, s->str, s->size);
      memcpy(grown + s->size, str, size);
      if (s->on_heap) free((char *)s->str);
      s->str = grown;
      s->on_heap = true;
    }
  }
  s->size += size;
}

// A string the engine reads as OneByteString makes it (ToString; ToTrimmedString strips trailing OWS first, from the
// string itself): its address and its length in the process's memory.
typedef struct {
  uint32_t at;
  uint32_t length;
} tabnode_slice_t;

static tabnode_slice_t string_slice(const string_ptr_t *s) {
  return (tabnode_slice_t){(uint32_t)(uintptr_t)s->str, (uint32_t)s->size};
}
static tabnode_slice_t string_trimmed(string_ptr_t *s) {
  while (s->size > 0 && is_ows(s->str[s->size - 1])) s->size--;
  return string_slice(s);
}

struct tabnode_connections_s;

// Execute's answer, which the engine makes into V8's: nothing (Finish), the bytes read, a parse error (an Error
// with its bytesParsed, code and reason), or an exception a callback threw.
enum { kResultNothing, kResultRead, kResultParseError, kResultException };

typedef struct tabnode_http_parser_s {
  llhttp_t parser;
  string_ptr_allocator_t allocator;  // shared slab for all StringPtrs
  string_ptr_t fields[kMaxHeaderFieldsCount];
  string_ptr_t values[kMaxHeaderFieldsCount];
  string_ptr_t url;
  string_ptr_t status_message;
  size_t num_fields;
  size_t num_values;
  bool have_flushed;
  bool got_exception;
  bool is_being_freed;
  size_t current_buffer_len;
  const char *current_buffer_data;
  bool headers_completed;
  size_t header_pairs;
  double max_header_pairs;
  bool pending_pause;
  uint64_t header_nread;
  uint64_t chunk_extensions_nread;
  uint64_t max_http_header_size;
  uint64_t last_message_start;
  struct tabnode_connections_s *connections;
  // The strings of the callback being made: CreateHeaders' count of pairs and each one's field and trimmed value,
  // the URL and the status message.
  struct {
    uint32_t count;
    tabnode_slice_t url;
    tabnode_slice_t status_message;
    tabnode_slice_t headers[kMaxHeaderFieldsCount * 2];
  } table;
  struct {
    int32_t kind;
    int32_t nread;
    tabnode_slice_t code;
    tabnode_slice_t reason;
  } result;
} tabnode_http_parser_t;

// ---- ConnectionsList (node_http_parser.cc:249-293, 1149-1284) -----------------------------------------------------

// ParserComparator: idle parsers first, in their addresses' order, then by when their message began.
static bool parser_less(const tabnode_http_parser_t *lhs, const tabnode_http_parser_t *rhs) {
  if (lhs->last_message_start == 0 && rhs->last_message_start == 0) {
    // When both parsers are idle, guarantee strict order by comparing pointers as ints.
    return (uintptr_t)lhs < (uintptr_t)rhs;
  } else if (lhs->last_message_start == 0) {
    return true;
  } else if (rhs->last_message_start == 0) {
    return false;
  }
  return lhs->last_message_start < rhs->last_message_start;
}

// A std::set<Parser*, ParserComparator>: ordered by the comparator, one element of each equivalence.
typedef struct {
  tabnode_http_parser_t **items;
  size_t count;
  size_t room;
} parser_set_t;

static size_t set_lower_bound(const parser_set_t *set, const tabnode_http_parser_t *key) {
  size_t low = 0, high = set->count;
  while (low < high) {
    size_t middle = low + (high - low) / 2;
    if (parser_less(set->items[middle], key)) low = middle + 1;
    else high = middle;
  }
  return low;
}

static void set_insert(parser_set_t *set, tabnode_http_parser_t *parser) {
  size_t at = set_lower_bound(set, parser);
  if (at < set->count && !parser_less(parser, set->items[at])) return;
  if (set->count == set->room) {
    size_t room = set->room ? set->room * 2 : 16;
    tabnode_http_parser_t **grown = realloc(set->items, room * sizeof *grown);
    if (!grown) abort();
    set->items = grown;
    set->room = room;
  }
  memmove(set->items + at + 1, set->items + at, (set->count - at) * sizeof *set->items);
  set->items[at] = parser;
  set->count++;
}

static void set_erase(parser_set_t *set, const tabnode_http_parser_t *parser) {
  size_t at = set_lower_bound(set, parser);
  if (at >= set->count || parser_less(parser, set->items[at])) return;
  memmove(set->items + at, set->items + at + 1, (set->count - at - 1) * sizeof *set->items);
  set->count--;
}

typedef struct tabnode_connections_s {
  parser_set_t all_connections;
  parser_set_t active_connections;
} tabnode_connections_t;

static void connections_push(tabnode_connections_t *list, tabnode_http_parser_t *parser) {
  set_insert(&list->all_connections, parser);
}
static void connections_pop(tabnode_connections_t *list, tabnode_http_parser_t *parser) {
  set_erase(&list->all_connections, parser);
}
static void connections_push_active(tabnode_connections_t *list, tabnode_http_parser_t *parser) {
  set_insert(&list->active_connections, parser);
}
static void connections_pop_active(tabnode_connections_t *list, tabnode_http_parser_t *parser) {
  set_erase(&list->active_connections, parser);
}

// ---- Parser (node_http_parser.cc:295-1147) -----------------------------------------------------------------------

static tabnode_http_parser_t *parser_of(llhttp_t *p) {
  return (tabnode_http_parser_t *)((char *)p - offsetof(tabnode_http_parser_t, parser));
}

// CreateHeaders (node_http_parser.cc:946-956), into the table.
static void create_headers(tabnode_http_parser_t *p) {
  p->table.count = (uint32_t)p->num_values;
  for (size_t i = 0; i < p->num_values; ++i) {
    p->table.headers[i * 2] = string_slice(&p->fields[i]);
    p->table.headers[i * 2 + 1] = string_trimmed(&p->values[i]);
  }
}

// spill headers and request path to JS land (Flush, node_http_parser.cc:960-983).
static void flush(tabnode_http_parser_t *p) {
  if (!tabnode_http_parser_has_callback(p, kOnHeaders)) return;
  create_headers(p);
  p->table.url = string_slice(&p->url);
  if (tabnode_http_parser_flush(p) != 0) p->got_exception = true;
  string_reset(&p->url);
  p->have_flushed = true;
}

static int track_header(tabnode_http_parser_t *p, size_t len) {
  p->header_nread += len;
  if (p->header_nread >= p->max_http_header_size) {
    llhttp_set_error_reason(&p->parser, "HPE_HEADER_OVERFLOW:Header overflow");
    return HPE_USER;
  }
  return 0;
}

static int track_header_pair(tabnode_http_parser_t *p) {
  if (p->parser.type != HTTP_REQUEST) return 0;
  p->header_pairs += 2;
  if (p->max_header_pairs < 0) {
    // object()->Get("maxHeaderPairs"): NaN where the get threw.
    double value = tabnode_http_parser_max_header_pairs(p);
    if (isnan(value)) {
      p->got_exception = true;
      return -1;
    }
    p->max_header_pairs = value > 0 ? value : 0;
  }
  if (p->max_header_pairs > 0 && p->header_pairs > p->max_header_pairs) {
    llhttp_set_error_reason(&p->parser, "HPE_HEADER_OVERFLOW:Header overflow");
    return HPE_USER;
  }
  return 0;
}

static int maybe_pause(tabnode_http_parser_t *p) {
  if (!p->pending_pause) return 0;
  p->pending_pause = false;
  llhttp_set_error_reason(&p->parser, "Paused in callback");
  return HPE_PAUSED;
}

static int on_message_begin(tabnode_http_parser_t *p) {
  // Important: Pop from the lists BEFORE resetting the last_message_start otherwise std::set.erase will fail.
  if (p->connections != NULL) {
    connections_pop(p->connections, p);
    connections_pop_active(p->connections, p);
  }
  p->num_fields = p->num_values = 0;
  p->headers_completed = false;
  p->chunk_extensions_nread = 0;
  p->last_message_start = uv_hrtime();
  p->allocator.length = 0;
  string_reset(&p->url);
  string_reset(&p->status_message);
  p->max_header_pairs = -1;
  if (p->connections != NULL) {
    connections_push(p->connections, p);
    connections_push_active(p->connections, p);
  }
  // The callback's failure marks its scope failed (MarkAsFailed), and parsing goes on.
  if (tabnode_http_parser_has_callback(p, kOnMessageBegin)) tabnode_http_parser_call(p, kOnMessageBegin);
  return 0;
}

static int on_url(tabnode_http_parser_t *p, const char *at, size_t length) {
  int rv = track_header(p, length);
  if (rv != 0) return rv;
  string_update(&p->url, at, length, &p->allocator);
  return 0;
}

static int on_status(tabnode_http_parser_t *p, const char *at, size_t length) {
  int rv = track_header(p, length);
  if (rv != 0) return rv;
  string_update(&p->status_message, at, length, &p->allocator);
  return 0;
}

static int on_header_field(tabnode_http_parser_t *p, const char *at, size_t length) {
  int rv = track_header(p, length);
  if (rv != 0) return rv;
  if (p->num_fields == p->num_values) {
    // start of new field name
    rv = track_header_pair(p);
    if (rv != 0) return rv;
    p->num_fields++;
    if (p->num_fields == kMaxHeaderFieldsCount) {
      // ran out of space - flush to javascript land
      flush(p);
      p->num_fields = 1;
      p->num_values = 0;
    }
    string_reset(&p->fields[p->num_fields - 1]);
  }
  CHECK(p->num_fields < kMaxHeaderFieldsCount);
  CHECK(p->num_fields == p->num_values + 1);
  string_update(&p->fields[p->num_fields - 1], at, length, &p->allocator);
  return 0;
}

static int on_header_value(tabnode_http_parser_t *p, const char *at, size_t length) {
  int rv = track_header(p, length);
  if (rv != 0) return rv;
  if (p->num_values != p->num_fields) {
    // start of new header value
    p->num_values++;
    string_reset(&p->values[p->num_values - 1]);
  }
  CHECK(p->num_values < kMaxHeaderFieldsCount);
  CHECK(p->num_values == p->num_fields);
  string_update(&p->values[p->num_values - 1], at, length, &p->allocator);
  return 0;
}

static int on_headers_complete(tabnode_http_parser_t *p) {
  p->headers_completed = true;
  p->header_nread = 0;
  if (!tabnode_http_parser_has_callback(p, kOnHeadersComplete)) return 0;
  int flushed = p->have_flushed;
  if (flushed) {
    // Slow case, flush remaining headers.
    flush(p);
  } else {
    // Fast case, pass headers and URL to JS land.
    create_headers(p);
    p->table.url = string_slice(&p->url);
  }
  p->num_fields = 0;
  p->num_values = 0;
  p->header_pairs = 0;
  p->max_header_pairs = -1;
  p->table.status_message = string_slice(&p->status_message);
  // The arguments of `parserOnHeadersComplete` in lib/_http_common.js, which the engine lays out as A_VERSION_MAJOR
  // to A_SHOULD_KEEP_ALIVE (node_http_parser.cc:430-493); its answer's IntegerValue, NaN where it threw.
  double val = tabnode_http_parser_headers_complete(p, flushed, p->parser.type, p->parser.http_major,
                                                    p->parser.http_minor, p->parser.method, p->parser.status_code,
                                                    p->parser.upgrade, llhttp_should_keep_alive(&p->parser));
  if (isnan(val)) {
    p->got_exception = true;
    return -1;
  }
  return (int)(int64_t)val;
}

static int on_body(tabnode_http_parser_t *p, const char *at, size_t length) {
  if (length == 0) return 0;
  if (!tabnode_http_parser_has_callback(p, kOnBody)) return 0;
  // Buffer::Copy of the bytes, and MakeCallback.
  if (tabnode_http_parser_body(p, at, (uint32_t)length) != 0) {
    p->got_exception = true;
    llhttp_set_error_reason(&p->parser, "HPE_JS_EXCEPTION:JS Exception");
    return HPE_USER;
  }
  return 0;
}

static int on_message_complete(tabnode_http_parser_t *p) {
  // Important: Pop from the lists BEFORE resetting the last_message_start otherwise std::set.erase will fail.
  if (p->connections != NULL) {
    connections_pop(p->connections, p);
    connections_pop_active(p->connections, p);
  }
  p->last_message_start = 0;
  if (p->connections != NULL) connections_push(p->connections, p);
  if (p->num_fields) flush(p);  // Flush trailing HTTP headers.
  p->header_pairs = 0;
  if (!tabnode_http_parser_has_callback(p, kOnMessageComplete)) return 0;
  if (tabnode_http_parser_call(p, kOnMessageComplete) != 0) {
    p->got_exception = true;
    return -1;
  }
  return 0;
}

static int on_chunk_extension(tabnode_http_parser_t *p, const char *at, size_t length) {
  (void)at;
  p->chunk_extensions_nread += length;
  if (p->chunk_extensions_nread > kMaxChunkExtensionsSize) {
    llhttp_set_error_reason(&p->parser, "HPE_CHUNK_EXTENSIONS_OVERFLOW:Chunk extensions overflow");
    return HPE_USER;
  }
  return 0;
}

// Reset nread for the next chunk and also reset the extensions counter
static int on_chunk_header(tabnode_http_parser_t *p) {
  p->header_nread = 0;
  p->chunk_extensions_nread = 0;
  return 0;
}

// Reset nread for the next chunk
static int on_chunk_complete(tabnode_http_parser_t *p) {
  p->header_nread = 0;
  return 0;
}

// Proxy<...>::Raw (node_http_parser.cc:1127-1141): nothing for a parser being freed; a member's 0 is MaybePause's.
#define PROXY(member)                                                    \
  static int member##_raw(llhttp_t *raw) {                               \
    tabnode_http_parser_t *p = parser_of(raw);                           \
    if (p->is_being_freed) return 0;                                     \
    int rv = member(p);                                                  \
    if (rv == 0) rv = maybe_pause(p);                                    \
    return rv;                                                           \
  }
#define DATA_PROXY(member)                                                         \
  static int member##_raw(llhttp_t *raw, const char *at, size_t length) {          \
    tabnode_http_parser_t *p = parser_of(raw);                                     \
    if (p->is_being_freed) return 0;                                               \
    int rv = member(p, at, length);                                                \
    if (rv == 0) rv = maybe_pause(p);                                              \
    return rv;                                                                     \
  }
PROXY(on_message_begin)
DATA_PROXY(on_url)
DATA_PROXY(on_status)
DATA_PROXY(on_header_field)
DATA_PROXY(on_header_value)
DATA_PROXY(on_chunk_extension)
PROXY(on_headers_complete)
DATA_PROXY(on_body)
PROXY(on_message_complete)
PROXY(on_chunk_header)
PROXY(on_chunk_complete)

// Parser::settings (node_http_parser.cc:1286-1335).
static const llhttp_settings_t settings = {
    .on_message_begin = on_message_begin_raw,
    .on_url = on_url_raw,
    .on_status = on_status_raw,
    .on_header_field = on_header_field_raw,
    .on_header_value = on_header_value_raw,
    .on_chunk_extension_name = on_chunk_extension_raw,
    .on_chunk_extension_value = on_chunk_extension_raw,
    .on_headers_complete = on_headers_complete_raw,
    .on_body = on_body_raw,
    .on_message_complete = on_message_complete_raw,
    .on_chunk_header = on_chunk_header_raw,
    .on_chunk_complete = on_chunk_complete_raw,
};

// Parser::Init (node_http_parser.cc:986-1038).
static void parser_init(tabnode_http_parser_t *p, llhttp_type_t type, uint64_t max_http_header_size,
                        uint32_t lenient_flags) {
  llhttp_init(&p->parser, type, &settings);
  if (lenient_flags & kLenientHeaders) llhttp_set_lenient_headers(&p->parser, 1);
  if (lenient_flags & kLenientChunkedLength) llhttp_set_lenient_chunked_length(&p->parser, 1);
  if (lenient_flags & kLenientKeepAlive) llhttp_set_lenient_keep_alive(&p->parser, 1);
  if (lenient_flags & kLenientTransferEncoding) llhttp_set_lenient_transfer_encoding(&p->parser, 1);
  if (lenient_flags & kLenientVersion) llhttp_set_lenient_version(&p->parser, 1);
  if (lenient_flags & kLenientDataAfterClose) llhttp_set_lenient_data_after_close(&p->parser, 1);
  if (lenient_flags & kLenientOptionalLFAfterCR) llhttp_set_lenient_optional_lf_after_cr(&p->parser, 1);
  if (lenient_flags & kLenientOptionalCRLFAfterChunk) llhttp_set_lenient_optional_crlf_after_chunk(&p->parser, 1);
  if (lenient_flags & kLenientOptionalCRBeforeLF) llhttp_set_lenient_optional_cr_before_lf(&p->parser, 1);
  if (lenient_flags & kLenientSpacesAfterChunkSize) llhttp_set_lenient_spaces_after_chunk_size(&p->parser, 1);
  if (lenient_flags & kLenientHeaderValueRelaxed) llhttp_set_lenient_header_value_relaxed(&p->parser, 1);
  p->header_nread = 0;
  string_reset(&p->url);
  string_reset(&p->status_message);
  p->num_fields = 0;
  p->num_values = 0;
  p->have_flushed = false;
  p->got_exception = false;
  p->is_being_freed = false;
  p->headers_completed = false;
  p->max_http_header_size = max_http_header_size;
  p->header_pairs = 0;
  p->max_header_pairs = -1;
}

static void parser_save(tabnode_http_parser_t *p) {
  string_save(&p->url, &p->allocator);
  string_save(&p->status_message, &p->allocator);
  for (size_t i = 0; i < p->num_fields; i++) string_save(&p->fields[i], &p->allocator);
  for (size_t i = 0; i < p->num_values; i++) string_save(&p->values[i], &p->allocator);
}

// Parser::Execute (node_http_parser.cc:866-944), its answer in `result`.
static void parser_execute(tabnode_http_parser_t *p, const char *data, size_t len) {
  p->current_buffer_len = len;
  p->current_buffer_data = data;
  p->got_exception = false;
  llhttp_errno_t err;
  if (data == NULL) {
    err = llhttp_finish(&p->parser);
  } else {
    err = llhttp_execute(&p->parser, data, len);
    parser_save(p);
  }
  // Calculate bytes read and resume after Upgrade/CONNECT pause
  size_t nread = len;
  if (err != HPE_OK) {
    nread = (size_t)(llhttp_get_error_pos(&p->parser) - data);
    // This isn't a real pause, just a way to stop parsing early.
    if (err == HPE_PAUSED_UPGRADE) {
      err = HPE_OK;
      llhttp_resume_after_upgrade(&p->parser);
    }
  }
  // Apply pending pause
  if (p->pending_pause) {
    p->pending_pause = false;
    llhttp_pause(&p->parser);
  }
  p->current_buffer_len = 0;
  p->current_buffer_data = NULL;
  // Integer::New of the count, an int.
  p->result.nread = (int32_t)nread;
  // If there was an exception in one of the callbacks
  if (p->got_exception) {
    p->result.kind = kResultException;
    return;
  }
  // If there was a parse error in one of the callbacks
  if (!p->parser.upgrade && err != HPE_OK) {
    const char *errno_reason = llhttp_get_error_reason(&p->parser);
    if (err == HPE_USER) {
      const char *colon = strchr(errno_reason, ':');
      CHECK(colon != NULL);
      p->result.code = (tabnode_slice_t){(uint32_t)(uintptr_t)errno_reason, (uint32_t)(colon - errno_reason)};
      p->result.reason = (tabnode_slice_t){(uint32_t)(uintptr_t)(colon + 1), (uint32_t)strlen(colon + 1)};
    } else {
      const char *name = llhttp_errno_name(err);
      p->result.code = (tabnode_slice_t){(uint32_t)(uintptr_t)name, (uint32_t)strlen(name)};
      p->result.reason = (tabnode_slice_t){(uint32_t)(uintptr_t)errno_reason, (uint32_t)strlen(errno_reason)};
    }
    p->result.kind = kResultParseError;
    return;
  }
  // No return value is needed for `Finish()`
  p->result.kind = data == NULL ? kResultNothing : kResultRead;
}

// Parser::New (node_http_parser.cc:613-616).
EXPORT(tabnode_http_parser_new) tabnode_http_parser_t *tabnode_http_parser_new(void) {
  tabnode_http_parser_t *p = calloc(1, sizeof *p);
  if (!p) abort();
  p->max_header_pairs = -1;
  return p;
}

// Parser::Close (node_http_parser.cc:619-624): `delete parser`, its StringPtrs' heap copies with it.
EXPORT(tabnode_http_parser_close) void tabnode_http_parser_close(tabnode_http_parser_t *p) {
  for (size_t i = 0; i < kMaxHeaderFieldsCount; i++) {
    string_reset(&p->fields[i]);
    string_reset(&p->values[i]);
  }
  string_reset(&p->url);
  string_reset(&p->status_message);
  free(p);
}

// Parser::Remove (node_http_parser.cc:638-648).
EXPORT(tabnode_http_parser_remove) void tabnode_http_parser_remove(tabnode_http_parser_t *p) {
  p->is_being_freed = true;
  if (p->connections != NULL) {
    connections_pop(p->connections, p);
    connections_pop_active(p->connections, p);
  }
}

// Parser::Initialize (node_http_parser.cc:688-750) once V8 has read its arguments: the type, the header size (the
// process's --max-http-header-size where it was 0), the lenient flags and the list (NULL for none).
EXPORT(tabnode_http_parser_initialize) void tabnode_http_parser_initialize(tabnode_http_parser_t *p, int type,
                                                                           double max_http_header_size,
                                                                           uint32_t lenient_flags,
                                                                           tabnode_connections_t *list) {
  CHECK(type == HTTP_REQUEST || type == HTTP_RESPONSE);
  parser_init(p, (llhttp_type_t)type, (uint64_t)max_http_header_size, lenient_flags);
  if (list != NULL) {
    p->connections = list;
    // This protects from a DoS attack where an attacker establishes the connection without sending any data on
    // applications where server.timeout is left to the default value of zero.
    p->last_message_start = uv_hrtime();
    // Important: Push into the lists AFTER setting the last_message_start otherwise std::set.erase will fail later.
    connections_push(list, p);
    connections_push_active(list, p);
  } else {
    p->connections = NULL;
  }
}

// Parser::Pause<true> and Pause<false> (node_http_parser.cc:753-766).
EXPORT(tabnode_http_parser_pause) void tabnode_http_parser_pause(tabnode_http_parser_t *p, int should_pause) {
  if (should_pause) llhttp_pause(&p->parser);
  else llhttp_resume(&p->parser);
}

// Parser::Execute and Finish (node_http_parser.cc:664-685): `data` is the engine's copy of the buffer in the
// process's memory for this call (NULL for Finish). Answers the result's address.
EXPORT(tabnode_http_parser_execute) void *tabnode_http_parser_execute(tabnode_http_parser_t *p, const char *data,
                                                                      uint32_t length) {
  parser_execute(p, data, length);
  return &p->result;
}

// The strings of the callback being made (`table`).
EXPORT(tabnode_http_parser_table) void *tabnode_http_parser_table(tabnode_http_parser_t *p) { return &p->table; }

// GetCurrentBuffer (node_http_parser.cc:791-802): the bytes Execute is reading, Buffer::Copy'd by the engine.
EXPORT(tabnode_http_parser_current_buffer) const char *tabnode_http_parser_current_buffer(tabnode_http_parser_t *p,
                                                                                           uint32_t *length) {
  *length = (uint32_t)p->current_buffer_len;
  return p->current_buffer_data;
}

// ConnectionsList::New (node_http_parser.cc:1163-1168), and its memory once its object is collected (MakeWeak).
EXPORT(tabnode_connections_new) tabnode_connections_t *tabnode_connections_new(void) {
  tabnode_connections_t *list = calloc(1, sizeof *list);
  if (!list) abort();
  return list;
}
EXPORT(tabnode_connections_free) void tabnode_connections_free(tabnode_connections_t *list) {
  free(list->all_connections.items);
  free(list->active_connections.items);
  free(list);
}

// ConnectionsList::All, Idle, Active and Expired (node_http_parser.cc:1170-1284), `which` 0 to 3: the parsers, in
// the sets' order, as a malloc'd array of their addresses, its count at `count`. Expired's timeouts are seconds, as
// its Uint32 arguments.
EXPORT(tabnode_connections_list) tabnode_http_parser_t **tabnode_connections_list(tabnode_connections_t *list,
                                                                                    int which,
                                                                                    uint32_t headers_timeout_s,
                                                                                    uint32_t request_timeout_s,
                                                                                    uint32_t *count) {
  parser_set_t *all = &list->all_connections, *active = &list->active_connections;
  tabnode_http_parser_t **result = checked_malloc((all->count + active->count) * sizeof *result);
  size_t n = 0;
  if (which == 0) {
    for (size_t i = 0; i < all->count; i++) result[n++] = all->items[i];
  } else if (which == 1) {
    for (size_t i = 0; i < all->count; i++) {
      if (all->items[i]->last_message_start == 0) result[n++] = all->items[i];
    }
  } else if (which == 2) {
    for (size_t i = 0; i < active->count; i++) result[n++] = active->items[i];
  } else {
    uint64_t headers_timeout = (uint64_t)headers_timeout_s * 1000000;
    uint64_t request_timeout = (uint64_t)request_timeout_s * 1000000;
    if (headers_timeout == 0 && request_timeout == 0) {
      *count = 0;
      return result;
    } else if (request_timeout > 0 && headers_timeout > request_timeout) {
      uint64_t swap = headers_timeout;
      headers_timeout = request_timeout;
      request_timeout = swap;
    }
    // On IoT or embedded devices the uv_hrtime() may return the timestamp that is smaller than configured timeout
    // for headers or request to prevent subtracting two unsigned integers that can yield incorrect results we should
    // check if the 'now' is bigger than the timeout for headers or request
    const uint64_t now = uv_hrtime();
    const uint64_t headers_deadline = (headers_timeout > 0 && now > headers_timeout) ? now - headers_timeout : 0;
    const uint64_t request_deadline = (request_timeout > 0 && now > request_timeout) ? now - request_timeout : 0;
    if (headers_deadline == 0 && request_deadline == 0) {
      *count = 0;
      return result;
    }
    size_t i = 0;
    while (i < active->count) {
      tabnode_http_parser_t *parser = active->items[i];
      // Check for expiration.
      if ((!parser->headers_completed && headers_deadline > 0 && parser->last_message_start < headers_deadline) ||
          (request_deadline > 0 && parser->last_message_start < request_deadline)) {
        result[n++] = parser;
        set_erase(active, parser);
        continue;
      }
      i++;
    }
  }
  *count = (uint32_t)n;
  return result;
}

// CreatePerIsolateProperties' constants on HTTPParser and CreatePerContextProperties' `methods` and `allMethods`
// (node_http_parser.cc:1337-1465), as text the engine builds them from, malloc'd, its length at `length`: one line
// each, "c NAME VALUE" for a constant, "m NAME" for HTTP_METHOD_MAP's methods and "a NAME" for HTTP_ALL_METHOD_MAP's.
EXPORT(tabnode_http_parser_binding) char *tabnode_http_parser_binding(uint32_t *length) {
  size_t room = 8192, used = 0;
  char *text = checked_malloc(room);
#define APPEND(...)                                                                \
  do {                                                                             \
    int wrote = snprintf(text + used, room - used, __VA_ARGS__);                   \
    CHECK(wrote >= 0 && (size_t)wrote < room - used);                              \
    used += (size_t)wrote;                                                         \
  } while (0)
#define CONSTANT(name, value) APPEND("c %s %u\n", name, (unsigned)(value));
  CONSTANT("REQUEST", HTTP_REQUEST)
  CONSTANT("RESPONSE", HTTP_RESPONSE)
  CONSTANT("kOnMessageBegin", kOnMessageBegin)
  CONSTANT("kOnHeaders", kOnHeaders)
  CONSTANT("kOnHeadersComplete", kOnHeadersComplete)
  CONSTANT("kOnBody", kOnBody)
  CONSTANT("kOnMessageComplete", kOnMessageComplete)
  CONSTANT("kOnExecute", kOnExecute)
  CONSTANT("kOnTimeout", kOnTimeout)
  CONSTANT("kLenientNone", kLenientNone)
  CONSTANT("kLenientHeaders", kLenientHeaders)
  CONSTANT("kLenientChunkedLength", kLenientChunkedLength)
  CONSTANT("kLenientKeepAlive", kLenientKeepAlive)
  CONSTANT("kLenientTransferEncoding", kLenientTransferEncoding)
  CONSTANT("kLenientVersion", kLenientVersion)
  CONSTANT("kLenientDataAfterClose", kLenientDataAfterClose)
  CONSTANT("kLenientOptionalLFAfterCR", kLenientOptionalLFAfterCR)
  CONSTANT("kLenientOptionalCRLFAfterChunk", kLenientOptionalCRLFAfterChunk)
  CONSTANT("kLenientOptionalCRBeforeLF", kLenientOptionalCRBeforeLF)
  CONSTANT("kLenientSpacesAfterChunkSize", kLenientSpacesAfterChunkSize)
  // llhttp 9.4 has llhttp_set_lenient_header_value_relaxed (node_http_parser.cc:1385-1394).
  CONSTANT("kLenientHeaderValueRelaxed", kLenientHeaderValueRelaxed)
  CONSTANT("kLenientAll", kLenientAll)
#undef CONSTANT
#define V(num, name, string) APPEND("m %s\n", #string);
  HTTP_METHOD_MAP(V)
#undef V
#define V(num, name, string) APPEND("a %s\n", #string);
  HTTP_ALL_METHOD_MAP(V)
#undef V
#undef APPEND
  *length = (uint32_t)used;
  return text;
}

// process.versions' llhttp (src/node_metadata.cc:113-118): LLHTTP_VERSION_MAJOR.MINOR.PATCH.
#define TABNODE_STRINGIFY_(x) #x
#define TABNODE_STRINGIFY(x) TABNODE_STRINGIFY_(x)
EXPORT(tabnode_llhttp_version) const char *tabnode_llhttp_version(void) {
  return TABNODE_STRINGIFY(LLHTTP_VERSION_MAJOR) "." TABNODE_STRINGIFY(LLHTTP_VERSION_MINOR) "." TABNODE_STRINGIFY(
      LLHTTP_VERSION_PATCH);
}
