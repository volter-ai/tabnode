// THE ENGINE'S DESCRIPTOR WAITS (Tabnode ADR-0018 step 2): until each binding owns its libuv handle (steps 3 to 6:
// uv_tty_t, uv_pipe_t, uv_tcp_t, uv_udp_t, uv_process_t, uv_fs_event_t), a descriptor the engine waits on is a
// uv_poll_t of libuv's loop, one per descriptor, started for the union of what its waiters ask. Its readiness calls
// the engine (tabnode_poll_ready) and closes the callback's scope, as a binding's callback does.
#include <stdlib.h>
#include <uv.h>
#include "engine.h"

static uv_poll_t **polls;
static int poll_count;

static void poll_ready(uv_poll_t *handle, int status, int events) {
  uv_os_fd_t fd;
  uv_fileno((uv_handle_t *)handle, &fd);
  tabnode_poll_ready(fd, status, events);
  tabnode_drain();
}

static void poll_closed(uv_handle_t *handle) { free(handle); }

// The descriptor's wait for `events` (UV_READABLE, UV_WRITABLE, UV_DISCONNECT): 0, or libuv's error (UV_EPERM for a
// descriptor epoll refuses, a regular file's; UV_EBADF for one not open).
__attribute__((export_name("tabnode_poll_start"))) int tabnode_poll_start(int fd, int events) {
  if (fd < 0) return UV_EBADF;
  if (fd >= poll_count) {
    int count = fd + 64;
    uv_poll_t **grown = realloc(polls, count * sizeof *polls);
    if (!grown) return UV_ENOMEM;
    for (int i = poll_count; i < count; i++) grown[i] = NULL;
    polls = grown;
    poll_count = count;
  }
  uv_poll_t *handle = polls[fd];
  if (!handle) {
    handle = malloc(sizeof *handle);
    if (!handle) return UV_ENOMEM;
    int err = uv_poll_init(uv_default_loop(), handle, fd);
    if (err) { free(handle); return err; }
    polls[fd] = handle;
  }
  return uv_poll_start(handle, events, poll_ready);
}

// The descriptor is no longer waited on, or is about to be closed: its handle is closed first, as libuv requires.
__attribute__((export_name("tabnode_poll_stop"))) void tabnode_poll_stop(int fd) {
  if (fd < 0 || fd >= poll_count || !polls[fd]) return;
  uv_close((uv_handle_t *)polls[fd], poll_closed);
  polls[fd] = NULL;
}
