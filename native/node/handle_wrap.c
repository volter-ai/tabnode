// HANDLE_WRAP (Tabnode ADR-0018 §3): Node v24.21.0's src/handle_wrap.cc without V8, and what every binding's glue
// shares: the process memory the engine's bytes cross through, a wrap's close, its ref and its descriptor, and
// AddressToJS (src/tcp_wrap.cc:619-690). Where Node calls into V8 the glue calls the engine (engine.h); where Node's
// InternalCallbackScope closes (MakeCallback's return) it calls tabnode_drain. The JavaScript keeps a wrap's state
// (kInitialized, kClosing, kClosed) and its close callback, as Node's HandleWrap object does.
#include <stdlib.h>
#include <string.h>
#include "wrap.h"

tabnode_wrap_t *tabnode_wrap_new(int32_t id) {
  tabnode_wrap_t *wrap = calloc(1, sizeof *wrap);
  if (!wrap) abort();
  wrap->id = id;
  wrap->uv.handle.data = wrap;
  return wrap;
}

tabnode_req_t *tabnode_req_new(int32_t id, char *bytes) {
  tabnode_req_t *req = calloc(1, sizeof *req);
  if (!req) abort();
  req->id = id;
  req->bytes = bytes;
  req->uv.req.data = req;
  return req;
}

void tabnode_req_free(tabnode_req_t *req) {
  free(req->bytes);
  free(req);
}

void tabnode_wrap_closed(uv_handle_t *handle) {
  tabnode_wrap_t *wrap = handle->data;
  tabnode_handle_closed(wrap->id);
  tabnode_drain();
  free(wrap);
}

// The bytes the engine hands a call (a write's, a name's) live in the process's memory, as V8's backing stores live
// in Node's: the engine asks for room, writes into it, and the call or its request frees it.
TABNODE_EXPORT(tabnode_alloc) char *tabnode_alloc(uint32_t size) {
  char *bytes = malloc(size ? size : 1);
  if (!bytes) abort();
  return bytes;
}
TABNODE_EXPORT(tabnode_free) void tabnode_free(char *bytes) { free(bytes); }

// HandleWrap::Close (handle_wrap.cc:65-77): uv_close, its callback HandleWrap::OnClose.
TABNODE_EXPORT(tabnode_handle_close) void tabnode_handle_close(tabnode_wrap_t *wrap) {
  uv_close(&wrap->uv.handle, tabnode_wrap_closed);
}
// HandleWrap::Ref, Unref and HasRef (handle_wrap.cc:40-62); the JavaScript asks IsAlive first.
TABNODE_EXPORT(tabnode_handle_ref) void tabnode_handle_ref(tabnode_wrap_t *wrap) { uv_ref(&wrap->uv.handle); }
TABNODE_EXPORT(tabnode_handle_unref) void tabnode_handle_unref(tabnode_wrap_t *wrap) { uv_unref(&wrap->uv.handle); }
TABNODE_EXPORT(tabnode_handle_has_ref) int tabnode_handle_has_ref(tabnode_wrap_t *wrap) {
  return uv_has_ref(&wrap->uv.handle);
}
// uv_is_active: whether the handle holds its loop (with its ref), as libuv counts it (uv__has_active_handles).
TABNODE_EXPORT(tabnode_handle_is_active) int tabnode_handle_is_active(tabnode_wrap_t *wrap) {
  return uv_is_active(&wrap->uv.handle);
}
// LibuvStreamWrap::GetFD and UDPWrap::GetFD (stream_wrap.cc:153-163, udp_wrap.cc:291-299): uv_fileno, -1 or
// UV_EBADF where the handle has none.
TABNODE_EXPORT(tabnode_handle_fileno) int tabnode_handle_fileno(tabnode_wrap_t *wrap) {
  uv_os_fd_t fd;
  int err = uv_fileno(&wrap->uv.handle, &fd);
  return err ? err : fd;
}

// GetUVHandleTypeCode (src/node_util.cc:197-220): the index into internal/util's `handleTypes`.
static int handle_type_code(uv_handle_type type) {
  switch (type) {
    case UV_TCP: return 0;
    case UV_TTY: return 1;
    case UV_UDP: return 2;
    case UV_FILE: return 3;
    case UV_NAMED_PIPE: return 4;
    case UV_UNKNOWN_HANDLE: return 5;
    default: abort();
  }
}
// GuessHandleType (node_util.cc:222-231): uv_guess_handle of a descriptor, by its code.
TABNODE_EXPORT(tabnode_guess_handle) int tabnode_guess_handle(int fd) { return handle_type_code(uv_guess_handle(fd)); }
// uv_pipe_pending_type of an IPC pipe's next received handle (LibuvStreamWrap::OnUvRead, stream_wrap.cc:236-240), by
// the same code: TCP 0, UDP 2, a pipe 4, none 5.
TABNODE_EXPORT(tabnode_pipe_pending_type) int tabnode_pipe_pending_type(tabnode_wrap_t *wrap) {
  if (uv_pipe_pending_count(&wrap->uv.pipe) <= 0) return 5;
  return handle_type_code(uv_pipe_pending_type(&wrap->uv.pipe));
}

void tabnode_address_of(const struct sockaddr *addr, tabnode_address_t *out) {
  memset(out, 0, sizeof *out);
  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *a6 = (const struct sockaddr_in6 *)addr;
    uv_inet_ntop(AF_INET6, &a6->sin6_addr, out->address, sizeof out->address);
    // A link-local address carries its interface (tcp_wrap.cc:637-650).
    if (IN6_IS_ADDR_LINKLOCAL(&a6->sin6_addr) && a6->sin6_scope_id > 0) {
      size_t length = strlen(out->address);
      out->address[length] = '%';
      size_t room = sizeof out->address - length - 1;
      out->error = uv_if_indextoiid(a6->sin6_scope_id, out->address + length + 1, &room);
      if (out->error) return;
    }
    out->family = 6;
    out->port = ntohs(a6->sin6_port);
  } else if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *a4 = (const struct sockaddr_in *)addr;
    uv_inet_ntop(AF_INET, &a4->sin_addr, out->address, sizeof out->address);
    out->family = 4;
    out->port = ntohs(a4->sin_port);
  }
}

int tabnode_ip_addr(int family, const char *ip, int port, struct sockaddr_storage *out) {
  memset(out, 0, sizeof *out);
  if (family == 6) return uv_ip6_addr(ip, port, (struct sockaddr_in6 *)out);
  return uv_ip4_addr(ip, port, (struct sockaddr_in *)out);
}
