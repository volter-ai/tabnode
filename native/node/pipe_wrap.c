// PIPE_WRAP (Tabnode ADR-0018 §3, item 3): Node v24.21.0's src/pipe_wrap.cc without V8. The handle is a uv_pipe_t of
// the process's loop, an IPC one where Node makes one (`new Pipe(IPC)`); its socket, its bind and connect (with
// UV_PIPE_NO_TRUNCATE, so a name too long for sun_path is UV_EINVAL), its chmod and the handles an IPC pipe carries
// are libuv's (deps/uv's src/unix/pipe.c, stream.c). A name crosses as its bytes and their length: an abstract
// socket's begins with a NUL.
#include <stdlib.h>
#include "wrap.h"

// PipeWrap's constructor (pipe_wrap.cc:144-152): uv_pipe_init cannot fail but for memory.
TABNODE_EXPORT(tabnode_pipe_init) tabnode_wrap_t *tabnode_pipe_init(int ipc) {
  tabnode_wrap_t *wrap = tabnode_wrap_new();
  if (uv_pipe_init(uv_default_loop(), &wrap->uv.pipe, ipc)) abort();
  wrap->uv.handle.data = wrap;
  return wrap;
}

// PipeWrap::Bind (pipe_wrap.cc:154-161).
TABNODE_EXPORT(tabnode_pipe_bind) int tabnode_pipe_bind(tabnode_wrap_t *wrap, const char *name, uint32_t length) {
  return uv_pipe_bind2(&wrap->uv.pipe, name, length, UV_PIPE_NO_TRUNCATE);
}

// PipeWrap::Open (pipe_wrap.cc:191-205).
TABNODE_EXPORT(tabnode_pipe_open) int tabnode_pipe_open(tabnode_wrap_t *wrap, int fd) {
  return uv_pipe_open(&wrap->uv.pipe, fd);
}

// PipeWrap::Connect (pipe_wrap.cc:207-247) under request `id`; its callback is AfterConnect.
TABNODE_EXPORT(tabnode_pipe_connect) int tabnode_pipe_connect(tabnode_wrap_t *wrap, int32_t id, const char *name,
                                                              uint32_t length) {
  tabnode_req_t *req = tabnode_req_new(id, NULL);
  int err = uv_pipe_connect2(&req->uv.connect, &wrap->uv.pipe, name, length, UV_PIPE_NO_TRUNCATE,
                             tabnode_after_connect);
  if (err) tabnode_req_free(req);
  return err;
}

// PipeWrap::Fchmod (pipe_wrap.cc:170-177).
TABNODE_EXPORT(tabnode_pipe_chmod) int tabnode_pipe_chmod(tabnode_wrap_t *wrap, int mode) {
  return uv_pipe_chmod(&wrap->uv.pipe, mode);
}
