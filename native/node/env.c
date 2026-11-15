// THE LOOP'S OWN HANDLES (Tabnode ADR-0018 §2, §4), as Node's Environment holds them (src/env.cc, Node v24.21.0): one
// timer for every JavaScript timer, a check and an idle handle for immediates. Each function names the lines it
// carries; where Node calls into V8 it calls the engine (engine.h), and where Node's InternalCallbackScope closes it
// calls tabnode_drain.
#include <stdlib.h>
#include "engine.h"
#include "env.h"

static uv_timer_t timer_handle;
static uv_check_t immediate_check_handle;
static uv_idle_t immediate_idle_handle;
// Node's idle_prepare_handle_ (src/env.h, env.cc:1142, 1155, 1303-1307): unreferenced, so it never keeps the loop alive.
static uv_prepare_t idle_prepare_handle;
static uint64_t timer_base;
static uint32_t immediate_info[kImmediateFields];
// Node's timeout_info_ (src/env.h:1129, an AliasedInt32Array of one): the count of referenced timers, which the
// engine's JavaScript keeps in place (lib/internal/timers.js `timeoutInfo[0]`).
static int32_t timeout_info[1];

static void run_timers(uv_timer_t *handle);
static void check_immediate(uv_check_t *handle);
static void idle_noop(uv_idle_t *handle) { (void)handle; }
static void prepare_idle(uv_prepare_t *handle);

// The loop's now, relative to its start (Environment::GetNowUint64, env.cc:1649-1655).
static uint64_t now_since_base(void) {
  uv_update_time(timer_handle.loop);
  return uv_now(timer_handle.loop) - timer_base;
}

// Environment::InitializeLibuv (env.cc:1124-1158): the timer and the check unreferenced, the idle stopped, and the idle
// prepare handle unreferenced and started (StartProfilerIdleNotifier, env.cc:1303-1307).
void tabnode_initialize_libuv(uv_loop_t *loop) {
  if (uv_timer_init(loop, &timer_handle)) abort();
  uv_unref((uv_handle_t *)&timer_handle);
  if (uv_check_init(loop, &immediate_check_handle)) abort();
  uv_unref((uv_handle_t *)&immediate_check_handle);
  if (uv_idle_init(loop, &immediate_idle_handle)) abort();
  if (uv_check_start(&immediate_check_handle, check_immediate)) abort();
  if (uv_prepare_init(loop, &idle_prepare_handle)) abort();
  uv_unref((uv_handle_t *)&idle_prepare_handle);
  if (uv_prepare_start(&idle_prepare_handle, prepare_idle)) abort();
  timer_base = uv_now(loop);
}

// The idle prepare handle, run before each poll (uv_run's prepare phase, deps/uv/src/unix/core.c:452, the timeout
// read after it, :456): where Node marks its isolate idle, the engine is told the loop would wait, only when its poll
// would block. uv_backend_timeout is 0 where an idle handle, a closing handle or a pending callback keeps it from
// blocking (core.c:401-411), and also while watcher changes are queued (:414-419), a descriptor's wait just started,
// which is a live wait: the engine is told on the next iteration instead, never wrongly. The scope it opens closes as
// any callback's.
static void prepare_idle(uv_prepare_t *handle) {
  if (uv_backend_timeout(handle->loop) == 0) return;
  tabnode_loop_idle();
  tabnode_drain();
}

// The `timers` binding's calls (src/timers.cc over Environment, env.cc:1537-1550, 1638-1647, 1649-1655).
__attribute__((export_name("tabnode_timers_now"))) double tabnode_timers_now(void) { return (double)now_since_base(); }
__attribute__((export_name("tabnode_schedule_timer"))) void tabnode_schedule_timer(int64_t duration_ms) {
  uv_timer_start(&timer_handle, run_timers, duration_ms, 0);
}
__attribute__((export_name("tabnode_toggle_timer_ref"))) void tabnode_toggle_timer_ref(int ref) {
  if (ref) uv_ref((uv_handle_t *)&timer_handle);
  else uv_unref((uv_handle_t *)&timer_handle);
}
__attribute__((export_name("tabnode_toggle_immediate_ref"))) void tabnode_toggle_immediate_ref(int ref) {
  // The idle handle only keeps the loop from blocking in its poll (env.cc:1641-1643).
  if (ref) uv_idle_start(&immediate_idle_handle, idle_noop);
  else uv_idle_stop(&immediate_idle_handle);
}
// Where the engine's ImmediateInfo and timeoutInfo live in the process's memory.
__attribute__((export_name("tabnode_immediate_info"))) uint32_t *tabnode_immediate_info(void) { return immediate_info; }
__attribute__((export_name("tabnode_timeout_info"))) int32_t *tabnode_timeout_info(void) { return timeout_info; }

// Environment::RunTimers (env.cc:1552-1611): the JavaScript runs every due timer and answers the next expiry. Node
// calls again while the callback throws; here a throw is the realm's uncaught exception, which ends the process
// (browser-substrate host/task.mjs), so the call is made once.
static void run_timers(uv_timer_t *handle) {
  double expiry_ms = tabnode_process_timers((double)now_since_base());
  tabnode_drain();
  if (expiry_ms != 0) {
    int64_t duration_ms = llabs((long long)expiry_ms) - (int64_t)(uv_now(handle->loop) - timer_base);
    tabnode_schedule_timer(duration_ms > 0 ? duration_ms : 1);
    if (expiry_ms > 0) uv_ref((uv_handle_t *)handle);
    else uv_unref((uv_handle_t *)handle);
  } else {
    uv_unref((uv_handle_t *)handle);
  }
}

// Environment::CheckImmediate (env.cc:1613-1636): the immediates, one callback scope each, while any is outstanding.
static void check_immediate(uv_check_t *handle) {
  (void)handle;
  if (immediate_info[kImmediateCount] == 0) return;
  do {
    tabnode_process_immediate();
    tabnode_drain();
  } while (immediate_info[kImmediateHasOutstanding]);
  if (immediate_info[kImmediateRefCount] == 0) tabnode_toggle_immediate_ref(0);
}
