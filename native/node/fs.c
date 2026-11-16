// THE fs BINDING OVER uv_fs_* (Tabnode ADR-0018 §3, §5, item 6), as Node v24.21.0's src/node_file.cc and
// src/node_dir.cc call libuv below V8. A request (fs.h) owns its uv_fs_t in the process's memory. A synchronous call is
// uv_fs_* with no callback, as Node's SyncCall makes it; an asynchronous one has `after` as its callback, so libuv runs
// it on its threadpool (the process's pthreads) and completes it into the loop through uv_async_send. `after` is
// Node's AsyncCall's `after` up to V8: it calls the engine (fs_done), whose JavaScript runs the request's After
// (AfterNoArgs, AfterStat, ... in node_file.cc) and its MakeCallback, then closes the callback's scope (drain). Where
// Node's C++ decides in C (MKDirpSync, MKDirpAsync, ReadFileUtf8, WriteFileUtf8), this file decides it the same way.
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "engine.h"
#include "fs.h"

#define EXPORT(name) __attribute__((export_name(#name)))

tabnode_fs_error_t tabnode_fs_error;

static uv_loop_t *loop(void) { return uv_default_loop(); }

static void copy_text(char *into, size_t room, const char *text) {
  if (!text) { into[0] = '\0'; return; }
  snprintf(into, room, "%s", text);
}

// env->ThrowUVException(err, syscall, nullptr, path, dest) (src/api/exceptions.cc UVException).
void tabnode_fs_say_uv(int err, const char *syscall, const char *path, const char *dest) {
  tabnode_fs_error.kind = kTabnodeErrorUV;
  tabnode_fs_error.errorno = err;
  copy_text(tabnode_fs_error.syscall, sizeof tabnode_fs_error.syscall, syscall);
  tabnode_fs_error.code[0] = '\0';
  tabnode_fs_error.message[0] = '\0';
  copy_text(tabnode_fs_error.path, sizeof tabnode_fs_error.path, path);
  copy_text(tabnode_fs_error.dest, sizeof tabnode_fs_error.dest, dest);
}

// env->ThrowErrnoException(errorno, syscall, message, path) (exceptions.cc ErrnoException); ThrowStdErrException is
// this with the error code's value and message.
void tabnode_fs_say_errno(int errorno, const char *syscall, const char *message, const char *path) {
  tabnode_fs_error.kind = kTabnodeErrorErrno;
  tabnode_fs_error.errorno = errorno;
  copy_text(tabnode_fs_error.syscall, sizeof tabnode_fs_error.syscall, syscall);
  tabnode_fs_error.code[0] = '\0';
  copy_text(tabnode_fs_error.message, sizeof tabnode_fs_error.message, message);
  copy_text(tabnode_fs_error.path, sizeof tabnode_fs_error.path, path);
  tabnode_fs_error.dest[0] = '\0';
}

// THROW_ERR_<code>(env, message) (src/node_errors.h): an Error whose `code` is the code.
void tabnode_fs_say_code(const char *code, const char *message) {
  tabnode_fs_error.kind = kTabnodeErrorCode;
  tabnode_fs_error.errorno = 0;
  tabnode_fs_error.syscall[0] = '\0';
  copy_text(tabnode_fs_error.code, sizeof tabnode_fs_error.code, code);
  copy_text(tabnode_fs_error.message, sizeof tabnode_fs_error.message, message);
  tabnode_fs_error.path[0] = '\0';
  tabnode_fs_error.dest[0] = '\0';
}

EXPORT(tabnode_fs_error_kind) int tabnode_fs_error_kind(void) { return tabnode_fs_error.kind; }
EXPORT(tabnode_fs_error_errno) int tabnode_fs_error_errno(void) { return tabnode_fs_error.errorno; }
EXPORT(tabnode_fs_error_syscall) const char *tabnode_fs_error_syscall(void) { return tabnode_fs_error.syscall; }
EXPORT(tabnode_fs_error_code) const char *tabnode_fs_error_code(void) { return tabnode_fs_error.code; }
EXPORT(tabnode_fs_error_message) const char *tabnode_fs_error_message(void) { return tabnode_fs_error.message; }
EXPORT(tabnode_fs_error_path) const char *tabnode_fs_error_path(void) { return tabnode_fs_error.path; }
EXPORT(tabnode_fs_error_dest) const char *tabnode_fs_error_dest(void) { return tabnode_fs_error.dest; }

// libuv's names and messages, and libc's, for the errors the engine's JavaScript makes (UVException's uv_err_name and
// uv_strerror, ErrnoException's errno_string and strerror).
EXPORT(tabnode_uv_err_name) const char *tabnode_uv_err_name(int err) { return uv_err_name(err); }
EXPORT(tabnode_uv_strerror) const char *tabnode_uv_strerror(int err) { return uv_strerror(err); }
EXPORT(tabnode_strerror) const char *tabnode_strerror(int errorno) { return strerror(errorno); }
EXPORT(tabnode_strlen) size_t tabnode_strlen(const char *text) { return strlen(text); }

// ---- the request ------------------------------------------------------------------------------------------------

// A request with `room` bytes after it for its arguments, zeroed so that a request never dispatched cleans up as one.
EXPORT(tabnode_fs_new) tabnode_fs_t *tabnode_fs_new(size_t room) {
  tabnode_fs_t *r = calloc(1, sizeof *r + room + 1);
  if (r) r->room_size = room;
  return r;
}
EXPORT(tabnode_fs_room) char *tabnode_fs_room(tabnode_fs_t *r) { return r->room; }

// FSReqAfterScope::Clear and the request's end: uv_fs_req_cleanup, then what the request held beside it.
EXPORT(tabnode_fs_free) void tabnode_fs_free(tabnode_fs_t *r) {
  if (!r) return;
  uv_fs_req_cleanup(&r->req);
  for (size_t i = 0; i < r->npaths; i++) free(r->paths[i]);
  free(r->paths);
  free(r->first_path);
  free(r->data);
  free(r);
}

EXPORT(tabnode_fs_result) double tabnode_fs_result(tabnode_fs_t *r) { return (double)r->req.result; }
EXPORT(tabnode_fs_path) const char *tabnode_fs_path(tabnode_fs_t *r) { return r->req.path; }
EXPORT(tabnode_fs_ptr) void *tabnode_fs_ptr(tabnode_fs_t *r) { return r->req.ptr; }
EXPORT(tabnode_fs_first_path) const char *tabnode_fs_first_path(tabnode_fs_t *r) { return r->first_path; }
EXPORT(tabnode_fs_data) const char *tabnode_fs_data(tabnode_fs_t *r) { return r->data; }
EXPORT(tabnode_fs_data_length) size_t tabnode_fs_data_length(tabnode_fs_t *r) { return r->data_length; }

// An asynchronous request's completion, on the loop: the engine runs its After, then the callback's scope closes.
static void after(uv_fs_t *req) {
  tabnode_fs_done((tabnode_fs_t *)req);
  tabnode_drain();
}
#define CB(async) ((async) ? after : NULL)

// ---- the stat arrays (src/node_file-inl.h FillStatsArray, FillStatFsArray) ---------------------------------------

// BindingData's stats_field_array and stats_field_bigint_array: two stats of FsStatsOffset's eighteen fields each (a
// watcher's current and previous), in the order lib/internal/fs/utils.js reads them.
enum { kFsStatsFieldsNumber = 18, kFsStatFsFieldsNumber = 8 };
static double stat_fields[2 * kFsStatsFieldsNumber];
static int64_t bigint_stat_fields[2 * kFsStatsFieldsNumber];
static double statfs_fields[kFsStatFsFieldsNumber];
static int64_t bigint_statfs_fields[kFsStatFsFieldsNumber];

EXPORT(tabnode_fs_stat_fields) double *tabnode_fs_stat_fields(void) { return stat_fields; }
EXPORT(tabnode_fs_bigint_stat_fields) int64_t *tabnode_fs_bigint_stat_fields(void) { return bigint_stat_fields; }
EXPORT(tabnode_fs_statfs_fields) double *tabnode_fs_statfs_fields(void) { return statfs_fields; }
EXPORT(tabnode_fs_bigint_statfs_fields) int64_t *tabnode_fs_bigint_statfs_fields(void) { return bigint_statfs_fields; }

void tabnode_fs_fill_stats(const uv_stat_t *s, int second) {
  const int at = second ? kFsStatsFieldsNumber : 0;
#define SET(index, value) (stat_fields[at + (index)] = (double)(value), bigint_stat_fields[at + (index)] = (int64_t)(value))
#define SET_TIME(index, value) SET(index, (double)(value))
  SET(0, s->st_dev);
  SET(1, s->st_mode);
  SET(2, s->st_nlink);
  SET(3, s->st_uid);
  SET(4, s->st_gid);
  SET(5, s->st_rdev);
  SET(6, s->st_blksize);
  SET(7, s->st_ino);
  SET(8, s->st_size);
  SET(9, s->st_blocks);
  SET_TIME(10, s->st_atim.tv_sec);
  SET_TIME(11, s->st_atim.tv_nsec);
  SET_TIME(12, s->st_mtim.tv_sec);
  SET_TIME(13, s->st_mtim.tv_nsec);
  SET_TIME(14, s->st_ctim.tv_sec);
  SET_TIME(15, s->st_ctim.tv_nsec);
  SET_TIME(16, s->st_birthtim.tv_sec);
  SET_TIME(17, s->st_birthtim.tv_nsec);
#undef SET_TIME
#undef SET
}

// The request's stat: `req.ptr`, as Node's SyncCall reads it, which libuv points at its statbuf.
EXPORT(tabnode_fs_fill_request_stats) void tabnode_fs_fill_request_stats(tabnode_fs_t *r) {
  tabnode_fs_fill_stats(r->req.ptr ? (const uv_stat_t *)r->req.ptr : &r->req.statbuf, 0);
}

EXPORT(tabnode_fs_fill_request_statfs) void tabnode_fs_fill_request_statfs(tabnode_fs_t *r) {
  const uv_statfs_t *s = r->req.ptr;
#define SET(index, value) (statfs_fields[index] = (double)(value), bigint_statfs_fields[index] = (int64_t)(value))
  SET(0, s->f_type);
  SET(1, s->f_bsize);
  SET(2, s->f_frsize);
  SET(3, s->f_blocks);
  SET(4, s->f_bfree);
  SET(5, s->f_bavail);
  SET(6, s->f_files);
  SET(7, s->f_ffree);
#undef SET
}

// ---- the calls ----------------------------------------------------------------------------------------------------
// Each answers what uv_fs_* answers: a synchronous call's result, or an asynchronous one's dispatch (0, or the error
// Node's AsyncDestCall passes to its `after` at once).

EXPORT(tabnode_fs_access) int tabnode_fs_access(tabnode_fs_t *r, const char *path, int mode, int async) {
  return uv_fs_access(loop(), &r->req, path, mode, CB(async));
}
EXPORT(tabnode_fs_close) int tabnode_fs_close(tabnode_fs_t *r, int fd, int async) {
  return uv_fs_close(loop(), &r->req, fd, CB(async));
}
EXPORT(tabnode_fs_open) int tabnode_fs_open(tabnode_fs_t *r, const char *path, int flags, int mode, int async) {
  return uv_fs_open(loop(), &r->req, path, flags, mode, CB(async));
}

// A read's or a write's buffers: the room begins with each buffer's length (nbufs 32-bit words), and the buffers'
// bytes follow, from the next 8-byte boundary, one after another.
static uv_buf_t *buffers_of(tabnode_fs_t *r, unsigned int nbufs) {
  const uint32_t *lengths = (const uint32_t *)r->room;
  char *at = r->room + ((nbufs * 4u + 7u) & ~7u);
  uv_buf_t *bufs = malloc((nbufs ? nbufs : 1) * sizeof *bufs);
  if (!bufs) return NULL;
  for (unsigned int i = 0; i < nbufs; i++) {
    bufs[i] = uv_buf_init(at, lengths[i]);
    at += lengths[i];
  }
  return bufs;
}

// libuv copies the buffer list into the request (req->bufsml, or its own allocation), so the list is the call's.
EXPORT(tabnode_fs_read) int tabnode_fs_read(tabnode_fs_t *r, int fd, unsigned int nbufs, int64_t position, int async) {
  uv_buf_t *bufs = buffers_of(r, nbufs);
  if (!bufs) return UV_ENOMEM;
  int err = uv_fs_read(loop(), &r->req, fd, bufs, nbufs, position, CB(async));
  free(bufs);
  return err;
}
EXPORT(tabnode_fs_write) int tabnode_fs_write(tabnode_fs_t *r, int fd, unsigned int nbufs, int64_t position, int async) {
  uv_buf_t *bufs = buffers_of(r, nbufs);
  if (!bufs) return UV_ENOMEM;
  int err = uv_fs_write(loop(), &r->req, fd, bufs, nbufs, position, CB(async));
  free(bufs);
  return err;
}

EXPORT(tabnode_fs_stat) int tabnode_fs_stat(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_stat(loop(), &r->req, path, CB(async));
}
// InternalModuleStat (node_file.cc:1100-1117): a synchronous uv_fs_stat, then S_ISDIR of its mode: 0 for a file, 1 for
// a directory, libuv's error otherwise.
EXPORT(tabnode_fs_internal_module_stat) int tabnode_fs_internal_module_stat(tabnode_fs_t *r, const char *path) {
  int rc = uv_fs_stat(loop(), &r->req, path, NULL);
  if (rc == 0) {
    const uv_stat_t *const s = (const uv_stat_t *)r->req.ptr;
    rc = S_ISDIR(s->st_mode);
  }
  return rc;
}
EXPORT(tabnode_fs_lstat) int tabnode_fs_lstat(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_lstat(loop(), &r->req, path, CB(async));
}
EXPORT(tabnode_fs_fstat) int tabnode_fs_fstat(tabnode_fs_t *r, int fd, int async) {
  return uv_fs_fstat(loop(), &r->req, fd, CB(async));
}
EXPORT(tabnode_fs_statfs) int tabnode_fs_statfs(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_statfs(loop(), &r->req, path, CB(async));
}
EXPORT(tabnode_fs_symlink) int tabnode_fs_symlink(tabnode_fs_t *r, const char *target, const char *path, int flags, int async) {
  return uv_fs_symlink(loop(), &r->req, target, path, flags, CB(async));
}
EXPORT(tabnode_fs_link) int tabnode_fs_link(tabnode_fs_t *r, const char *src, const char *dest, int async) {
  return uv_fs_link(loop(), &r->req, src, dest, CB(async));
}
EXPORT(tabnode_fs_readlink) int tabnode_fs_readlink(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_readlink(loop(), &r->req, path, CB(async));
}
EXPORT(tabnode_fs_rename) int tabnode_fs_rename(tabnode_fs_t *r, const char *from, const char *to, int async) {
  return uv_fs_rename(loop(), &r->req, from, to, CB(async));
}
EXPORT(tabnode_fs_ftruncate) int tabnode_fs_ftruncate(tabnode_fs_t *r, int fd, int64_t length, int async) {
  return uv_fs_ftruncate(loop(), &r->req, fd, length, CB(async));
}
EXPORT(tabnode_fs_fdatasync) int tabnode_fs_fdatasync(tabnode_fs_t *r, int fd, int async) {
  return uv_fs_fdatasync(loop(), &r->req, fd, CB(async));
}
EXPORT(tabnode_fs_fsync) int tabnode_fs_fsync(tabnode_fs_t *r, int fd, int async) {
  return uv_fs_fsync(loop(), &r->req, fd, CB(async));
}
EXPORT(tabnode_fs_unlink) int tabnode_fs_unlink(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_unlink(loop(), &r->req, path, CB(async));
}
EXPORT(tabnode_fs_rmdir) int tabnode_fs_rmdir(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_rmdir(loop(), &r->req, path, CB(async));
}
EXPORT(tabnode_fs_mkdir) int tabnode_fs_mkdir(tabnode_fs_t *r, const char *path, int mode, int async) {
  return uv_fs_mkdir(loop(), &r->req, path, mode, CB(async));
}
EXPORT(tabnode_fs_realpath) int tabnode_fs_realpath(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_realpath(loop(), &r->req, path, CB(async));
}
EXPORT(tabnode_fs_scandir) int tabnode_fs_scandir(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_scandir(loop(), &r->req, path, 0, CB(async));
}
EXPORT(tabnode_fs_copyfile) int tabnode_fs_copyfile(tabnode_fs_t *r, const char *src, const char *dest, int flags, int async) {
  return uv_fs_copyfile(loop(), &r->req, src, dest, flags, CB(async));
}
EXPORT(tabnode_fs_chmod) int tabnode_fs_chmod(tabnode_fs_t *r, const char *path, int mode, int async) {
  return uv_fs_chmod(loop(), &r->req, path, mode, CB(async));
}
EXPORT(tabnode_fs_fchmod) int tabnode_fs_fchmod(tabnode_fs_t *r, int fd, int mode, int async) {
  return uv_fs_fchmod(loop(), &r->req, fd, mode, CB(async));
}
EXPORT(tabnode_fs_chown) int tabnode_fs_chown(tabnode_fs_t *r, const char *path, uint32_t uid, uint32_t gid, int async) {
  return uv_fs_chown(loop(), &r->req, path, (uv_uid_t)uid, (uv_gid_t)gid, CB(async));
}
EXPORT(tabnode_fs_fchown) int tabnode_fs_fchown(tabnode_fs_t *r, int fd, uint32_t uid, uint32_t gid, int async) {
  return uv_fs_fchown(loop(), &r->req, fd, (uv_uid_t)uid, (uv_gid_t)gid, CB(async));
}
EXPORT(tabnode_fs_lchown) int tabnode_fs_lchown(tabnode_fs_t *r, const char *path, uint32_t uid, uint32_t gid, int async) {
  return uv_fs_lchown(loop(), &r->req, path, (uv_uid_t)uid, (uv_gid_t)gid, CB(async));
}
EXPORT(tabnode_fs_utime) int tabnode_fs_utime(tabnode_fs_t *r, const char *path, double atime, double mtime, int async) {
  return uv_fs_utime(loop(), &r->req, path, atime, mtime, CB(async));
}
EXPORT(tabnode_fs_futime) int tabnode_fs_futime(tabnode_fs_t *r, int fd, double atime, double mtime, int async) {
  return uv_fs_futime(loop(), &r->req, fd, atime, mtime, CB(async));
}
EXPORT(tabnode_fs_lutime) int tabnode_fs_lutime(tabnode_fs_t *r, const char *path, double atime, double mtime, int async) {
  return uv_fs_lutime(loop(), &r->req, path, atime, mtime, CB(async));
}
EXPORT(tabnode_fs_mkdtemp) int tabnode_fs_mkdtemp(tabnode_fs_t *r, const char *tpl, int async) {
  return uv_fs_mkdtemp(loop(), &r->req, tpl, CB(async));
}

// AfterScanDir and ReadDir's loop: uv_fs_scandir_next, one entry at a time, its name and type read by the engine.
static uv_dirent_t scanned;
EXPORT(tabnode_fs_scandir_next) int tabnode_fs_scandir_next(tabnode_fs_t *r) { return uv_fs_scandir_next(&r->req, &scanned); }
EXPORT(tabnode_fs_scanned_name) const char *tabnode_fs_scanned_name(void) { return scanned.name; }
EXPORT(tabnode_fs_scanned_type) int tabnode_fs_scanned_type(void) { return scanned.type; }

// ---- a recursive mkdir (node_file.cc MKDirpSync, MKDirpAsync, FSContinuationData) --------------------------------

static int push_path(tabnode_fs_t *r, char *path) {
  if (!path) return UV_ENOMEM;
  if (r->npaths == r->paths_room) {
    size_t room = r->paths_room ? 2 * r->paths_room : 8;
    char **grown = realloc(r->paths, room * sizeof *grown);
    if (!grown) { free(path); return UV_ENOMEM; }
    r->paths = grown;
    r->paths_room = room;
  }
  r->paths[r->npaths++] = path;
  return 0;
}
static char *pop_path(tabnode_fs_t *r) { return r->paths[--r->npaths]; }
static void maybe_set_first_path(tabnode_fs_t *r, const char *path) {
  if (!r->first_path || !r->first_path[0]) {
    free(r->first_path);
    r->first_path = strdup(path);
  }
}
// `path.substr(0, path.find_last_of(kPathSeparator))`: the whole path where it has no separator.
static char *dirname_of(const char *path) {
  const char *slash = strrchr(path, '/');
  return slash ? strndup(path, (size_t)(slash - path)) : strdup(path);
}

static int mkdirp_sync(tabnode_fs_t *r, const char *path, int mode) {
  r->mode = mode;
  if (push_path(r, strdup(path))) return UV_ENOMEM;
  while (r->npaths > 0) {
    char *next = pop_path(r);
    int err = uv_fs_mkdir(loop(), &r->req, next, mode, NULL);
    for (;;) {
      switch (err) {
        case 0:
          maybe_set_first_path(r, next);
          if (r->npaths == 0) { free(next); return 0; }
          break;
        case UV_EACCES:
        case UV_ENOSPC:
        case UV_ENOTDIR:
        case UV_EPERM:
          free(next);
          return err;
        case UV_ENOENT: {
          char *dirname = dirname_of(next);
          if (strcmp(dirname, next) != 0) {
            push_path(r, next);
            next = NULL;
            push_path(r, dirname);
          } else {
            free(dirname);
            if (r->npaths == 0) { err = UV_EEXIST; continue; }
          }
          break;
        }
        default: {
          uv_fs_req_cleanup(&r->req);
          int orig_err = err;
          err = uv_fs_stat(loop(), &r->req, next, NULL);
          if (err == 0 && !S_ISDIR(r->req.statbuf.st_mode)) {
            uv_fs_req_cleanup(&r->req);
            free(next);
            if (orig_err == UV_EEXIST && r->npaths > 0) return UV_ENOTDIR;
            return UV_EEXIST;
          }
          if (err < 0) { free(next); return err; }
          break;
        }
      }
      break;
    }
    uv_fs_req_cleanup(&r->req);
    free(next);
  }
  return 0;
}

// FSContinuationData::Done: the result, then the request's own `after`.
static void mkdirp_done(tabnode_fs_t *r, int result) {
  r->req.result = result;
  after(&r->req);
}

static void mkdirp_after_mkdir(uv_fs_t *req);
static void mkdirp_after_stat(uv_fs_t *req);

// MKDirpAsync: the directory on top of the stack (the first call pushes `path`; its continuations ignore theirs).
static int mkdirp_async(tabnode_fs_t *r, const char *path) {
  if (path && push_path(r, strdup(path))) return UV_ENOMEM;
  char *next = pop_path(r);
  int err = uv_fs_mkdir(loop(), &r->req, next, r->mode, mkdirp_after_mkdir);
  free(next);
  return err;
}

static void mkdirp_after_mkdir(uv_fs_t *req) {
  tabnode_fs_t *r = (tabnode_fs_t *)req;
  char *path = strdup(req->path);
  int err = (int)req->result;
  for (;;) {
    switch (err) {
      case 0:
        maybe_set_first_path(r, path);
        if (r->npaths == 0) {
          mkdirp_done(r, 0);
        } else {
          uv_fs_req_cleanup(req);
          mkdirp_async(r, NULL);
        }
        break;
      case UV_EACCES:
      case UV_ENOSPC:
      case UV_ENOTDIR:
      case UV_EPERM:
        mkdirp_done(r, err);
        break;
      case UV_ENOENT: {
        char *dirname = dirname_of(path);
        if (strcmp(dirname, path) != 0) {
          push_path(r, strdup(path));
          push_path(r, dirname);
        } else {
          free(dirname);
          if (r->npaths == 0) { err = UV_EEXIST; continue; }
        }
        uv_fs_req_cleanup(req);
        mkdirp_async(r, NULL);
        break;
      }
      default: {
        uv_fs_req_cleanup(req);
        // The mkdir's error, for the stat's callback (Node stashes it in req->data).
        r->stashed = err;
        int stat_err = uv_fs_stat(loop(), req, path, mkdirp_after_stat);
        if (stat_err < 0) mkdirp_done(r, stat_err);
        break;
      }
    }
    break;
  }
  free(path);
}

static void mkdirp_after_stat(uv_fs_t *req) {
  tabnode_fs_t *r = (tabnode_fs_t *)req;
  int err = (int)req->result;
  if (r->stashed == UV_EEXIST && r->npaths > 0) {
    if (err == 0 && S_ISDIR(req->statbuf.st_mode)) {
      uv_fs_req_cleanup(req);
      mkdirp_async(r, NULL);
      return;
    }
    err = UV_ENOTDIR;
  }
  // verify that the path pointed to is actually a directory.
  if (err == 0 && !S_ISDIR(req->statbuf.st_mode)) err = UV_EEXIST;
  mkdirp_done(r, err);
}

EXPORT(tabnode_fs_mkdirp) int tabnode_fs_mkdirp(tabnode_fs_t *r, const char *path, int mode, int async) {
  if (!async) return mkdirp_sync(r, path, mode);
  r->mode = mode;
  return mkdirp_async(r, path);
}

// ---- readFileUtf8 and writeFileUtf8 (node_file.cc ReadFileUtf8, WriteFileUtf8), synchronous ----------------------

// V8's String::kMaxLength on a 64-bit build, which bounds the fstat-sized buffer as Node bounds it.
static const uint64_t kMaxStringLength = (1u << 29) - 24;

// The whole file's bytes into the request's `data`; a path of NULL reads `fd`. 0, or the error said (open's with the
// path, read's without).
EXPORT(tabnode_fs_read_file_utf8) int tabnode_fs_read_file_utf8(tabnode_fs_t *r, const char *path, int fd, int flags) {
  tabnode_fs_error.kind = kTabnodeErrorNone;
  uv_file file;
  uv_fs_t req;
  const int is_fd = path == NULL;
  if (is_fd) {
    file = fd;
  } else {
    file = uv_fs_open(NULL, &req, path, flags, 0666, NULL);
    if (req.result < 0) {
      int err = (int)req.result;
      uv_fs_req_cleanup(&req);
      tabnode_fs_say_uv(err, "open", path, NULL);
      return err;
    }
    uv_fs_req_cleanup(&req);
  }
  // Past the first 8 KiB, read into one heap buffer sized from fstat(); the size is only a hint, reading continues
  // until read() reports EOF.
  char buffer[8192];
  char *small = NULL;
  size_t small_len = 0;
  uv_buf_t buf = uv_buf_init(buffer, sizeof buffer);
  char *big = NULL;
  size_t big_len = 0, big_cap = 0;
  int sized = 0, status = 0;
  const size_t kMinChunk = 64 * 1024, kMaxChunk = 8 * 1024 * 1024;
  for (;;) {
    int n = uv_fs_read(NULL, &req, file, &buf, 1, -1, NULL);
    if (req.result < 0) {
      status = (int)req.result;
      tabnode_fs_say_uv(status, "read", NULL, NULL);
      break;
    }
    if (n <= 0) break;
    if (big == NULL) {
      char *grown = realloc(small, small_len + (size_t)n);
      if (!grown) { status = UV_ENOMEM; tabnode_fs_say_code("ERR_MEMORY_ALLOCATION_FAILED", "Failed to allocate memory"); break; }
      small = grown;
      memcpy(small + small_len, buf.base, (size_t)n);
      small_len += (size_t)n;
      if ((size_t)n < sizeof buffer) continue;
      // Switch to the heap buffer.
      uv_fs_req_cleanup(&req);
      big_cap = kMinChunk;
      big = malloc(big_cap);
      if (!big) { status = UV_ENOMEM; tabnode_fs_say_code("ERR_MEMORY_ALLOCATION_FAILED", "Failed to allocate memory"); break; }
      memcpy(big, small, small_len);
      big_len = small_len;
      free(small);
      small = NULL;
      small_len = 0;
    } else {
      big_len += (size_t)n;
    }
    if (big_len == big_cap) {
      // +1 leaves room for the read() that reports EOF.
      size_t step = big_cap > kMinChunk ? big_cap : kMinChunk;
      size_t new_cap = big_cap + (step < kMaxChunk ? step : kMaxChunk);
      if (!sized) {
        sized = 1;
        uv_fs_req_cleanup(&req);
        uv_fs_t stat_req;
        if (uv_fs_fstat(NULL, &stat_req, file, NULL) == 0) {
          const uv_stat_t *st = stat_req.ptr;
          if ((st->st_mode & S_IFMT) == S_IFREG && st->st_size > big_len && st->st_size < kMaxStringLength)
            new_cap = (size_t)st->st_size + 1;
        }
        uv_fs_req_cleanup(&stat_req);
      }
      char *grown = realloc(big, new_cap);
      if (!grown) { status = UV_ENOMEM; tabnode_fs_say_code("ERR_MEMORY_ALLOCATION_FAILED", "Failed to allocate memory"); break; }
      big = grown;
      big_cap = new_cap;
    }
    size_t left = big_cap - big_len;
    buf = uv_buf_init(big + big_len, left < kMaxChunk ? left : kMaxChunk);
  }
  // `defer_close`: CHECK_EQ(0, uv_fs_close(...)), as Node aborts on a close that fails.
  if (!is_fd && uv_fs_close(NULL, &req, file, NULL) != 0) abort();
  uv_fs_req_cleanup(&req);
  if (status != 0) { free(small); free(big); return status; }
  free(r->data);
  if (big) { r->data = big; r->data_length = big_len; free(small); }
  else { r->data = small; r->data_length = small_len; }
  return 0;
}

// The data's bytes written whole, to `path` opened with `flags` and `mode`, or to `fd` where path is NULL. 0, or the
// error said: the open's, the write's, then the close's, the last one Node throws.
EXPORT(tabnode_fs_write_file_utf8) int tabnode_fs_write_file_utf8(tabnode_fs_t *r, const char *path, int fd,
    int flags, int mode, char *data, size_t length) {
  (void)r;
  tabnode_fs_error.kind = kTabnodeErrorNone;
  uv_fs_t req;
  uv_file file;
  const int is_fd = path == NULL;
  int status = 0;
  if (is_fd) {
    file = fd;
  } else {
    file = uv_fs_open(NULL, &req, path, flags, mode, NULL);
    uv_fs_req_cleanup(&req);
    if (file < 0) { tabnode_fs_say_uv(file, "open", path, NULL); return file; }
  }
  size_t offset = 0;
  uv_buf_t uvbuf = uv_buf_init(data, length);
  while (offset < length) {
    int written = uv_fs_write(NULL, &req, file, &uvbuf, 1, -1, NULL);
    uv_fs_req_cleanup(&req);
    // Write errored out
    if (written < 0) { tabnode_fs_say_uv(written, "write", NULL, NULL); status = written; break; }
    offset += (size_t)written;
    uvbuf.base += written;
    uvbuf.len -= (size_t)written;
  }
  if (!is_fd) {
    int result = uv_fs_close(NULL, &req, file, NULL);
    uv_fs_req_cleanup(&req);
    if (result < 0) { tabnode_fs_say_uv(result, "close", NULL, NULL); return result; }
  }
  return status;
}

// ---- directories (node_dir.cc) ----------------------------------------------------------------------------------

EXPORT(tabnode_fs_opendir) int tabnode_fs_opendir(tabnode_fs_t *r, const char *path, int async) {
  return uv_fs_opendir(loop(), &r->req, path, CB(async));
}

// DirHandle's constructor: no entries until a read asks for them.
EXPORT(tabnode_fs_dir_adopt) void tabnode_fs_dir_adopt(uv_dir_t *dir) {
  dir->nentries = 0;
  dir->dirents = NULL;
}

// DirHandle::Read: the dirents resized to the buffer size asked, then uv_fs_readdir.
EXPORT(tabnode_fs_readdir) int tabnode_fs_readdir(tabnode_fs_t *r, uv_dir_t *dir, size_t entries, int async) {
  if (entries != dir->nentries) {
    uv_dirent_t *grown = realloc(dir->dirents, (entries ? entries : 1) * sizeof *grown);
    if (!grown) return UV_ENOMEM;
    dir->dirents = grown;
    dir->nentries = entries;
  }
  return uv_fs_readdir(loop(), &r->req, dir, CB(async));
}
EXPORT(tabnode_fs_dir_entry_name) const char *tabnode_fs_dir_entry_name(uv_dir_t *dir, size_t i) { return dir->dirents[i].name; }
EXPORT(tabnode_fs_dir_entry_type) int tabnode_fs_dir_entry_type(uv_dir_t *dir, size_t i) { return dir->dirents[i].type; }

// DirHandle::Close: uv_fs_closedir, which frees the uv_dir_t; the dirents DirHandle held go with it.
EXPORT(tabnode_fs_closedir) int tabnode_fs_closedir(tabnode_fs_t *r, uv_dir_t *dir, int async) {
  free(dir->dirents);
  dir->dirents = NULL;
  dir->nentries = 0;
  return uv_fs_closedir(loop(), &r->req, dir, CB(async));
}
