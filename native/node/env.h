// The loop's own handles (Node's Environment, src/env.cc), without V8.
#ifndef TABNODE_ENV_H
#define TABNODE_ENV_H
#include <stdint.h>
#include <uv.h>

// Node's ImmediateInfo fields (src/env.h, `immediate_info_`), an array the engine's JavaScript reads and writes in
// place, as Node's AliasedUint32Array aliases it.
enum { kImmediateCount, kImmediateRefCount, kImmediateHasOutstanding, kImmediateFields };

void tabnode_initialize_libuv(uv_loop_t *loop);
#endif
