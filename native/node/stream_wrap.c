// STREAM_WRAP (Tabnode ADR-0018 §3, §4): Node v24.21.0's src/stream_wrap.cc (LibuvStreamWrap), the libuv half of
// src/stream_base.cc (StreamBase::Write, Shutdown, the listeners' alloc) and src/connection_wrap.cc (OnConnection,
// AfterConnect), without V8. A read, a write's and a shutdown's completion, a connection and a connect's completion
// each call the engine (engine.h), as Node's MakeCallback calls the wrap's JavaScript, and close that callback's scope
// with tabnode_drain before returning to libuv. What the JavaScript decides with each (the pending handle an IPC read
// carries, the client a connection makes) is Node's JavaScript-facing C++'s, kept in the binding beside its object.
#include <stdlib.h>
#include "wrap.h"

// EmitToJSStreamListener::OnStreamAlloc (stream_base.cc:686-690), Node's managed buffer of the suggested size, or
// CustomBufferJSListener::OnStreamAlloc (stream_base.cc:718-722), the program's buffer's length.
static void on_alloc(uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf) {
  tabnode_wrap_t *wrap = handle->data;
  size_t size = wrap->user_buffer ? wrap->user_buffer : suggested_size;
  char *base = malloc(size);
  *buf = uv_buf_init(base, base ? size : 0);
}

// LibuvStreamWrap::OnUvRead (stream_wrap.cc:229-270) and EmitRead: the engine takes the bytes out of the buffer (and,
// on an IPC pipe, the handle that came with them) and calls `onread`; the buffer is the managed one, released here.
static void on_read(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
  tabnode_stream_read(stream, (int32_t)nread, buf->base);
  tabnode_drain();
  free(buf->base);
}

// LibuvStreamWrap::ReadStart and ReadStop (stream_wrap.cc:184-205).
TABNODE_EXPORT(tabnode_stream_read_start) int tabnode_stream_read_start(tabnode_wrap_t *wrap) {
  return uv_read_start(&wrap->uv.stream, on_alloc, on_read);
}
TABNODE_EXPORT(tabnode_stream_read_stop) int tabnode_stream_read_stop(tabnode_wrap_t *wrap) {
  return uv_read_stop(&wrap->uv.stream);
}
// StreamBase::UseUserBuffer (stream_base.cc:118-124): reads go to the program's buffer of `length` bytes; 0 puts the
// managed buffer back.
TABNODE_EXPORT(tabnode_stream_use_buffer) void tabnode_stream_use_buffer(tabnode_wrap_t *wrap, uint32_t length) {
  wrap->user_buffer = length;
}

static void after_write(uv_write_t *write, int status) {
  tabnode_req_t *req = write->data;
  tabnode_stream_written(req->id, status);
  tabnode_drain();
  tabnode_req_free(req);
}

// StreamBase::Write (stream_base.cc:45-92) over LibuvStreamWrap's DoTryWrite and DoWrite (stream_wrap.cc:337-389):
// `bytes` (which the call owns) are tried at once unless a handle is sent, and what remains is uv_write2'd under
// request `id`. WriteString's own try of a short string (stream_base.cc:377-407) is this one try, of the same bytes.
// Answers 0 where the write completed synchronously, 1 where it was dispatched (its request owns the bytes until
// AfterUvWrite), or an error.
TABNODE_EXPORT(tabnode_stream_write) int tabnode_stream_write(tabnode_wrap_t *wrap, int32_t id, char *bytes,
                                                              uint32_t length, tabnode_wrap_t *send_handle) {
  uv_buf_t buf = uv_buf_init(bytes, length);
  if (!send_handle) {
    int err = uv_try_write(&wrap->uv.stream, &buf, 1);
    if (err == UV_ENOSYS || err == UV_EAGAIN) err = 0;
    if (err < 0 || (uint32_t)err == length) {
      free(bytes);
      return err < 0 ? err : 0;
    }
    buf.base += err;
    buf.len -= err;
  }
  tabnode_req_t *req = tabnode_req_new(id, bytes);
  int err = uv_write2(&req->uv.write, &wrap->uv.stream, &buf, 1, send_handle ? &send_handle->uv.stream : NULL,
                      after_write);
  if (err) {
    tabnode_req_free(req);
    return err;
  }
  return 1;
}

static void after_shutdown(uv_shutdown_t *shutdown, int status) {
  tabnode_req_t *req = shutdown->data;
  tabnode_stream_shut(req->id, status);
  tabnode_drain();
  tabnode_req_free(req);
}

// LibuvStreamWrap::DoShutdown (stream_wrap.cc:309-312) under request `id`.
TABNODE_EXPORT(tabnode_stream_shutdown) int tabnode_stream_shutdown(tabnode_wrap_t *wrap, int32_t id) {
  tabnode_req_t *req = tabnode_req_new(id, NULL);
  int err = uv_shutdown(&req->uv.shutdown, &wrap->uv.stream, after_shutdown);
  if (err) tabnode_req_free(req);
  return err;
}

// LibuvStreamWrap::GetWriteQueueSize and SetBlocking (stream_wrap.cc:272-297).
TABNODE_EXPORT(tabnode_stream_write_queue_size) uint32_t tabnode_stream_write_queue_size(tabnode_wrap_t *wrap) {
  return (uint32_t)wrap->uv.stream.write_queue_size;
}
TABNODE_EXPORT(tabnode_stream_set_blocking) int tabnode_stream_set_blocking(tabnode_wrap_t *wrap, int blocking) {
  return uv_stream_set_blocking(&wrap->uv.stream, blocking);
}

// ConnectionWrap::OnConnection (connection_wrap.cc:30-72): the engine makes the client's wrap and accepts it
// (`tabnode_stream_accept`), then calls `onconnection`.
static void on_connection(uv_stream_t *server, int status) {
  tabnode_stream_connection(server, status);
  tabnode_drain();
}

// TCPWrap::Listen and PipeWrap::Listen (tcp_wrap.cc:536-547, pipe_wrap.cc:179-189).
TABNODE_EXPORT(tabnode_stream_listen) int tabnode_stream_listen(tabnode_wrap_t *wrap, int backlog) {
  return uv_listen(&wrap->uv.stream, backlog, on_connection);
}
// uv_accept of OnConnection and of AcceptHandle (stream_wrap.cc:207-227).
TABNODE_EXPORT(tabnode_stream_accept) int tabnode_stream_accept(tabnode_wrap_t *server, tabnode_wrap_t *client) {
  return uv_accept(&server->uv.stream, &client->uv.stream);
}

// ConnectionWrap::AfterConnect (connection_wrap.cc:75-112): the request's status, and the stream's readability and
// writability once connected.
void tabnode_after_connect(uv_connect_t *connect, int status) {
  tabnode_req_t *req = connect->data;
  int readable = 0, writable = 0;
  if (status == 0) {
    readable = uv_is_readable(connect->handle) != 0;
    writable = uv_is_writable(connect->handle) != 0;
  }
  tabnode_stream_connected(req->id, status, readable, writable);
  tabnode_drain();
  tabnode_req_free(req);
}
