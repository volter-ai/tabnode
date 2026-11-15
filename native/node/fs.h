// THE fs BINDING'S C (Tabnode ADR-0018 §3, item 6): what Node's src/node_file.cc, node_dir.cc, fs_event_wrap.cc and
// node_stat_watcher.cc do below V8, over libuv's uv_fs_* (Node v24.21.0, libuv at a267f5688b). A request owns its uv_fs_t in
// the process's memory, as Node's FSReqBase owns its ReqWrap<uv_fs_t>; the engine's JavaScript (the binding's V8
// half) writes a request's arguments into the room after it and reads its answer from it.
#ifndef TABNODE_FS_H
#define TABNODE_FS_H
#include <stddef.h>
#include <stdint.h>
#include <uv.h>

// A request: its uv_fs_t first, so libuv's uv_fs_t* is the request, and what Node's FSReqBase keeps beside it.
typedef struct tabnode_fs_s {
  uv_fs_t req;
  // FSContinuationData (src/node_file.h), for a recursive mkdir: the paths still to make, and the first one made.
  char **paths;
  size_t npaths;
  size_t paths_room;
  char *first_path;
  int mode;
  int stashed;  // MKDirpAsync's `req->data`: the mkdir's error its stat answers for.
  // What a whole read of readFileUtf8 holds (its std::string, or its heap buffer).
  char *data;
  size_t data_length;
  // The bytes the engine wrote: paths, data, the lengths of a read's or a write's buffers.
  size_t room_size;
  char room[];
} tabnode_fs_t;

// An error a composite call decides (Node's ThrowUVException, ThrowErrnoException and THROW_ERR_*), which the
// engine's JavaScript makes into the object V8 would: its kind, its number, and its strings, empty for none.
enum { kTabnodeErrorNone, kTabnodeErrorUV, kTabnodeErrorErrno, kTabnodeErrorCode };
typedef struct {
  int32_t kind;
  int32_t errorno;
  char syscall[32];
  char code[48];
  char message[8192];
  char path[4096];
  char dest[4096];
} tabnode_fs_error_t;

extern tabnode_fs_error_t tabnode_fs_error;
void tabnode_fs_say_uv(int err, const char *syscall, const char *path, const char *dest);
void tabnode_fs_say_errno(int errorno, const char *syscall, const char *message, const char *path);
void tabnode_fs_say_code(const char *code, const char *message);
// FillStatsArray into the binding's arrays: the first stat's fields, or (second) the eighteen after them.
void tabnode_fs_fill_stats(const uv_stat_t *s, int second);
#endif
