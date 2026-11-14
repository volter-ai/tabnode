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
static uint64_t timer_base;
static uint32_t immediate_info[kImmediateFields];

static void run_timers(uv_timer_t *handle);
static void check_immediate(uv_check_t *handle);
static void idle_noop(uv_idle_t *handle) { (void)handle; }

// The loop's now, relative to its start (Environment::GetNowUint64, env.cc:1649-1655).
static uint64_t now_since_base(void) {
  uv_update_time(timer_handle.loop);
  return uv_now(timer_handle.loop) - timer_base;
}

// Environment::InitializeLibuv (env.cc:1124-1136): the timer and the check unreferenced, the idle stopped.
void tabnode_initialize_libuv(uv_loop_t *loop) {
  if (uv_timer_init(loop, &timer_handle)) abort();
  uv_unref((uv_handle_t *)&timer_handle);
  if (uv_check_init(loop, &immediate_check_handle)) abort();
  uv_unref((uv_handle_t *)&immediate_check_handle);
  if (uv_idle_init(loop, &immediate_idle_handle)) abort();
  if (uv_check_start(&immediate_check_handle, check_immediate)) abort();
  timer_base = uv_now(loop);
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
// Where the engine's ImmediateInfo lives in the process's memory.
__attribute__((export_name("tabnode_immediate_info"))) uint32_t *tabnode_immediate_info(void) { return immediate_info; }

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
