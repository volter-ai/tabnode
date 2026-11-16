// THE ENGINE DEVICE AS THE crypto BINDING REACHES IT (Tabnode ADR-0018 §5, item 7; browser-substrate ADR-0236 hole 12):
// the process's session on /dev/engine, the machine's own WebCrypto (browser-substrate packages/wali/linux/arch/wasm/
// kernel/engine.c, host/machine.mjs engineCall). Its descriptor is the program's, as any device's: a call is one write
// of a request (its tag, its answer's room, its call), an answer one read (its tag, its status, its bytes), both laid
// out by the engine (src/node-lib/binding/engine_device.ts), which this file only moves. A synchronous call blocks in
// Linux on the descriptor (poll, then read), as a blocking read of any device waits; while an asynchronous call's answer
// is due the descriptor is a uv_poll_t of the loop, whose readiness is the engine's `engine_ready` import followed by a
// drain, as a binding's callback is (ADR-0018 §4), so the answer's callback runs in the poll phase.
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdlib.h>
#include <unistd.h>
#include <uv.h>

#include "engine.h"

#define ENGINE_EXPORT(name) __attribute__((export_name(#name)))

// The session's descriptor, nonblocking and closed at exec (as the substrate's own client opens it): >= 0, or -errno.
ENGINE_EXPORT(tabnode_engine_open) int tabnode_engine_open(void) {
  int fd = open("/dev/engine", O_RDWR | O_NONBLOCK | O_CLOEXEC);
  return fd < 0 ? -errno : fd;
}
// One request written: its length, or -errno (-EAGAIN while the device holds every tag).
ENGINE_EXPORT(tabnode_engine_write) int tabnode_engine_write(int fd, const void *at, size_t length) {
  ssize_t wrote = write(fd, at, length);
  return wrote < 0 ? -errno : (int)wrote;
}
// One answer read into `room` bytes at `at`: its length, or -errno (-EAGAIN where none waits).
ENGINE_EXPORT(tabnode_engine_read) int tabnode_engine_read(int fd, void *at, size_t room) {
  ssize_t got = read(fd, at, room);
  return got < 0 ? -errno : (int)got;
}
// A synchronous call's wait: blocks in the kernel until the descriptor is ready for `events` (POLLIN or POLLOUT).
// Answers poll's revents, or -errno.
ENGINE_EXPORT(tabnode_engine_wait) int tabnode_engine_wait(int fd, int events) {
  struct pollfd entry = {.fd = fd, .events = (short)events};
  for (;;) {
    int ready = poll(&entry, 1, -1);
    if (ready > 0) return entry.revents;
    if (ready < 0 && errno != EINTR) return -errno;
  }
}

static uv_poll_t *watcher;
static int watched = -1;

static void on_ready(uv_poll_t *handle, int status, int events) {
  (void)handle;
  (void)events;
  tabnode_engine_ready(status);
  tabnode_drain();
}

// The descriptor waited on in the loop while an answer is due (a referenced uv_poll_t, so the run lives while one is
// due, as a request in flight keeps libuv's loop alive): 0 or libuv's error.
ENGINE_EXPORT(tabnode_engine_watch) int tabnode_engine_watch(int fd) {
  if (watcher == NULL) {
    watcher = malloc(sizeof(*watcher));
    if (watcher == NULL) abort();
    int err = uv_poll_init(uv_default_loop(), watcher, fd);
    if (err != 0) {
      free(watcher);
      watcher = NULL;
      return err;
    }
    watched = fd;
  }
  if (watched != fd) abort();
  return uv_poll_start(watcher, UV_READABLE, on_ready);
}
// No answer is due: the descriptor is no wait of the loop's.
ENGINE_EXPORT(tabnode_engine_unwatch) void tabnode_engine_unwatch(void) {
  if (watcher != NULL) uv_poll_stop(watcher);
}
