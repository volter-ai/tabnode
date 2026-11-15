// SPAWN_SYNC (Tabnode ADR-0018 §3, §6): Node's SyncProcessRunner (src/spawn_sync.cc and spawn_sync.h, Node v24.21.0)
// in C, over a loop of its own, as Node's is: the child is uv_spawn'd on that loop, its pipes are uv_pipe_t's of it,
// its input is uv_write'n and shut down, its output read into 64 KiB buffers, its timeout a uv_timer_t, and uv_run
// runs the loop until the child has exited and every pipe closed; the calling thread blocks in that loop's epoll_wait,
// as Node's does. Each function names the one of Node's it carries. Where Node's C++ reads the options object, the
// engine has read it into one record (spawn_sync below), as V8's half of ParseOptions reads it, and answers what
// that half answers itself (UV_EINVAL for a value of the wrong kind) in the record's `error`; where Node's builds the
// result object, this builds one record (spawn_sync_result) the engine makes the object from.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <uv.h>
#include "bindings.h"

// One options.stdio entry (ParseStdioOption, spawn_sync.cc:1011-1073): its type, as ParseStdioOption compares it, and
// the type's name for the abort an unknown type is.
enum { kSyncStdioIgnore, kSyncStdioPipe, kSyncStdioInherit, kSyncStdioUnknown };
struct spawn_sync_stdio {
  int32_t type;
  int32_t readable;
  int32_t writable;
  char *input;
  uint32_t input_length;
  int32_t fd;
  const char *type_name;
};

// The options object's values, in ParseOptions' order (spawn_sync.cc:788-968). `error` is what ParseOptions answered
// for a value of the wrong kind, where it answered one: the fields after it, and the stdio entries from the one it
// was found in, are not read (stdio_count -1: the stdio array was not reached, or is not an array).
struct spawn_sync {
  int32_t error;
  const char *file;
  char **args;
  const char *cwd;
  char **env;
  int32_t set_uid;
  int32_t uid;
  int32_t set_gid;
  int32_t gid;
  uint32_t flags;
  int32_t set_kill_signal;
  int32_t kill_signal;
  double timeout;
  double max_buffer;
  int32_t stdio_count;
  uint32_t stdio_parsed;
  struct spawn_sync_stdio *stdio;
};
_Static_assert(sizeof(struct spawn_sync_stdio) == 28, "spawn_sync.ts lays an entry out in 28 bytes");
_Static_assert(offsetof(struct spawn_sync, timeout) == 48 && offsetof(struct spawn_sync, stdio) == 72 &&
  sizeof(struct spawn_sync) == 80, "spawn_sync.ts lays the record out in 80 bytes");
// The flags the engine reads from detached, windowsHide and windowsVerbatimArguments (spawn_sync.cc:886-918).
enum { kSyncDetached = 1 << 0, kSyncWindowsHide = 1 << 1, kSyncWindowsVerbatimArguments = 1 << 2 };

// BuildResultObject (spawn_sync.cc:692-763) and BuildOutputArray (765-786): `error` where GetError() is not 0; status
// and signal, each null or a value; output null, or one entry per stdio entry, each null or a pipe's bytes; pid.
struct spawn_sync_output {
  char *data;
  uint32_t length;
  int32_t is_null;
};
struct spawn_sync_result {
  int32_t error;
  int32_t status_is_null;
  double status;
  const char *signal;
  uint32_t signal_length;
  int32_t output_is_null;
  uint32_t output_count;
  struct spawn_sync_output *output;
  int32_t pid;
};
_Static_assert(offsetof(struct spawn_sync_result, pid) == 36 && sizeof(struct spawn_sync_result) == 40,
  "spawn_sync.ts reads the result in 40 bytes");
_Static_assert(sizeof(struct spawn_sync_output) == 12, "spawn_sync.ts reads an output in 12 bytes");

// SyncProcessOutputBuffer (spawn_sync.h:39-62).
enum { kBufferSize = 65536 };
struct output_buffer {
  char data[kBufferSize];
  unsigned int used;
  struct output_buffer *next;
};

struct runner;

// SyncProcessStdioPipe (spawn_sync.h:65-131).
enum { kPipeUninitialized, kPipeInitialized, kPipeStarted, kPipeClosing, kPipeClosed };
struct stdio_pipe {
  struct runner *runner;
  bool readable;
  bool writable;
  uv_buf_t input_buffer;
  struct output_buffer *first_output_buffer;
  struct output_buffer *last_output_buffer;
  uv_pipe_t uv_pipe;
  uv_write_t write_req;
  uv_shutdown_t shutdown_req;
  int lifecycle;
};

// SyncProcessRunner (spawn_sync.h:134-237).
enum { kUninitialized, kInitialized, kHandlesClosed };
struct runner {
  double max_buffer;
  uint64_t timeout;
  int kill_signal;
  uv_loop_t *uv_loop;
  uint32_t stdio_count;
  uv_stdio_container_t *uv_stdio_containers;
  struct stdio_pipe **stdio_pipes;
  bool stdio_pipes_initialized;
  uv_process_options_t uv_process_options;
  uv_process_t uv_process;
  bool killed;
  size_t buffered_output_size;
  int64_t exit_status;
  int term_signal;
  uv_timer_t uv_timer;
  bool kill_timer_initialized;
  int error;
  int pipe_error;
  int lifecycle;
};

static void runner_kill(struct runner *r);
static void close_stdio_pipes(struct runner *r);
static void close_kill_timer(struct runner *r);

// SetError, SetPipeError and GetError (spawn_sync.cc:673-690).
static void set_error(struct runner *r, int error) {
  if (r->error == 0) r->error = error;
}
static void set_pipe_error(struct runner *r, int pipe_error) {
  if (r->pipe_error == 0) r->pipe_error = pipe_error;
}
static int get_error(const struct runner *r) { return r->error != 0 ? r->error : r->pipe_error; }

// SyncProcessOutputBuffer::OnAlloc, OnRead and available (spawn_sync.cc:57-87).
static unsigned int buffer_available(const struct output_buffer *b) { return kBufferSize - b->used; }
static void buffer_alloc(struct output_buffer *b, uv_buf_t *buf) {
  if (b->used == kBufferSize) *buf = uv_buf_init(NULL, 0);
  else *buf = uv_buf_init(b->data + b->used, buffer_available(b));
}
static void buffer_read(struct output_buffer *b, const uv_buf_t *buf, size_t nread) {
  // If we hand out the same chunk twice, this should catch it.
  if (buf->base != b->data + b->used) abort();
  b->used += (unsigned int)nread;
}

// IncrementBufferSizeAndCheckOverflow (spawn_sync.cc:648-656).
static void increment_buffer_size_and_check_overflow(struct runner *r, ssize_t length) {
  r->buffered_output_size += length;
  if (r->max_buffer > 0 && r->buffered_output_size > r->max_buffer) {
    set_error(r, UV_ENOBUFS);
    runner_kill(r);
  }
}

// SyncProcessStdioPipe::SetError (spawn_sync.cc:315-319).
static void pipe_set_error(struct stdio_pipe *p, int error) {
  if (error == 0) abort();
  set_pipe_error(p->runner, error);
}

// SyncProcessStdioPipe::OnAlloc and AllocCallback (spawn_sync.cc:260-280, 321-328).
static void alloc_callback(uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf) {
  (void)suggested_size;
  struct stdio_pipe *p = handle->data;
  // This function assumes that libuv will never allocate two buffers for the same stream at the same time.
  if (p->last_output_buffer == NULL) {
    p->first_output_buffer = calloc(1, sizeof *p->first_output_buffer);
    if (p->first_output_buffer == NULL) abort();
    p->last_output_buffer = p->first_output_buffer;
  } else if (buffer_available(p->last_output_buffer) == 0) {
    struct output_buffer *next = calloc(1, sizeof *next);
    if (next == NULL) abort();
    p->last_output_buffer->next = next;
    p->last_output_buffer = next;
  }
  buffer_alloc(p->last_output_buffer, buf);
}

// SyncProcessStdioPipe::OnRead and ReadCallback (spawn_sync.cc:282-296, 330-337).
static void read_callback(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
  struct stdio_pipe *p = stream->data;
  if (nread == UV_EOF) {
    // Libuv implicitly stops reading on EOF.
  } else if (nread < 0) {
    pipe_set_error(p, (int)nread);
    // At some point libuv should really implicitly stop reading on error.
    uv_read_stop(stream);
  } else {
    buffer_read(p->last_output_buffer, buf, (size_t)nread);
    increment_buffer_size_and_check_overflow(p->runner, nread);
  }
}

// SyncProcessStdioPipe::OnWriteDone and WriteCallback (spawn_sync.cc:298-302, 339-344).
static void write_callback(uv_write_t *req, int result) {
  struct stdio_pipe *p = req->handle->data;
  if (result < 0) pipe_set_error(p, result);
}

// SyncProcessStdioPipe::OnShutdownDone and ShutdownCallback (spawn_sync.cc:304-308, 346-359).
static void shutdown_callback(uv_shutdown_t *req, int result) {
  struct stdio_pipe *p = req->handle->data;
  // On AIX, OS X and the BSDs, calling shutdown() on one end of a pipe when the other end has closed the connection
  // fails with ENOTCONN. Libuv is not the right place to handle that because it can't tell if the error is genuine
  // but we here can.
  if (result == UV_ENOTCONN) result = 0;
  if (result < 0) pipe_set_error(p, result);
}

// SyncProcessStdioPipe::OnClose and CloseCallback (spawn_sync.cc:310-313, 361-366).
static void pipe_close_callback(uv_handle_t *handle) {
  struct stdio_pipe *p = handle->data;
  p->lifecycle = kPipeClosed;
}

// SyncProcessStdioPipe::Start (spawn_sync.cc:147-180).
static int pipe_start(struct stdio_pipe *p) {
  if (p->lifecycle != kPipeInitialized) abort();
  // Set the busy flag already. If this function fails no recovery is possible.
  p->lifecycle = kPipeStarted;
  uv_stream_t *stream = (uv_stream_t *)&p->uv_pipe;
  if (p->readable) {
    if (p->input_buffer.len > 0) {
      if (p->input_buffer.base == NULL) abort();
      int r = uv_write(&p->write_req, stream, &p->input_buffer, 1, write_callback);
      if (r < 0) return r;
    }
    int r = uv_shutdown(&p->shutdown_req, stream, shutdown_callback);
    if (r < 0) return r;
  }
  if (p->writable) {
    int r = uv_read_start(stream, alloc_callback, read_callback);
    if (r < 0) return r;
  }
  return 0;
}

// SyncProcessStdioPipe::Close (spawn_sync.cc:182-188).
static void pipe_close(struct stdio_pipe *p) {
  if (p->lifecycle != kPipeInitialized && p->lifecycle != kPipeStarted) abort();
  uv_close((uv_handle_t *)&p->uv_pipe, pipe_close_callback);
  p->lifecycle = kPipeClosing;
}

// ~SyncProcessStdioPipe (spawn_sync.cc:120-131).
static void pipe_delete(struct stdio_pipe *p) {
  if (p->lifecycle != kPipeUninitialized && p->lifecycle != kPipeClosed) abort();
  struct output_buffer *next;
  for (struct output_buffer *b = p->first_output_buffer; b != NULL; b = next) {
    next = b->next;
    free(b);
  }
  free(p);
}

// CloseStdioPipes (spawn_sync.cc:581-596).
static void close_stdio_pipes(struct runner *r) {
  if (r->lifecycle >= kHandlesClosed) abort();
  if (r->stdio_pipes_initialized) {
    if (r->stdio_count == 0 || r->uv_loop == NULL) abort();
    for (uint32_t i = 0; i < r->stdio_count; i++)
      if (r->stdio_pipes[i]) pipe_close(r->stdio_pipes[i]);
    r->stdio_pipes_initialized = false;
  }
}

static void kill_timer_close_callback(uv_handle_t *handle) { (void)handle; }

// CloseKillTimer (spawn_sync.cc:598-612).
static void close_kill_timer(struct runner *r) {
  if (r->lifecycle >= kHandlesClosed) abort();
  if (r->kill_timer_initialized) {
    if (r->timeout == 0 || r->uv_loop == NULL) abort();
    uv_handle_t *uv_timer_handle = (uv_handle_t *)&r->uv_timer;
    uv_ref(uv_timer_handle);
    uv_close(uv_timer_handle, kill_timer_close_callback);
    r->kill_timer_initialized = false;
  }
}

// Kill (spawn_sync.cc:614-646).
static void runner_kill(struct runner *r) {
  // Only attempt to kill once.
  if (r->killed) return;
  r->killed = true;
  // We might get here even if the process we spawned has already exited. This could happen when our child process
  // spawned another process which inherited (one of) the stdio pipes. In this case we won't attempt to send a signal
  // to the process, however we will still close our end of the stdio pipes so this situation won't make us hang.
  if (r->exit_status < 0) {
    int err = uv_process_kill(&r->uv_process, r->kill_signal);
    // If uv_kill failed with an error that isn't ESRCH, the user probably specified an invalid or unsupported signal.
    // Signal this to the user as and error and kill the process with SIGKILL instead.
    if (err < 0 && err != UV_ESRCH) {
      set_error(r, err);
      // Deliberately ignore the return value, we might not have sufficient privileges to signal the child process.
      (void)uv_process_kill(&r->uv_process, SIGKILL);
    }
  }
  // Close all stdio pipes.
  close_stdio_pipes(r);
  // Stop the timeout timer immediately.
  close_kill_timer(r);
}

// OnExit and ExitCallback (spawn_sync.cc:658-665, 1217-1224).
static void exit_callback(uv_process_t *handle, int64_t exit_status, int term_signal) {
  struct runner *r = handle->data;
  uv_close((uv_handle_t *)handle, NULL);
  if (exit_status < 0) {
    set_error(r, (int)exit_status);
    return;
  }
  r->exit_status = exit_status;
  r->term_signal = term_signal;
}

// OnKillTimerTimeout and KillTimerCallback (spawn_sync.cc:667-671, 1226-1230).
static void kill_timer_callback(uv_timer_t *handle) {
  struct runner *r = handle->data;
  set_error(r, UV_ETIMEDOUT);
  runner_kill(r);
}

// AddStdioPipe (spawn_sync.cc:1085-1108), with SyncProcessStdioPipe's constructor and Initialize (99-118, 133-145).
static int add_stdio_pipe(struct runner *r, uint32_t child_fd, bool readable, bool writable, uv_buf_t input_buffer) {
  if (child_fd >= r->stdio_count || r->stdio_pipes[child_fd]) abort();
  if (!readable && !writable) abort();
  struct stdio_pipe *p = calloc(1, sizeof *p);
  if (p == NULL) abort();
  p->runner = r;
  p->readable = readable;
  p->writable = writable;
  p->input_buffer = input_buffer;
  int err = uv_pipe_init(r->uv_loop, &p->uv_pipe, 0);
  if (err < 0) {
    pipe_delete(p);
    return err;
  }
  p->uv_pipe.data = p;
  p->lifecycle = kPipeInitialized;
  r->uv_stdio_containers[child_fd].flags =
    UV_CREATE_PIPE | (readable ? UV_READABLE_PIPE : 0) | (writable ? UV_WRITABLE_PIPE : 0);
  r->uv_stdio_containers[child_fd].data.stream = (uv_stream_t *)&p->uv_pipe;
  r->stdio_pipes[child_fd] = p;
  return 0;
}

// ParseStdioOption (spawn_sync.cc:1011-1073), with AddStdioIgnore and AddStdioInheritFD (1075-1118).
static int parse_stdio_option(struct runner *r, uint32_t child_fd, const struct spawn_sync_stdio *option) {
  switch (option->type) {
  case kSyncStdioIgnore:
    if (child_fd >= r->stdio_count || r->stdio_pipes[child_fd]) abort();
    r->uv_stdio_containers[child_fd].flags = UV_IGNORE;
    return 0;
  case kSyncStdioPipe:
    return add_stdio_pipe(r, child_fd, option->readable, option->writable,
      option->readable && option->input != NULL ? uv_buf_init(option->input, option->input_length) : uv_buf_init(NULL, 0));
  case kSyncStdioInherit:
    if (child_fd >= r->stdio_count || r->stdio_pipes[child_fd]) abort();
    r->uv_stdio_containers[child_fd].flags = UV_INHERIT_FD;
    r->uv_stdio_containers[child_fd].data.fd = option->fd;
    return 0;
  default:
    fprintf(stderr, "invalid child stdio type: %s\n", option->type_name);
    abort();
  }
}

// ParseOptions and ParseStdioOptions (spawn_sync.cc:788-1009), over the values the engine read.
static int parse_options(struct runner *r, const struct spawn_sync *options) {
  r->uv_process_options.file = options->file;
  r->uv_process_options.args = options->args;
  r->uv_process_options.cwd = options->cwd;
  r->uv_process_options.env = options->env;
  if (options->set_uid) {
    r->uv_process_options.uid = (uv_uid_t)options->uid;
    r->uv_process_options.flags |= UV_PROCESS_SETUID;
  }
  if (options->set_gid) {
    r->uv_process_options.gid = (uv_gid_t)options->gid;
    r->uv_process_options.flags |= UV_PROCESS_SETGID;
  }
  if (options->flags & kSyncDetached) r->uv_process_options.flags |= UV_PROCESS_DETACHED;
  if (options->flags & kSyncWindowsHide) r->uv_process_options.flags |= UV_PROCESS_WINDOWS_HIDE;
  // UV_PROCESS_WINDOWS_HIDE_CONSOLE is the Environment's hide_console_windows, an embedder's flag on Windows.
  if (options->flags & kSyncWindowsVerbatimArguments)
    r->uv_process_options.flags |= UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS;
  r->timeout = (uint64_t)(int64_t)options->timeout;
  r->max_buffer = options->max_buffer;
  if (options->set_kill_signal) r->kill_signal = options->kill_signal;
  if (options->stdio_count >= 0) {
    r->stdio_count = (uint32_t)options->stdio_count;
    r->uv_stdio_containers = calloc(r->stdio_count ? r->stdio_count : 1, sizeof *r->uv_stdio_containers);
    r->stdio_pipes = calloc(r->stdio_count ? r->stdio_count : 1, sizeof *r->stdio_pipes);
    if (r->uv_stdio_containers == NULL || r->stdio_pipes == NULL) abort();
    r->stdio_pipes_initialized = true;
    for (uint32_t i = 0; i < options->stdio_parsed; i++) {
      int err = parse_stdio_option(r, i, &options->stdio[i]);
      if (err < 0) return err;
    }
  }
  if (options->error < 0) return options->error;
  r->uv_process_options.stdio = r->uv_stdio_containers;
  r->uv_process_options.stdio_count = (int)r->stdio_count;
  return 0;
}

// TryInitializeAndRunLoop (spawn_sync.cc:464-542).
static void try_initialize_and_run_loop(struct runner *r, const struct spawn_sync *options) {
  int err;
  // There is no recovery from failure inside TryInitializeAndRunLoop - the only option we'd have is to close all
  // handles and destroy the loop.
  if (r->lifecycle != kUninitialized) abort();
  r->lifecycle = kInitialized;
  r->uv_loop = malloc(sizeof *r->uv_loop);
  if (r->uv_loop == NULL) {
    set_error(r, UV_ENOMEM);
    return;
  }
  err = uv_loop_init(r->uv_loop);
  if (err < 0) {
    free(r->uv_loop);
    r->uv_loop = NULL;
    set_error(r, err);
    return;
  }
  err = parse_options(r, options);
  if (err < 0) {
    set_error(r, err);
    return;
  }
  if (r->timeout > 0) {
    err = uv_timer_init(r->uv_loop, &r->uv_timer);
    if (err < 0) {
      set_error(r, err);
      return;
    }
    uv_unref((uv_handle_t *)&r->uv_timer);
    r->uv_timer.data = r;
    r->kill_timer_initialized = true;
    // Start the timer immediately. If uv_spawn fails then CloseHandlesAndDeleteLoop() will immediately close the
    // timer handle which implicitly stops it, so there is no risk that the timeout callback runs when the process
    // didn't start.
    err = uv_timer_start(&r->uv_timer, kill_timer_callback, r->timeout, 0);
    if (err < 0) {
      set_error(r, err);
      return;
    }
  }
  r->uv_process_options.exit_cb = exit_callback;
  err = uv_spawn(r->uv_loop, &r->uv_process, &r->uv_process_options);
  if (err < 0) {
    set_error(r, err);
    return;
  }
  r->uv_process.data = r;
  for (uint32_t i = 0; i < r->stdio_count; i++) {
    if (r->stdio_pipes[i] != NULL) {
      err = pipe_start(r->stdio_pipes[i]);
      if (err < 0) {
        set_pipe_error(r, err);
        return;
      }
    }
  }
  // We can't handle uv_run failure.
  if (uv_run(r->uv_loop, UV_RUN_DEFAULT) < 0) abort();
  // If we get here the process should have exited.
  if (r->exit_status < 0) abort();
}

// CloseHandlesAndDeleteLoop (spawn_sync.cc:544-579), with CheckedUvLoopClose (src/debug_utils.cc:346-354).
static void close_handles_and_delete_loop(struct runner *r) {
  if (r->lifecycle >= kHandlesClosed) abort();
  if (r->uv_loop != NULL) {
    close_stdio_pipes(r);
    close_kill_timer(r);
    // Close the process handle when ExitCallback was not called.
    uv_handle_t *uv_process_handle = (uv_handle_t *)&r->uv_process;
    // Close the process handle if it is still open. The handle type also needs to be checked because
    // TryInitializeAndRunLoop() won't spawn a process if input validation fails.
    if (uv_process_handle->type == UV_PROCESS && !uv_is_closing(uv_process_handle)) uv_close(uv_process_handle, NULL);
    // Give closing watchers a chance to finish closing and get their close callbacks called.
    if (uv_run(r->uv_loop, UV_RUN_DEFAULT) < 0) abort();
    if (uv_loop_close(r->uv_loop) != 0) {
      fprintf(stderr, "uv_loop_close() while having open handles\n");
      fflush(stderr);
      abort();
    }
    free(r->uv_loop);
    r->uv_loop = NULL;
  } else {
    // If the loop doesn't exist, neither should any pipes or timers.
    if (r->stdio_pipes_initialized || r->kill_timer_initialized) abort();
  }
  r->lifecycle = kHandlesClosed;
}

// BuildResultObject and BuildOutputArray (spawn_sync.cc:692-786), with SyncProcessStdioPipe::GetOutputAsBuffer,
// OutputLength and CopyOutput (190-199, 240-258).
static struct spawn_sync_result *build_result(const struct runner *r) {
  struct spawn_sync_result *result = calloc(1, sizeof *result);
  if (result == NULL) abort();
  result->error = get_error(r);
  result->status_is_null = !(r->exit_status >= 0 && r->term_signal <= 0);
  if (!result->status_is_null) result->status = (double)r->exit_status;
  if (r->term_signal > 0) {
    result->signal = signo_string(r->term_signal);
    result->signal_length = (uint32_t)strlen(result->signal);
  }
  result->output_is_null = !(r->exit_status >= 0);
  if (!result->output_is_null) {
    if (r->lifecycle < kInitialized || r->stdio_count == 0) abort();
    result->output_count = r->stdio_count;
    result->output = calloc(r->stdio_count, sizeof *result->output);
    if (result->output == NULL) abort();
    for (uint32_t i = 0; i < r->stdio_count; i++) {
      const struct stdio_pipe *p = r->stdio_pipes[i];
      struct spawn_sync_output *out = &result->output[i];
      if (p == NULL || !p->writable) {
        out->is_null = 1;
        continue;
      }
      size_t length = 0;
      for (const struct output_buffer *b = p->first_output_buffer; b != NULL; b = b->next) length += b->used;
      out->length = (uint32_t)length;
      if (length == 0) continue;
      out->data = malloc(length);
      if (out->data == NULL) abort();
      size_t offset = 0;
      for (const struct output_buffer *b = p->first_output_buffer; b != NULL; b = b->next) {
        memcpy(out->data + offset, b->data, b->used);
        offset += b->used;
      }
    }
  }
  result->pid = r->uv_process.pid;
  return result;
}

// SyncProcessRunner::Spawn and Run (spawn_sync.cc:380-462), from the runner's constructor (407-434) to the result; the
// runner's destructor (~SyncProcessRunner, 436-441) frees its pipes.
__attribute__((export_name("tabnode_spawn_sync"))) struct spawn_sync_result *tabnode_spawn_sync(
  const struct spawn_sync *options) {
  struct runner r;
  memset(&r, 0, sizeof r);
  r.kill_signal = SIGTERM;
  r.exit_status = -1;
  r.term_signal = -1;
  r.lifecycle = kUninitialized;
  try_initialize_and_run_loop(&r, options);
  close_handles_and_delete_loop(&r);
  struct spawn_sync_result *result = build_result(&r);
  for (uint32_t i = 0; i < r.stdio_count; i++)
    if (r.stdio_pipes[i]) pipe_delete(r.stdio_pipes[i]);
  free(r.stdio_pipes);
  free(r.uv_stdio_containers);
  return result;
}

// The result's memory, once the engine has made its object from it.
__attribute__((export_name("tabnode_spawn_sync_free"))) void tabnode_spawn_sync_free(struct spawn_sync_result *result) {
  for (uint32_t i = 0; i < result->output_count; i++) free(result->output[i].data);
  free(result->output);
  free(result);
}
