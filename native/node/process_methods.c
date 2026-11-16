// internalBinding('process_methods') without V8 (Tabnode ADR-0018 §7): Node v24.21.0's src/node_process_methods.cc
// split where V8 stands. What its C++ asks libuv or libc is asked here, in the program; the engine's half
// (src/node-lib/binding/process_methods.ts) reads the arguments as FunctionCallbackInfo reads them and throws what
// Node throws.
#include <stdlib.h>
#include <sys/stat.h>
#include <uv.h>
#include "wrap.h"

// per_process::node_start_time (src/node.cc InitializeOncePerProcessInternal: uv_hrtime() at the start), which
// Uptime measures from: taken when the program's constructors run, before main.
static uint64_t start_time;
__attribute__((constructor)) static void record_start_time(void) { start_time = uv_hrtime(); }

// Kill (185-209): uv_kill of the pid and the signal V8's Int32Value gave, its answer libuv's. Where the signal is
// likely to end the process itself (a positive signal to its pid, its group or every process, with no started Signal
// on it), Node first runs the Environment's at-exit callbacks (RunAtExit, 198-205); Node's only callers of AtExit are
// its inspector agent and its profiler (inspector_agent.cc:879, inspector_profiler.cc:491), which the engine has
// neither of, so the process has none to run and the condition decides nothing.
TABNODE_EXPORT(tabnode_kill) int tabnode_kill(int pid, int sig) { return uv_kill(pid, sig); }

// HrtimeImpl and HrtimeBigIntImpl (701-716): uv_hrtime(), which the engine's half writes into hrtimeBuffer.
TABNODE_EXPORT(tabnode_hrtime) uint64_t tabnode_hrtime(void) { return uv_hrtime(); }

// Uptime (289-297): seconds since the start, uv_hrtime's.
TABNODE_EXPORT(tabnode_uptime) double tabnode_uptime(void) { return (double)(uv_hrtime() - start_time) / 1e9; }

// Cwd (160-181): uv_cwd into `size` bytes at `buffer` (PATH_MAX_BYTES, 4096); the path's length, or libuv's error.
TABNODE_EXPORT(tabnode_cwd) int tabnode_cwd(char *buffer, int size) {
  size_t length = (size_t)size;
  int err = uv_cwd(buffer, &length);
  return err ? err : (int)length;
}

// Chdir (83-101): uv_chdir of the path's Utf8Value; libuv's error, or 0.
TABNODE_EXPORT(tabnode_chdir) int tabnode_chdir(const char *path) { return uv_chdir(path); }

// Umask (270-287): with no mask, umask(0) and the old mask set back; with one, umask(mask). The old mask.
TABNODE_EXPORT(tabnode_umask) uint32_t tabnode_umask(int has_mask, uint32_t mask) {
  if (has_mask) return (uint32_t)umask((mode_t)mask);
  mode_t old = umask(0);
  umask(old);
  return (uint32_t)old;
}

static double micros(uv_timeval_t time) { return 1e6 * (double)time.tv_sec + (double)time.tv_usec; }

// CPUUsage (119-133) and ThreadCPUUsage (135-149): uv_getrusage's or uv_getrusage_thread's user and system times in
// microseconds, into the two doubles at `fields`; libuv's error, or 0.
TABNODE_EXPORT(tabnode_cpu_usage) int tabnode_cpu_usage(double *fields, int thread) {
  uv_rusage_t rusage;
  int err = thread ? uv_getrusage_thread(&rusage) : uv_getrusage(&rusage);
  if (err) return err;
  fields[0] = micros(rusage.ru_utime);
  fields[1] = micros(rusage.ru_stime);
  return 0;
}

// ResourceUsage (365-393): uv_getrusage's sixteen fields in Node's order, into the doubles at `fields`.
TABNODE_EXPORT(tabnode_resource_usage) int tabnode_resource_usage(double *fields) {
  uv_rusage_t rusage;
  int err = uv_getrusage(&rusage);
  if (err) return err;
  fields[0] = micros(rusage.ru_utime);
  fields[1] = micros(rusage.ru_stime);
  fields[2] = (double)rusage.ru_maxrss;
  fields[3] = (double)rusage.ru_ixrss;
  fields[4] = (double)rusage.ru_idrss;
  fields[5] = (double)rusage.ru_isrss;
  fields[6] = (double)rusage.ru_minflt;
  fields[7] = (double)rusage.ru_majflt;
  fields[8] = (double)rusage.ru_nswap;
  fields[9] = (double)rusage.ru_inblock;
  fields[10] = (double)rusage.ru_oublock;
  fields[11] = (double)rusage.ru_msgsnd;
  fields[12] = (double)rusage.ru_msgrcv;
  fields[13] = (double)rusage.ru_nsignals;
  fields[14] = (double)rusage.ru_nvcsw;
  fields[15] = (double)rusage.ru_nivcsw;
  return 0;
}

// Rss (211-220) and MemoryUsage's first field (222-262): uv_resident_set_memory into `rss`; libuv's error, or 0.
TABNODE_EXPORT(tabnode_rss) int tabnode_rss(double *rss) {
  size_t size;
  int err = uv_resident_set_memory(&size);
  if (err) return err;
  *rss = (double)size;
  return 0;
}

// GetConstrainedMemory (264-267) and GetAvailableMemory (269-272).
TABNODE_EXPORT(tabnode_constrained_memory) double tabnode_constrained_memory(void) {
  return (double)uv_get_constrained_memory();
}
TABNODE_EXPORT(tabnode_available_memory) double tabnode_available_memory(void) {
  return (double)uv_get_available_memory();
}

// Abort (72-74): ABORT(), abort(3) here, which raises SIGABRT.
TABNODE_EXPORT(tabnode_abort) void tabnode_abort(void) { abort(); }

// PatchProcessObject's `pid` (uv_os_getpid) and GetParentProcessId's `ppid` (uv_os_getppid), src/node_process_object.cc.
TABNODE_EXPORT(tabnode_getpid) int tabnode_getpid(void) { return (int)uv_os_getpid(); }
TABNODE_EXPORT(tabnode_getppid) int tabnode_getppid(void) { return (int)uv_os_getppid(); }

// ProcessTitleGetter (src/node_process_object.cc:31-39) over GetProcessTitle (src/util.cc:188-210): uv_get_process_title
// into 16 bytes, doubling while libuv answers UV_ENOBUFS, up to 1 MiB; the title, in memory the caller frees, or NULL
// for Node's default ("node") where libuv answered anything else or the title outgrew the bound.
TABNODE_EXPORT(tabnode_get_process_title) char *tabnode_get_process_title(void) {
  size_t size = 16;
  char *buffer = calloc(size, 1);
  for (;;) {
    if (buffer == NULL) return NULL;
    int rc = uv_get_process_title(buffer, size);
    if (rc == 0) return buffer;
    free(buffer);
    if (rc != UV_ENOBUFS || size >= 1024 * 1024) return NULL;
    size *= 2;
    buffer = calloc(size, 1);
  }
}

// ProcessTitleSetter (src/node_process_object.cc:41-48): uv_set_process_title of the value's Utf8Value.
TABNODE_EXPORT(tabnode_set_process_title) int tabnode_set_process_title(const char *title) { return uv_set_process_title(title); }
