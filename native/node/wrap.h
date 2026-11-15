// A HANDLE THE REALM'S JAVASCRIPT OWNS (Tabnode ADR-0018 §3), as Node's HandleWrap owns its uv_handle_t
// (src/handle_wrap.h, Node v24.21.0): libuv's handle first, so a pointer to the wrap is one to the handle, then the
// number of the JavaScript object it belongs to, which each callback into the engine names, as Node's handle->data
// names its wrap. A request (uv_write_t, uv_shutdown_t, uv_connect_t, uv_udp_send_t) is a tabnode_req_t: libuv's
// request, the number of its JavaScript object (Node's ReqWrap), and the bytes it owns until it completes.
#ifndef TABNODE_WRAP_H
#define TABNODE_WRAP_H
#include <stdint.h>
#include <netinet/in.h>
#include <uv.h>
#include "engine.h"

#define TABNODE_EXPORT(name) __attribute__((export_name(#name)))

typedef struct {
  union {
    uv_handle_t handle;
    uv_stream_t stream;
    uv_tcp_t tcp;
    uv_pipe_t pipe;
    uv_tty_t tty;
    uv_udp_t udp;
  } uv;
  int32_t id;
  // CustomBufferJSListener's buffer (src/stream_base.cc:718-722): a stream given the program's own buffer
  // (`useUserBuffer`) reads at most its length; 0 reads libuv's suggested size, as Node's managed buffer does.
  uint32_t user_buffer;
} tabnode_wrap_t;

typedef struct {
  union {
    uv_req_t req;
    uv_write_t write;
    uv_shutdown_t shutdown;
    uv_connect_t connect;
    uv_udp_send_t send;
  } uv;
  int32_t id;
  // The bytes the request holds until its callback (WriteWrap::SetBackingStore, stream_base.cc:354, 435), freed then.
  char *bytes;
} tabnode_req_t;

// AddressToJS's fields (src/tcp_wrap.cc:619-690): `family` 4 or 6 (0 for another family, whose address is empty),
// the port, and the address as uv_inet_ntop writes it with a link-local address's interface after `%`. `error` is
// uv_if_indextoiid's failure, which Node throws (ThrowUVException(r, "uv_if_indextoiid")).
typedef struct {
  int32_t family;
  int32_t port;
  int32_t error;
  char address[INET6_ADDRSTRLEN + UV_IF_NAMESIZE];
} tabnode_address_t;

// A new wrap for JavaScript object `id` (HandleWrap's constructor, handle_wrap.cc:131-141); its handle is the
// binding's to initialize. Node's `new` aborts where memory is out; so does this.
tabnode_wrap_t *tabnode_wrap_new(int32_t id);
// HandleWrap::OnClose (handle_wrap.cc:144-166): the engine is told, its scope closes, and the wrap goes.
void tabnode_wrap_closed(uv_handle_t *handle);
// A request for JavaScript object `id` owning `bytes` (ReqWrap's constructor); aborts where memory is out.
tabnode_req_t *tabnode_req_new(int32_t id, char *bytes);
// The request's end: its bytes and itself freed (ReqWrap's destructor, with WriteWrap's backing store).
void tabnode_req_free(tabnode_req_t *req);
// ConnectionWrap::AfterConnect (connection_wrap.cc:75-112), a TCP and a pipe connect's callback (stream_wrap.c).
void tabnode_after_connect(uv_connect_t *connect, int status);
// AddressToJS (tcp_wrap.cc:619-690) into `out`.
void tabnode_address_of(const struct sockaddr *addr, tabnode_address_t *out);
// uv_ip4_addr or uv_ip6_addr for `family` 4 or 6 (udp_wrap.cc `sockaddr_for_family`, tcp_wrap.cc Bind and Connect).
int tabnode_ip_addr(int family, const char *ip, int port, struct sockaddr_storage *out);
#endif
