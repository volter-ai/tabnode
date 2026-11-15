// TTY_WRAP (Tabnode ADR-0018 §3, item 3): Node v24.21.0's src/tty_wrap.cc without V8. The handle is a uv_tty_t of
// the process's loop on a terminal descriptor; its reopening of a pty's slave, its non-blocking mode, its window size
// and its modes are libuv's (deps/uv's src/unix/tty.c).
#include <stdlib.h>
#include "wrap.h"

// TTYWrap's constructor (tty_wrap.cc:155-167): the wrap, then uv_tty_init, whose error the JavaScript reports on its
// context (`uv_tty_init`) and frees the uninitialized wrap (MarkAsUninitialized).
TABNODE_EXPORT(tabnode_tty_new) tabnode_wrap_t *tabnode_tty_new(int32_t id) { return tabnode_wrap_new(id); }
TABNODE_EXPORT(tabnode_tty_init) int tabnode_tty_init(tabnode_wrap_t *wrap, int fd) {
  int err = uv_tty_init(uv_default_loop(), &wrap->uv.tty, fd, 0);
  wrap->uv.handle.data = wrap;
  return err;
}

// TTYWrap::GetWindowSize (tty_wrap.cc:96-118): the width and height into `out`.
TABNODE_EXPORT(tabnode_tty_get_winsize) int tabnode_tty_get_winsize(tabnode_wrap_t *wrap, int32_t *out) {
  int width, height;
  int err = uv_tty_get_winsize(&wrap->uv.tty, &width, &height);
  if (err == 0) {
    out[0] = width;
    out[1] = height;
  }
  return err;
}

// TTYWrap::SetRawMode (tty_wrap.cc:121-136).
TABNODE_EXPORT(tabnode_tty_set_mode) int tabnode_tty_set_mode(tabnode_wrap_t *wrap, int mode) {
  return uv_tty_set_mode(&wrap->uv.tty, (uv_tty_mode_t)mode);
}
