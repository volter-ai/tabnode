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
// The bindings' callbacks (Tabnode ADR-0018 §3, §4): what libuv calls back into a handle's or a request's JavaScript,
// as Node's C++ makes each with MakeCallback. A handle is named by its address (it begins with its uv_handle_t, as
// Node's handle->data names its wrap, handle_wrap.c); a stream's or a socket's request by the number its JavaScript
// gave it (wrap.h tabnode_req_t). Each C caller closes the callback's scope (`drain`) after the import returns.
//
// HandleWrap::OnClose (src/handle_wrap.cc:135-157): the handle's wrap is closed, and the close callback its Close was
// given, where it was given one, is made. Answers nonzero where a callback was made, whose scope the C then closes;
// the C frees the handle after.
TABNODE_IMPORT(handle_closed) int tabnode_handle_closed(uv_handle_t *handle);
// LibuvStreamWrap::OnUvRead (src/stream_wrap.cc:229-270): the stream read `nread` bytes at `base` (UV_EOF or an error
// where negative; the buffer is freed once this returns). On an IPC pipe the JavaScript accepts the handle that came
// with them before it calls `onread`.
TABNODE_IMPORT(stream_read) void tabnode_stream_read(uv_stream_t *stream, int32_t nread, const char *base);
// LibuvStreamWrap::AfterUvWrite and AfterUvShutdown (stream_wrap.cc:315-334, 392-400): request `id` completed.
TABNODE_IMPORT(stream_written) void tabnode_stream_written(int32_t id, int32_t status);
TABNODE_IMPORT(stream_shut) void tabnode_stream_shut(int32_t id, int32_t status);
// ConnectionWrap::OnConnection (src/connection_wrap.cc:30-72): the listening stream has a connection (or an error);
// the JavaScript makes the client's wrap, accepts it and calls `onconnection`.
TABNODE_IMPORT(stream_connection) void tabnode_stream_connection(uv_stream_t *server, int32_t status);
// ConnectionWrap::AfterConnect (connection_wrap.cc:75-112): connect request `id` completed, with the stream's
// readability and writability.
TABNODE_IMPORT(stream_connected) void tabnode_stream_connected(int32_t id, int32_t status, int32_t readable,
                                                              int32_t writable);
// UDPWrap::OnRecv (src/udp_wrap.cc:701-778): the socket received `nread` bytes at `base` from the address `name`
// describes (a tabnode_address_t, wrap.h), or an error where `nread` is negative (`name` NULL).
TABNODE_IMPORT(udp_received) void tabnode_udp_received(uv_udp_t *handle, int32_t nread, const char *base,
                                                      const void *name, uint32_t flags);
// UDPWrap::OnSendDone (udp_wrap.cc:672-686): send request `id` completed.
TABNODE_IMPORT(udp_sent) void tabnode_udp_sent(int32_t id, int32_t status);
// ProcessWrap::OnExit (src/process_wrap.cc:363-378): the handle's `onexit`, with the exit status and the name of the
// signal that ended the child (signo_string: its `signal_length` bytes, none for none).
TABNODE_IMPORT(process_exit) void tabnode_process_exit(uv_process_t *handle, double exit_status, const char *signal,
                                                      uint32_t signal_length);
// SignalWrap's uv_signal_cb (src/signal_wrap.cc:121-130, signal_wrap.c; ADR-0018 item 8): the handle's `onsignal`,
// with the signal's number.
TABNODE_IMPORT(signal_received) void tabnode_signal_received(uv_signal_t *handle, int signum);
// The fs binding's completions (native/node fs.c, fs_event.c; ADR-0018 item 6). Each is what Node's C++ does in V8
// at that point, and each is followed by the callback scope's close, a drain.
struct tabnode_fs_s;
// An asynchronous request completed on libuv's threadpool (its uv_fs_cb, run on the loop): the request's After
// (node_file.cc AfterNoArgs, AfterStat, AfterInteger, ..., node_dir.cc AfterOpenDir, AfterDirRead) and its
// MakeCallback, or its promise's settling. The engine frees the request.
TABNODE_IMPORT(fs_done) void tabnode_fs_done(struct tabnode_fs_s *request);
// A uv_fs_event_t's change (FSEventWrap::OnEvent): libuv's filename (NULL for none), events and status.
TABNODE_IMPORT(fs_event) void tabnode_fs_event(uv_fs_event_t *handle, const char *filename, int events, int status);
// A uv_fs_poll_t's change (StatWatcher::Callback), its current and previous stats in the binding's stat arrays.
TABNODE_IMPORT(stat_watcher_change) void tabnode_stat_watcher_change(uv_fs_poll_t *handle, int status);
// The loop is about to wait (env.c's idle prepare handle, as Node's idle_prepare_handle_ marks its isolate idle,
// src/env.cc:1303-1312): it has nothing to do now, its poll would block. The engine decides there what it decides
// when its loop would park (a run's end), as libuv asks `uv__loop_alive` before it blocks.
TABNODE_IMPORT(loop_idle) void tabnode_loop_idle(void);
// The close of a callback's scope (Node's InternalCallbackScope::Close, src/api/callback.cc): the tick queue, then the
// microtasks, which a browser runs only between tasks, so the engine answers it by a suspension that resumes from the
// next task (a `Suspending` import).
TABNODE_IMPORT(drain) void tabnode_drain(void);
#endif
