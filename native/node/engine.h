// The engine's imports (Tabnode ADR-0018 §2): what libnode's C calls in the realm's JavaScript, as Node's C++ calls
// into V8. One module, `host:tabnode`, the identity the substrate registers the engine under (its `hostPrograms`); the
// machine answers it from the engine module's `imports` (browser-substrate host/task.mjs).
#ifndef TABNODE_ENGINE_H
#define TABNODE_ENGINE_H
#include <stdint.h>
#include <uv.h>

#define TABNODE_IMPORT(name) __attribute__((import_module("host:tabnode"), import_name(#name)))

// Runs Node's library over the bindings (Node's `node::LoadEnvironment`): answers 0, or the status to exit with.
TABNODE_IMPORT(bootstrap) int tabnode_bootstrap(int argc, char **argv);
// `timers_callback_function` (lib/internal/timers.js `processTimers`), called with the loop's now: the next expiry, 0
// for none, negative where no timer left holds the loop.
TABNODE_IMPORT(process_timers) double tabnode_process_timers(double now);
// `immediate_callback_function` (lib/internal/timers.js `processImmediate`).
TABNODE_IMPORT(process_immediate) void tabnode_process_immediate(void);
// `process.emit('beforeExit')` (Node's EmitProcessBeforeExit): answers 0, or nonzero where the process is stopping.
TABNODE_IMPORT(before_exit) int tabnode_before_exit(void);
// `process.emit('exit')` (Node's EmitProcessExitInternal, src/api/hooks.cc:61-89).
TABNODE_IMPORT(emit_exit) void tabnode_emit_exit(void);
// The exit code once 'exit's listeners and their microtasks have run (hooks.cc:91-92).
TABNODE_IMPORT(exit_code) int tabnode_exit_code(void);
// A descriptor the engine waits on is ready (poll.c): libuv's status and its events (UV_READABLE, UV_WRITABLE,
// UV_DISCONNECT).
TABNODE_IMPORT(poll_ready) void tabnode_poll_ready(int fd, int status, int events);
// The loop is about to wait (env.c's idle prepare handle, as Node's idle_prepare_handle_ marks its isolate idle,
// src/env.cc:1303-1312): it has nothing to do now, its poll would block. The engine decides there what it decides
// when its loop would park (a run's end), as libuv asks `uv__loop_alive` before it blocks.
TABNODE_IMPORT(loop_idle) void tabnode_loop_idle(void);
// The close of a callback's scope (Node's InternalCallbackScope::Close, src/api/callback.cc): the tick queue, then the
// microtasks, which a browser runs only between tasks, so the engine answers it by a suspension that resumes from the
// next task (a `Suspending` import).
TABNODE_IMPORT(drain) void tabnode_drain(void);
// HandleWrap::OnClose (src/handle_wrap.cc:135-157): the handle's wrap is closed, and the close callback its Close was
// given, where it was given one, is made as MakeCallback makes it. Answers nonzero where a callback was made, whose
// scope the C then closes (a drain).
TABNODE_IMPORT(handle_closed) int tabnode_handle_closed(uv_handle_t *handle);
// ProcessWrap::OnExit (src/process_wrap.cc:363-378): the handle's `onexit`, made as MakeCallback makes it, with the
// exit status and the name of the signal that ended the child (signo_string: its `signal_length` bytes, none for
// none); the scope's close is the C's drain.
TABNODE_IMPORT(process_exit) void tabnode_process_exit(uv_process_t *handle, double exit_status, const char *signal,
  uint32_t signal_length);
#endif
