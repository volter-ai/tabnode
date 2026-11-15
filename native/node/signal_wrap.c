// SIGNALWRAP (Tabnode ADR-0018 §3, item 8): Node v24.21.0's src/signal_wrap.cc over a uv_signal_t in the process's
// memory, a HandleWrap (handle_wrap.c: close, ref, unref, hasRef, and OnClose, which frees it). `process.on('SIGxxx')`
// reaches it through Node's own lib/internal/process/signal.js (startListeningIfSignal), so a listener is libuv's
// uv_signal_t on the signal, beside any other of the loop's on the same signal (libuv runs every one of a signal over
// its one handler, uv__signal_handler, and its loop's signal pipe): a SIGCHLD listener is a second one beside the
// loop's child watcher, which it never displaces. libuv's callback calls the engine (an import), whose JavaScript
// makes the wrap's `onsignal` as MakeCallback does, then closes the callback's scope.
#include <stdlib.h>
#include <uv.h>
#include "engine.h"
#include "wrap.h"

// Start's callback (signal_wrap.cc:121-130): `onsignal(signum)`, then the scope's close.
static void on_signal(uv_signal_t *handle, int signum) {
  tabnode_signal_received(handle, signum);
  tabnode_drain();
}

// SignalWrap's constructor (signal_wrap.cc:88-95): its uv_signal_t, CHECK_EQ(uv_signal_init(...), 0), so the wrap is
// initialized when it is made. Node's `new` aborts where memory is out; so does this.
TABNODE_EXPORT(tabnode_signal_new) uv_signal_t *tabnode_signal_new(void) {
  uv_signal_t *handle = calloc(1, sizeof *handle);
  if (!handle || uv_signal_init(uv_default_loop(), handle) != 0) abort();
  return handle;
}

// SignalWrap::Start (signal_wrap.cc:105-141): uv_signal_start on `signum`; its answer is Start's.
TABNODE_EXPORT(tabnode_signal_start) int tabnode_signal_start(uv_signal_t *handle, int signum) {
  return uv_signal_start(handle, on_signal, signum);
}

// SignalWrap::Stop (signal_wrap.cc:143-154): uv_signal_stop; its answer is Stop's.
TABNODE_EXPORT(tabnode_signal_stop) int tabnode_signal_stop(uv_signal_t *handle) { return uv_signal_stop(handle); }
