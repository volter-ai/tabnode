// The engine's imports (Tabnode ADR-0018 §2): what libnode's C calls in the realm's JavaScript, as Node's C++ calls
// into V8. One module, `host:tabnode`, the identity the substrate registers the engine under (its `hostPrograms`); the
// machine answers it from the engine module's `imports` (browser-substrate host/task.mjs).
#ifndef TABNODE_ENGINE_H
#define TABNODE_ENGINE_H
#include <stdint.h>

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
// HandleWrap::OnClose (src/handle_wrap.cc:144-166): handle `id` is closed; its JavaScript runs its close callback.
TABNODE_IMPORT(handle_closed) void tabnode_handle_closed(int32_t id);
// LibuvStreamWrap::OnUvRead (src/stream_wrap.cc:229-270): stream `id` read `nread` bytes at `base` (UV_EOF or an error
// where negative; the buffer is freed once this returns). On an IPC pipe the JavaScript accepts the handle that came
// with them before it calls `onread`.
TABNODE_IMPORT(stream_read) void tabnode_stream_read(int32_t id, int32_t nread, const char *base);
// LibuvStreamWrap::AfterUvWrite and AfterUvShutdown (stream_wrap.cc:315-334, 392-400): request `id` completed.
TABNODE_IMPORT(stream_written) void tabnode_stream_written(int32_t id, int32_t status);
TABNODE_IMPORT(stream_shut) void tabnode_stream_shut(int32_t id, int32_t status);
// ConnectionWrap::OnConnection (src/connection_wrap.cc:30-72): listening stream `id` has a connection (or an error);
// the JavaScript makes the client's wrap, accepts it and calls `onconnection`.
TABNODE_IMPORT(stream_connection) void tabnode_stream_connection(int32_t id, int32_t status);
// ConnectionWrap::AfterConnect (connection_wrap.cc:75-112): connect request `id` completed, with the stream's
// readability and writability.
TABNODE_IMPORT(stream_connected) void tabnode_stream_connected(int32_t id, int32_t status, int32_t readable,
                                                              int32_t writable);
// UDPWrap::OnRecv (src/udp_wrap.cc:701-778): socket `id` received `nread` bytes at `base` from the address `name`
// describes (a tabnode_address_t, wrap.h), or an error where `nread` is negative (`name` NULL).
TABNODE_IMPORT(udp_received) void tabnode_udp_received(int32_t id, int32_t nread, const char *base, const void *name,
                                                      uint32_t flags);
// UDPWrap::OnSendDone (udp_wrap.cc:672-686): send request `id` completed.
TABNODE_IMPORT(udp_sent) void tabnode_udp_sent(int32_t id, int32_t status);
// The loop is about to wait (env.c's idle prepare handle, as Node's idle_prepare_handle_ marks its isolate idle,
// src/env.cc:1303-1312): it has nothing to do now, its poll would block. The engine decides there what it decides
// when its loop would park (a run's end), as libuv asks `uv__loop_alive` before it blocks.
TABNODE_IMPORT(loop_idle) void tabnode_loop_idle(void);
// The close of a callback's scope (Node's InternalCallbackScope::Close, src/api/callback.cc): the tick queue, then the
// microtasks, which a browser runs only between tasks, so the engine answers it by a suspension that resumes from the
// next task (a `Suspending` import).
TABNODE_IMPORT(drain) void tabnode_drain(void);
#endif
