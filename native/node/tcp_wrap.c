// TCP_WRAP (Tabnode ADR-0018 §3, item 4): Node v24.21.0's src/tcp_wrap.cc without V8. The handle is a uv_tcp_t of
// the process's loop; its socket, its options, its bind's held error and its connect are libuv's (deps/uv's
// src/unix/tcp.c). Addresses arrive as Node's binding takes them, an address's text and a port, and are parsed by
// uv_ip4_addr and uv_ip6_addr here, as TCPWrap::Bind and Connect parse them.
#include <errno.h>
#include <stdlib.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include "wrap.h"

// TCPWrap's constructor (tcp_wrap.cc:187-192): uv_tcp_init cannot fail but for memory.
TABNODE_EXPORT(tabnode_tcp_init) tabnode_wrap_t *tabnode_tcp_init(int32_t id) {
  tabnode_wrap_t *wrap = tabnode_wrap_new(id);
  if (uv_tcp_init(uv_default_loop(), &wrap->uv.tcp)) abort();
  wrap->uv.handle.data = wrap;
  return wrap;
}

// TCPWrap::Open (tcp_wrap.cc:375-387).
TABNODE_EXPORT(tabnode_tcp_open) int tabnode_tcp_open(tabnode_wrap_t *wrap, int fd) {
  return uv_tcp_open(&wrap->uv.tcp, fd);
}

// TCPWrap::Bind and Bind6 (tcp_wrap.cc:500-534): an IPv4 socket takes no UV_TCP_IPV6ONLY.
TABNODE_EXPORT(tabnode_tcp_bind) int tabnode_tcp_bind(tabnode_wrap_t *wrap, int family, const char *ip, int port,
                                                      unsigned flags) {
  if (family == 4) flags &= ~UV_TCP_IPV6ONLY;
  struct sockaddr_storage addr;
  int err = tabnode_ip_addr(family, ip, port, &addr);
  if (err == 0) err = uv_tcp_bind(&wrap->uv.tcp, (const struct sockaddr *)&addr, flags);
  return err;
}

// TCPWrap::Connect and Connect6 (tcp_wrap.cc:549-600) under request `id`; its callback is AfterConnect.
TABNODE_EXPORT(tabnode_tcp_connect) int tabnode_tcp_connect(tabnode_wrap_t *wrap, int32_t id, int family,
                                                            const char *ip, int port) {
  struct sockaddr_storage addr;
  int err = tabnode_ip_addr(family, ip, port, &addr);
  if (err) return err;
  tabnode_req_t *req = tabnode_req_new(id, NULL);
  err = uv_tcp_connect(&req->uv.connect, &wrap->uv.tcp, (const struct sockaddr *)&addr, tabnode_after_connect);
  if (err) tabnode_req_free(req);
  return err;
}

// GetSockOrPeerName<TCPWrap, uv_tcp_getsockname / uv_tcp_getpeername> (src/node_internals.h:70-83) into `out`.
TABNODE_EXPORT(tabnode_tcp_name) int tabnode_tcp_name(tabnode_wrap_t *wrap, int peer, tabnode_address_t *out) {
  struct sockaddr_storage storage;
  int length = sizeof storage;
  int err = peer ? uv_tcp_getpeername(&wrap->uv.tcp, (struct sockaddr *)&storage, &length)
                 : uv_tcp_getsockname(&wrap->uv.tcp, (struct sockaddr *)&storage, &length);
  if (err == 0) tabnode_address_of((struct sockaddr *)&storage, out);
  return err;
}

// TCPWrap::SetNoDelay and SetKeepAlive (tcp_wrap.cc:194-221).
TABNODE_EXPORT(tabnode_tcp_nodelay) int tabnode_tcp_nodelay(tabnode_wrap_t *wrap, int enable) {
  return uv_tcp_nodelay(&wrap->uv.tcp, enable);
}
TABNODE_EXPORT(tabnode_tcp_keepalive) int tabnode_tcp_keepalive(tabnode_wrap_t *wrap, int enable, unsigned delay,
                                                                unsigned interval, unsigned count) {
  return uv_tcp_keepalive_ex(&wrap->uv.tcp, enable, delay, interval, count);
}

// The option a socket's type of service is (tcp_wrap.cc:228-275): IP_TOS of an IPv4 socket, IPV6_TCLASS of an IPv6
// one, read by its name's family; another family is UV_EINVAL.
static int tos_option(tabnode_wrap_t *wrap, uv_os_fd_t *fd, int *level, int *option) {
  int err = uv_fileno(&wrap->uv.handle, fd);
  if (err) return err;
  struct sockaddr_storage storage;
  int length = sizeof storage;
  err = uv_tcp_getsockname(&wrap->uv.tcp, (struct sockaddr *)&storage, &length);
  if (err) return err;
  if (storage.ss_family == AF_INET) { *level = IPPROTO_IP; *option = IP_TOS; return 0; }
  if (storage.ss_family == AF_INET6) { *level = IPPROTO_IPV6; *option = IPV6_TCLASS; return 0; }
  return UV_EINVAL;
}
// TCPWrap::SetTypeOfService and GetTypeOfService (tcp_wrap.cc:222-360).
TABNODE_EXPORT(tabnode_tcp_set_tos) int tabnode_tcp_set_tos(tabnode_wrap_t *wrap, int tos) {
  uv_os_fd_t fd;
  int level, option;
  int err = tos_option(wrap, &fd, &level, &option);
  if (err) return err;
  return setsockopt(fd, level, option, &tos, sizeof tos) == 0 ? 0 : uv_translate_sys_error(errno);
}
TABNODE_EXPORT(tabnode_tcp_get_tos) int tabnode_tcp_get_tos(tabnode_wrap_t *wrap) {
  uv_os_fd_t fd;
  int level, option;
  int err = tos_option(wrap, &fd, &level, &option);
  if (err) return err;
  int tos = 0;
  socklen_t length = sizeof tos;
  return getsockopt(fd, level, option, &tos, &length) == 0 ? tos : uv_translate_sys_error(errno);
}

// TCPWrap::Reset (tcp_wrap.cc:602-617): uv_tcp_close_reset, whose callback is HandleWrap::OnClose.
TABNODE_EXPORT(tabnode_tcp_reset) int tabnode_tcp_reset(tabnode_wrap_t *wrap) {
  return uv_tcp_close_reset(&wrap->uv.tcp, tabnode_wrap_closed);
}
