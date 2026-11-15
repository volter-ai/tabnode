// UDP_WRAP (Tabnode ADR-0018 §3, item 4): Node v24.21.0's src/udp_wrap.cc without V8. The handle is a uv_udp_t of the
// process's loop; its deferred bind, its sends' queue, its receives and its options are libuv's (deps/uv's
// src/unix/udp.c). A received datagram and a send's completion call the engine (engine.h), then close the
// callback's scope.
#include <stdlib.h>
#include "wrap.h"

// UDPWrap's constructor (udp_wrap.cc:154-166): uv_udp_init cannot fail but for memory.
TABNODE_EXPORT(tabnode_udp_init) tabnode_wrap_t *tabnode_udp_init(void) {
  tabnode_wrap_t *wrap = tabnode_wrap_new();
  if (uv_udp_init(uv_default_loop(), &wrap->uv.udp)) abort();
  wrap->uv.handle.data = wrap;
  return wrap;
}

// UDPWrap::Open (udp_wrap.cc:378-387).
TABNODE_EXPORT(tabnode_udp_open) int tabnode_udp_open(tabnode_wrap_t *wrap, int fd) {
  return uv_udp_open(&wrap->uv.udp, fd);
}

// UDPWrap::DoBind (udp_wrap.cc:315-344); OnAfterBind is the JavaScript's.
TABNODE_EXPORT(tabnode_udp_bind) int tabnode_udp_bind(tabnode_wrap_t *wrap, int family, const char *ip, unsigned port,
                                                      unsigned flags) {
  struct sockaddr_storage addr;
  int err = tabnode_ip_addr(family, ip, (unsigned short)port, &addr);
  if (err == 0) err = uv_udp_bind(&wrap->uv.udp, (const struct sockaddr *)&addr, flags);
  return err;
}

// UDPWrap::DoConnect and Disconnect (udp_wrap.cc:347-375, 434-444).
TABNODE_EXPORT(tabnode_udp_connect) int tabnode_udp_connect(tabnode_wrap_t *wrap, int family, const char *ip,
                                                            unsigned port) {
  struct sockaddr_storage addr;
  int err = tabnode_ip_addr(family, ip, (unsigned short)port, &addr);
  if (err == 0) err = uv_udp_connect(&wrap->uv.udp, (const struct sockaddr *)&addr);
  return err;
}
TABNODE_EXPORT(tabnode_udp_disconnect) int tabnode_udp_disconnect(tabnode_wrap_t *wrap) {
  return uv_udp_connect(&wrap->uv.udp, NULL);
}

static void on_send(uv_udp_send_t *send, int status) {
  tabnode_req_t *req = send->data;
  tabnode_udp_sent(req->id, status);
  tabnode_drain();
  tabnode_req_free(req);
}

// UDPWrap::DoSend and Send (udp_wrap.cc:516-615): `bytes` (which the call owns) to `ip` and `port` of `family`, or on
// the connected socket where `family` is 0. Tried at once (uv_udp_try_send): taken whole it answers the size plus
// one, so the JavaScript tells a synchronous send of nothing from an asynchronous one; else uv_udp_send under request
// `id`, which owns the bytes until OnSendDone, answering 0; or an error.
TABNODE_EXPORT(tabnode_udp_send) int tabnode_udp_send(tabnode_wrap_t *wrap, int32_t id, char *bytes, uint32_t length,
                                                      int family, const char *ip, unsigned port) {
  if (uv_is_closing(&wrap->uv.handle)) {
    free(bytes);
    return UV_EBADF;
  }
  struct sockaddr_storage storage;
  const struct sockaddr *addr = NULL;
  if (family) {
    int err = tabnode_ip_addr(family, ip, (unsigned short)port, &storage);
    if (err) {
      free(bytes);
      return err;
    }
    addr = (const struct sockaddr *)&storage;
  }
  uv_buf_t buf = uv_buf_init(bytes, length);
  int err = uv_udp_try_send(&wrap->uv.udp, &buf, 1, addr);
  if (err == UV_ENOSYS || err == UV_EAGAIN) {
    err = 0;
  } else if (err >= 0) {
    // A datagram is taken whole or not at all.
    free(bytes);
    return (int)length + 1;
  }
  if (err == 0) {
    tabnode_req_t *req = tabnode_req_new(id, bytes);
    err = uv_udp_send(&req->uv.send, &wrap->uv.udp, &buf, 1, addr, on_send);
    if (err) tabnode_req_free(req);
    return err;
  }
  free(bytes);
  return err;
}

// UDPWrap::OnAlloc (udp_wrap.cc:689-699): Node's managed buffer of the suggested size.
static void on_alloc(uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf) {
  (void)handle;
  char *base = malloc(suggested_size);
  *buf = uv_buf_init(base, base ? suggested_size : 0);
}

// UDPWrap::OnRecv (udp_wrap.cc:701-778): nothing where libuv read nothing from no one; else the datagram (its
// address as AddressToJS makes it) or the error to `onmessage`.
static void on_recv(uv_udp_t *handle, ssize_t nread, const uv_buf_t *buf, const struct sockaddr *addr,
                    unsigned flags) {
  if (!(nread == 0 && addr == NULL)) {
    tabnode_address_t name;
    if (nread >= 0 && addr) tabnode_address_of(addr, &name);
    tabnode_udp_received(handle, (int32_t)nread, buf->base, nread >= 0 && addr ? &name : NULL, flags);
    tabnode_drain();
  }
  free(buf->base);
}

// UDPWrap::RecvStart and RecvStop (udp_wrap.cc:640-660): already receiving is success.
TABNODE_EXPORT(tabnode_udp_recv_start) int tabnode_udp_recv_start(tabnode_wrap_t *wrap) {
  if (uv_is_closing(&wrap->uv.handle)) return UV_EBADF;
  int err = uv_udp_recv_start(&wrap->uv.udp, on_alloc, on_recv);
  return err == UV_EALREADY ? 0 : err;
}
TABNODE_EXPORT(tabnode_udp_recv_stop) int tabnode_udp_recv_stop(tabnode_wrap_t *wrap) {
  if (uv_is_closing(&wrap->uv.handle)) return UV_EBADF;
  return uv_udp_recv_stop(&wrap->uv.udp);
}

// GetSockOrPeerName<UDPWrap, uv_udp_getsockname / uv_udp_getpeername> (src/node_internals.h:70-83) into `out`.
TABNODE_EXPORT(tabnode_udp_name) int tabnode_udp_name(tabnode_wrap_t *wrap, int peer, tabnode_address_t *out) {
  struct sockaddr_storage storage;
  int length = sizeof storage;
  int err = peer ? uv_udp_getpeername(&wrap->uv.udp, (struct sockaddr *)&storage, &length)
                 : uv_udp_getsockname(&wrap->uv.udp, (struct sockaddr *)&storage, &length);
  if (err == 0) tabnode_address_of((struct sockaddr *)&storage, out);
  return err;
}

// UDPWrap::SetMembership (udp_wrap.cc:463-486); `iface` NULL for none.
TABNODE_EXPORT(tabnode_udp_membership) int tabnode_udp_membership(tabnode_wrap_t *wrap, const char *address,
                                                                  const char *iface, int join) {
  return uv_udp_set_membership(&wrap->uv.udp, address, iface, join ? UV_JOIN_GROUP : UV_LEAVE_GROUP);
}
// UDPWrap::SetSourceMembership (udp_wrap.cc:497-523).
TABNODE_EXPORT(tabnode_udp_source_membership) int tabnode_udp_source_membership(tabnode_wrap_t *wrap,
                                                                                const char *source,
                                                                                const char *group,
                                                                                const char *iface, int join) {
  return uv_udp_set_source_membership(&wrap->uv.udp, group, iface, source, join ? UV_JOIN_GROUP : UV_LEAVE_GROUP);
}
// UDPWrap::SetMulticastInterface (udp_wrap.cc:446-461).
TABNODE_EXPORT(tabnode_udp_multicast_interface) int tabnode_udp_multicast_interface(tabnode_wrap_t *wrap,
                                                                                    const char *iface) {
  return uv_udp_set_multicast_interface(&wrap->uv.udp, iface);
}

// SetLibuvInt32 (udp_wrap.cc:58-73) of setMulticastTTL, setMulticastLoopback, setBroadcast and setTTL: `which` 0 to 3.
TABNODE_EXPORT(tabnode_udp_set_int) int tabnode_udp_set_int(tabnode_wrap_t *wrap, int which, int value) {
  switch (which) {
    case 0: return uv_udp_set_multicast_ttl(&wrap->uv.udp, value);
    case 1: return uv_udp_set_multicast_loop(&wrap->uv.udp, value);
    case 2: return uv_udp_set_broadcast(&wrap->uv.udp, value);
    case 3: return uv_udp_set_ttl(&wrap->uv.udp, value);
    default: return UV_EINVAL;
  }
}

// UDPWrap::BufferSize (udp_wrap.cc:399-427): uv_recv_buffer_size or uv_send_buffer_size, the size or an error.
TABNODE_EXPORT(tabnode_udp_buffer_size) int tabnode_udp_buffer_size(tabnode_wrap_t *wrap, int size, int is_recv) {
  int err = is_recv ? uv_recv_buffer_size(&wrap->uv.handle, &size) : uv_send_buffer_size(&wrap->uv.handle, &size);
  return err ? err : size;
}

// UDPWrap::GetSendQueueSize and GetSendQueueCount (udp_wrap.cc:790-806).
TABNODE_EXPORT(tabnode_udp_send_queue_size) double tabnode_udp_send_queue_size(tabnode_wrap_t *wrap) {
  return (double)uv_udp_get_send_queue_size(&wrap->uv.udp);
}
TABNODE_EXPORT(tabnode_udp_send_queue_count) double tabnode_udp_send_queue_count(tabnode_wrap_t *wrap) {
  return (double)uv_udp_get_send_queue_count(&wrap->uv.udp);
}
