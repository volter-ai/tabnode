// PROCESSWRAP (Tabnode ADR-0018 §3, §6), Node's src/process_wrap.cc (Node v24.21.0) over uv_spawn: each Process owns
// its uv_process_t in the process's memory, and libuv's exit callback calls the handle's JavaScript (an import), then
// closes the callback's scope, as Node's OnExit and MakeCallback do. What Node's C++ decides from the call's values
// (each stdio type's uv_stdio_flags, the process flags, a cwd only when it is not empty) is decided here; the engine
// reads the JavaScript values into one record (process_spawn below), as V8's half of Node's call reads them.
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>
#include "bindings.h"
#include "engine.h"

// process_wrap.cc:57-62, the flags lib/internal/child_process.js passes.
enum {
  kProcessFlagDetached = 1 << 0,
  kProcessFlagWindowsHide = 1 << 1,
  kProcessFlagWindowsVerbatimArguments = 1 << 2,
};

// An options.stdio entry's `type`, as ParseStdioOptions (process_wrap.cc:133-191) compares it: "ignore", "pipe",
// "overlapped", "wrap", or any other, whose `fd` is inherited.
enum { kStdioIgnore, kStdioPipe, kStdioOverlapped, kStdioWrap, kStdioFd };

// One entry, as the engine lays it out (src/node-lib/binding/process_wrap.ts): its type, its `fd` (kStdioFd), and its
// handle's uv_stream_t (StreamForWrap, process_wrap.cc:118-131: LibuvStreamWrap::From(handle)->stream()).
struct process_stdio {
  int32_t type;
  int32_t fd;
  uv_stream_t *stream;
};

// Spawn's arguments (process_wrap.cc:193-342): file; args, cwd and envPairs (NULL where the value is not an array, not
// a string); stdio; flags; uid and gid where given.
struct process_spawn {
  const char *file;
  char **args;
  const char *cwd;
  char **env;
  struct process_stdio *stdio;
  uint32_t stdio_count;
  uint32_t flags;
  int32_t set_uid;
  int32_t uid;
  int32_t set_gid;
  int32_t gid;
};
_Static_assert(sizeof(struct process_stdio) == 12, "process_wrap.ts lays an entry out in 12 bytes");
_Static_assert(offsetof(struct process_spawn, gid) == 40 && sizeof(struct process_spawn) == 44,
  "process_wrap.ts lays the record out in 44 bytes");

// ProcessWrap::OnExit (process_wrap.cc:362-378).
static void on_exit(uv_process_t *handle, int64_t exit_status, int term_signal) {
  const char *signal = signo_string(term_signal);
  tabnode_process_exit(handle, (double)exit_status, signal, (uint32_t)strlen(signal));
  tabnode_drain();
}

// The handle's memory, made as the engine's Process is constructed, as Node's ProcessWrap holds its uv_process_t
// (process_wrap.cc:110-116, 380): zero, and uninitialized until Spawn.
__attribute__((export_name("tabnode_process_new"))) uv_process_t *tabnode_process_new(void) {
  return calloc(1, sizeof(uv_process_t));
}

// ProcessWrap::Spawn (process_wrap.cc:193-342), from `options.exit_cb` to uv_spawn on the process's loop; its answer is
// Spawn's. The engine marks its wrap initialized after it, as Spawn does whatever uv_spawn answers.
__attribute__((export_name("tabnode_process_spawn"))) int tabnode_process_spawn(uv_process_t *process,
  const struct process_spawn *spawn) {
  uv_process_options_t options;
  memset(&options, 0, sizeof options);
  options.exit_cb = on_exit;
  options.file = spawn->file;
  if (spawn->set_uid) {
    options.flags |= UV_PROCESS_SETUID;
    options.uid = (uv_uid_t)spawn->uid;
  }
  if (spawn->set_gid) {
    options.flags |= UV_PROCESS_SETGID;
    options.gid = (uv_gid_t)spawn->gid;
  }
  options.args = spawn->args;
  if (spawn->cwd != NULL && spawn->cwd[0] != '\0') options.cwd = spawn->cwd;
  options.env = spawn->env;
  uv_stdio_container_t *stdio = calloc(spawn->stdio_count ? spawn->stdio_count : 1, sizeof *stdio);
  if (stdio == NULL) abort();
  for (uint32_t i = 0; i < spawn->stdio_count; i++) {
    const struct process_stdio *entry = &spawn->stdio[i];
    switch (entry->type) {
    case kStdioIgnore:
      stdio[i].flags = UV_IGNORE;
      break;
    case kStdioPipe:
      stdio[i].flags = UV_CREATE_PIPE | UV_READABLE_PIPE | UV_WRITABLE_PIPE;
      break;
    case kStdioOverlapped:
      stdio[i].flags = UV_CREATE_PIPE | UV_READABLE_PIPE | UV_WRITABLE_PIPE | UV_OVERLAPPED_PIPE;
      break;
    case kStdioWrap:
      stdio[i].flags = UV_INHERIT_STREAM;
      break;
    default:
      stdio[i].flags = UV_INHERIT_FD;
      stdio[i].data.fd = entry->fd;
      continue;
    }
    if (stdio[i].flags != UV_IGNORE) {
      // StreamForWrap's CHECK_NOT_NULL(stream).
      if (entry->stream == NULL) abort();
      stdio[i].data.stream = entry->stream;
    }
  }
  options.stdio = stdio;
  options.stdio_count = (int)spawn->stdio_count;
  // UV_PROCESS_WINDOWS_HIDE_CONSOLE is the Environment's hide_console_windows, an embedder's flag on Windows.
  if (spawn->flags & kProcessFlagWindowsHide) options.flags |= UV_PROCESS_WINDOWS_HIDE;
  if (spawn->flags & kProcessFlagWindowsVerbatimArguments) options.flags |= UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS;
  if (spawn->flags & kProcessFlagDetached) options.flags |= UV_PROCESS_DETACHED;
  int err = uv_spawn(uv_default_loop(), process, &options);
  free(stdio);
  return err;
}

// The child's pid, which Spawn sets on the wrap's object where uv_spawn answered 0 (process_wrap.cc:330-339).
__attribute__((export_name("tabnode_process_pid"))) int tabnode_process_pid(const uv_process_t *process) {
  return process->pid;
}

// ProcessWrap::Kill (process_wrap.cc:344-360) on Linux.
__attribute__((export_name("tabnode_process_kill"))) int tabnode_process_kill(uv_process_t *process, int signal) {
  return uv_process_kill(process, signal);
}
