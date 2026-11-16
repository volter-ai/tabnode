// The engine's imports (Tabnode ADR-0018 §2): what libnode's C calls in the realm's JavaScript, as Node's C++ calls
// into V8. One module, `host:tabnode`, the identity the substrate registers the engine under (its `hostPrograms`); the
// machine answers it from the engine module's `imports` (browser-substrate host/task.mjs).
#ifndef TABNODE_ENGINE_H
#define TABNODE_ENGINE_H
#include <stdint.h>
#include <uv.h>

#define TABNODE_IMPORT(name) __attribute__((import_module("host:tabnode"), import_name(#name)))

#ifdef __cplusplus
extern "C" {
#endif

// Runs Node's library over the bindings (Node's `node::LoadEnvironment`): answers 0, or the status to exit with.
TABNODE_IMPORT(bootstrap) int tabnode_bootstrap(int argc, char **argv);
// `timers_callback_function` (lib/internal/timers.js `processTimers`), called with the loop's now: the next expiry, 0
// for none, negative where no timer left holds the loop.
TABNODE_IMPORT(process_timers) double tabnode_process_timers(double now);
// `immediate_callback_function` (lib/internal/timers.js `processImmediate`).
TABNODE_IMPORT(process_immediate) void tabnode_process_immediate(void);
// The run's end (Tabnode ADR-0018 item 7), as SpinEventLoopInternal makes it once uv_run returns (src/api/
// embed_helpers.cc:40-76): `process.emit('beforeExit', code)` (EmitProcessBeforeExit, src/api/hooks.cc:33-51, through
// ProcessEmit's MakeCallback, src/node_process_events.cc:47-61), answering 0, or nonzero where the emission failed (a
// throw the process handled), where Node stops its loop (embed_helpers.cc:51-52).
TABNODE_IMPORT(before_exit) int tabnode_before_exit(void);
// `process.emit('exit', code)` (EmitProcessExitInternal, hooks.cc:61-93): the process exiting, its code 13 where it
// had none and its entry's top-level await is unsettled.
TABNODE_IMPORT(emit_exit) void tabnode_emit_exit(void);
// The code `main` returns once 'exit's listeners and their microtasks have run: the one they left (hooks.cc:91-92),
// or 1 where the emission failed (node_main_instance.cc:109-110).
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
// A uv_fs_event_t's change (FSEventWrap::OnEvent): libuv's filename (NULL for none), the event's name as the wrap
// chooses it ("rename", "change", or empty with an error) and the status.
TABNODE_IMPORT(fs_event) void tabnode_fs_event(uv_fs_event_t *handle, const char *filename, const char *event,
                                              int status);
// A uv_fs_poll_t's change (StatWatcher::Callback), its current and previous stats in the binding's stat arrays.
TABNODE_IMPORT(stat_watcher_change) void tabnode_stat_watcher_change(uv_fs_poll_t *handle, int status);
// The close of a callback's scope (Node's InternalCallbackScope::Close, src/api/callback.cc): the tick queue, then the
// microtasks, which a browser runs only between tasks, so the engine answers it by a suspension that resumes from the
// next task (a `Suspending` import).
TABNODE_IMPORT(drain) void tabnode_drain(void);
// A crypto job's completion (Tabnode ADR-0018 item 7; Node's CryptoJob::AfterThreadPoolWork, src/crypto/crypto_util.h:
// 301-363): libuv's threadpool ran the job's work (crypto_util.cc uv_queue_work) and the loop calls this with its
// after-work status (0, or UV_ECANCELED). The engine reads the job's result (ToResult) and calls its `ondone`, or
// settles its WebCrypto promise. Answers nonzero where it made a callback, whose scope the C then closes (`drain`); the
// C frees the job after.
TABNODE_IMPORT(crypto_job_done) int32_t tabnode_crypto_job_done(void *job, int32_t status);
// The engine device's descriptor is readable (crypto_engine.c's uv_poll_t, Tabnode ADR-0018 §5): an answer of the
// device waits, which the engine reads and gives to the call it answers. Followed by a drain.
TABNODE_IMPORT(engine_ready) void tabnode_engine_ready(int32_t status);
// The TLS callbacks (Tabnode ADR-0016 §4, ADR-0018 item 7): what OpenSSL raises inside an SSL_* call the engine made
// (crypto_tls.cc), which Node's TLSWrap answers in V8 synchronously, inside that call: so each is made with the
// engine's own call on the stack, and no scope closes after it. A connection is named by its TnSsl's address
// (crypto_util.h). TLSWrap::SSLInfoCallback (crypto_tls.cc:599-639): a handshake began (`done` 0) or completed (1).
TABNODE_IMPORT(tls_handshake) void tabnode_tls_handshake(void *tls, int32_t done);
// KeylogCallback (crypto_tls.cc:143-158): one NSS key log line, `length` bytes, with no newline.
TABNODE_IMPORT(tls_keylog) void tabnode_tls_keylog(void *tls, const char *line, uint32_t length);
// NewSessionCallback (crypto_tls.cc:160-208): the session's id and its DER.
TABNODE_IMPORT(tls_new_session) void tabnode_tls_new_session(void *tls, const unsigned char *id, uint32_t id_length,
                                                             const unsigned char *der, uint32_t der_length);
// SSLCertCallback (crypto_tls.cc:210-247): the ClientHello's servername and whether it asked for OCSP. Answers 1 to
// continue the handshake, -1 to suspend it until CertCbDone.
TABNODE_IMPORT(tls_cert) int32_t tabnode_tls_cert(void *tls, const char *servername, uint32_t length, int32_t ocsp);
// SelectALPNCallback's JavaScript branch (crypto_tls.cc:249-302): the offered protocols; answers the offset of the
// chosen one in them, or -1 for a fatal alert.
TABNODE_IMPORT(tls_alpn) int32_t tabnode_tls_alpn(void *tls, const unsigned char *protocols, uint32_t length);

#ifdef __cplusplus
}
#endif
#endif
