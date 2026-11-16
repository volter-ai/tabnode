// fs.watch and fs.watchFile's handles (Tabnode ADR-0018 §3, item 6): Node v24.21.0's FSEventWrap
// (src/fs_event_wrap.cc) over a uv_fs_event_t and StatWatcher (src/node_stat_watcher.cc) over a uv_fs_poll_t, each
// in the process's memory, each a HandleWrap (handle_wrap.c: close, ref, unref, hasRef, and OnClose, which frees it).
// libuv's callbacks call the engine, whose JavaScript makes the handle's MakeCallback, then close the callback's scope.
#include <stdlib.h>
#include "engine.h"
#include "fs.h"

#define EXPORT(name) __attribute__((export_name(#name)))

// FSEventWrap::OnEvent (fs_event_wrap.cc:183-235): the event's name as the wrap chooses it, empty with an error,
// "rename" where libuv says UV_RENAME (a rename with a change is a rename), else "change"; any other flag is Node's
// UNREACHABLE. The engine encodes the filename and makes the callback.
static void on_event(uv_fs_event_t *handle, const char *filename, int events, int status) {
  const char *event;
  if (status) event = "";
  else if (events & UV_RENAME) event = "rename";
  else if (events & UV_CHANGE) event = "change";
  else abort();
  tabnode_fs_event(handle, filename, event, status);
  tabnode_drain();
}

// The handle FSEventWrap embeds; uv_fs_event_init runs at its start, as Start makes it.
EXPORT(tabnode_fs_event_new) uv_fs_event_t *tabnode_fs_event_new(void) { return calloc(1, sizeof(uv_fs_event_t)); }
EXPORT(tabnode_fs_event_init) int tabnode_fs_event_init(uv_fs_event_t *handle) {
  return uv_fs_event_init(uv_default_loop(), handle);
}
// FSEventWrap::Start (fs_event_wrap.cc:139-181): UV_FS_EVENT_RECURSIVE where `recursive` is true, then
// uv_fs_event_start.
EXPORT(tabnode_fs_event_start) int tabnode_fs_event_start(uv_fs_event_t *handle, const char *path, int recursive) {
  unsigned int flags = 0;
  if (recursive) flags |= UV_FS_EVENT_RECURSIVE;
  return uv_fs_event_start(handle, on_event, path, flags);
}

// StatWatcher::Callback: the current stat into the binding's array at 0 and the previous one after it, then the
// engine's onchange.
static void on_poll(uv_fs_poll_t *handle, int status, const uv_stat_t *prev, const uv_stat_t *curr) {
  tabnode_fs_fill_stats(curr, 0);
  tabnode_fs_fill_stats(prev, 1);
  tabnode_stat_watcher_change(handle, status);
  tabnode_drain();
}

// StatWatcher's constructor: CHECK_EQ(0, uv_fs_poll_init(...)).
EXPORT(tabnode_stat_watcher_new) uv_fs_poll_t *tabnode_stat_watcher_new(void) {
  uv_fs_poll_t *handle = calloc(1, sizeof *handle);
  if (!handle || uv_fs_poll_init(uv_default_loop(), handle) != 0) abort();
  return handle;
}
EXPORT(tabnode_stat_watcher_start) int tabnode_stat_watcher_start(uv_fs_poll_t *handle, const char *path,
    unsigned int interval) {
  return uv_fs_poll_start(handle, on_poll, path, interval);
}
