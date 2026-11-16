// internalBinding('uv') (Tabnode ADR-0018 §3): Node v24.21.0's src/uv.cc without V8, over libuv's uv.h. Its error
// table is uv.cc's per_process::uv_errors_map, UV_ERRNO_MAP expanded once (39-43), so every UV_* the binding defines
// and every [name, message] its getErrorMap holds is uv.h's, over the musl errno numbers libuv's own UV__E* are made
// of; errname and getErrorMessage are uv_err_name_r and uv_strerror_r into Node's 50 bytes (63-91). The engine's
// JavaScript builds the binding's object from these (src/node-lib/binding/uv.ts).
#include <stdint.h>
#include <uv.h>
#include "wrap.h"

// uv.cc's UVError: the number, its name without UV_, and libuv's message.
typedef struct {
  int32_t value;
  const char *name;
  const char *message;
} tabnode_uv_error_t;

_Static_assert(sizeof(tabnode_uv_error_t) == 12, "the engine reads an entry as three i32s");

static const tabnode_uv_error_t uv_errors_map[] = {
#define V(name, message) {UV_##name, #name, message},
    UV_ERRNO_MAP(V)
#undef V
};

// The map, its length in *count (uv.cc arraysize(per_process::uv_errors_map)).
TABNODE_EXPORT(tabnode_uv_errors) const tabnode_uv_error_t *tabnode_uv_errors(uint32_t *count) {
  *count = sizeof uv_errors_map / sizeof uv_errors_map[0];
  return uv_errors_map;
}

// ErrName (uv.cc:68-86): uv_err_name_r into `name`, 50 bytes.
TABNODE_EXPORT(tabnode_uv_err_name_r) void tabnode_uv_err_name_r(int err, char *name) { uv_err_name_r(err, name, 50); }

// GetErrMessage (uv.cc:60-66): uv_strerror_r into `message`, 50 bytes.
TABNODE_EXPORT(tabnode_uv_strerror_r) void tabnode_uv_strerror_r(int err, char *message) {
  uv_strerror_r(err, message, 50);
}
