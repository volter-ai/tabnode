// rmSync and the cpSync calls (Tabnode ADR-0018 item 6): Node v24.21.0's RmSync, CpSyncCheckPaths, CpSyncOverrideFile
// and CpSyncCopyDir (src/node_file.cc) are C++ over std::filesystem, and the std::filesystem calls they make are
// written here over the POSIX calls libc++ makes for them (its
// filesystem/operations.cpp: symlink_status is lstat, status stat, remove remove(3), remove_all a walk that removes
// children first and never follows a link, create_directories mkdir from the first missing parent, copy_file an open,
// a check and a copy of the bytes). What Node decides around them (the retries, the checks, each error and its
// message) is Node's, line for line. Where std::filesystem would throw (a call Node makes without an error_code) the
// error is said as the call's ErrnoException, since the engine has no C++ exception to abort with.
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "fs.h"

#define EXPORT(name) __attribute__((export_name(#name)))
#define PATH_ROOM 4096

// ---- paths, as std::filesystem::path takes them -----------------------------------------------------------------

// `a / b`: b where it is absolute, else a, a separator, and b.
static void join(char *out, const char *a, const char *b) {
  if (b[0] == '/' || a[0] == '\0') { snprintf(out, PATH_ROOM, "%s", b); return; }
  size_t n = strlen(a);
  snprintf(out, PATH_ROOM, "%s%s%s", a, a[n - 1] == '/' ? "" : "/", b);
}

// path::parent_path(): the path itself where it is only a root, else the path less its last element (a trailing
// separator's empty one first), and empty for a single relative element.
static void parent_path(char *out, const char *p) {
  size_t n = strlen(p), i = 0;
  if (n == 0) { out[0] = '\0'; return; }
  while (i < n && p[i] == '/') i++;
  if (i == n) { snprintf(out, PATH_ROOM, "%s", p); return; }
  size_t end = n;
  if (p[end - 1] == '/') {
    while (end > 0 && p[end - 1] == '/') end--;
    snprintf(out, PATH_ROOM, "%.*s", (int)end, p);
    return;
  }
  while (end > 0 && p[end - 1] != '/') end--;
  if (end == 0) { out[0] = '\0'; return; }
  size_t before = end;
  while (before > 0 && p[before - 1] == '/') before--;
  if (before == 0) { snprintf(out, PATH_ROOM, "%.*s", (int)end, p); return; }
  snprintf(out, PATH_ROOM, "%.*s", (int)before, p);
}

// path's comparison is by element: runs of separators are one, and a trailing separator is an element of its own.
static void path_key(char *out, const char *p) {
  size_t o = 0;
  for (size_t i = 0; p[i] && o + 1 < PATH_ROOM; i++) {
    if (p[i] == '/' && o > 0 && out[o - 1] == '/') continue;
    out[o++] = p[i];
  }
  out[o] = '\0';
}
static int path_equal(const char *a, const char *b) {
  char ka[PATH_ROOM], kb[PATH_ROOM];
  path_key(ka, a);
  path_key(kb, b);
  return strcmp(ka, kb) == 0;
}

// std::filesystem::absolute: the cwd joined with a relative path.
static void absolute_of(char *out, const char *p) {
  if (p[0] == '/') { snprintf(out, PATH_ROOM, "%s", p); return; }
  char cwd[PATH_ROOM];
  if (!getcwd(cwd, sizeof cwd)) cwd[0] = '\0';
  join(out, cwd, p);
}

// path::lexically_normal for an absolute path: "." elements dropped, ".." taking the element before, separators one.
static void lexically_normal(char *out, const char *p) {
  char parts[PATH_ROOM];
  snprintf(parts, sizeof parts, "%s", p);
  const int trailing = strlen(p) > 1 && p[strlen(p) - 1] == '/';
  char *elements[PATH_ROOM / 2];
  size_t count = 0;
  for (char *save = NULL, *e = strtok_r(parts, "/", &save); e; e = strtok_r(NULL, "/", &save)) {
    if (strcmp(e, ".") == 0) continue;
    if (strcmp(e, "..") == 0) { if (count > 0) count--; continue; }
    elements[count++] = e;
  }
  size_t o = 0;
  out[o++] = '/';
  out[o] = '\0';
  for (size_t i = 0; i < count; i++)
    o += (size_t)snprintf(out + o, PATH_ROOM - o, "%s%s", i ? "/" : "", elements[i]);
  if (trailing && count > 0 && o + 1 < PATH_ROOM) { out[o++] = '/'; out[o] = '\0'; }
}

// std::filesystem::weakly_canonical: the longest prefix that exists made canonical, the rest appended, normalized.
static void weakly_canonical(char *out, const char *absolute) {
  char prefix[PATH_ROOM], rest[PATH_ROOM] = "";
  snprintf(prefix, sizeof prefix, "%s", absolute);
  struct stat st;
  for (;;) {
    if (stat(prefix, &st) == 0) break;
    char *slash = strrchr(prefix, '/');
    if (!slash || slash == prefix) { snprintf(prefix, sizeof prefix, "/"); break; }
    char moved[PATH_ROOM];
    snprintf(moved, sizeof moved, "%s%s%s", slash + 1, rest[0] ? "/" : "", rest);
    snprintf(rest, sizeof rest, "%s", moved);
    *slash = '\0';
  }
  char canonical[PATH_MAX];
  if (!realpath(prefix, canonical)) snprintf(canonical, sizeof canonical, "%s", prefix);
  char whole[PATH_ROOM];
  if (rest[0]) join(whole, canonical, rest);
  else snprintf(whole, sizeof whole, "%s", canonical);
  lexically_normal(out, whole);
}

// node_file.cc normalizePathToArray and isInsideDir: dest's elements begin with all of src's.
static size_t elements_of(const char *p, char elements[][256], size_t room) {
  char absolute[PATH_ROOM];
  absolute_of(absolute, p);
  size_t count = 0;
  if (absolute[0] == '/' && count < room) snprintf(elements[count++], 256, "/");
  char copy[PATH_ROOM];
  snprintf(copy, sizeof copy, "%s", absolute);
  for (char *save = NULL, *e = strtok_r(copy, "/", &save); e && count < room; e = strtok_r(NULL, "/", &save))
    snprintf(elements[count++], 256, "%s", e);
  return count;
}
static int is_inside_dir(const char *src, const char *dest) {
  static char a[256][256], b[256][256];
  size_t na = elements_of(src, a, 256), nb = elements_of(dest, b, 256);
  if (na > nb) return 0;
  for (size_t i = 0; i < na; i++) if (strcmp(a[i], b[i]) != 0) return 0;
  return 1;
}

// ---- std::filesystem's operations ---------------------------------------------------------------------------------

// remove: remove(3), where a path already gone is no error. 0, or the errno.
static int remove_one(const char *p) {
  if (remove(p) == -1) return errno == ENOENT ? 0 : errno;
  return 0;
}

// remove_all_impl: a directory's children first (its links are removed, never followed), then the path itself.
static int remove_all_impl(const char *p) {
  struct stat st;
  if (lstat(p, &st) != 0) return errno;
  if (S_ISDIR(st.st_mode)) {
    DIR *dir = opendir(p);
    if (!dir) return errno;
    for (;;) {
      errno = 0;
      struct dirent *entry = readdir(dir);
      if (!entry) {
        int err = errno;
        closedir(dir);
        if (err) return err;
        break;
      }
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
      char child[PATH_ROOM];
      join(child, p, entry->d_name);
      int err = remove_all_impl(child);
      if (err) { closedir(dir); return err; }
    }
  }
  return remove_one(p);
}
static int remove_all(const char *p) {
  int err = remove_all_impl(p);
  return err == ENOENT ? 0 : err;
}

// create_directory: mkdir with every permission, where a directory already there is no error.
static int create_directory(const char *p) {
  if (mkdir(p, 0777) == 0) return 0;
  int err = errno;
  struct stat st;
  if (err == EEXIST && stat(p, &st) == 0 && S_ISDIR(st.st_mode)) return 0;
  return err;
}

// create_directories: from the first missing parent down.
static int create_directories(const char *p) {
  struct stat st;
  if (stat(p, &st) == 0) return S_ISDIR(st.st_mode) ? 0 : EEXIST;
  if (errno != ENOENT && errno != ENOTDIR) return errno;
  char parent[PATH_ROOM];
  parent_path(parent, p);
  if (parent[0]) {
    if (stat(parent, &st) != 0) {
      if (errno != ENOENT && errno != ENOTDIR) return errno;
      if (path_equal(parent, p)) return EINVAL;
      int err = create_directories(parent);
      if (err) return err;
    } else if (!S_ISDIR(st.st_mode)) {
      return ENOTDIR;
    }
  }
  return create_directory(p);
}

enum copy_options { kCopyNone, kCopySkipExisting, kCopyOverwriteExisting };

// copy_file: the source must be a regular file; an existing destination is skipped, overwritten or EEXIST as the
// options say, and is the same file EEXIST always. 0 copied or skipped, or the errno.
static int copy_file(const char *from, const char *to, enum copy_options options) {
  int from_fd = open(from, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (from_fd < 0) return errno;
  struct stat from_st, to_st;
  int err = 0, to_fd = -1;
  if (fstat(from_fd, &from_st) != 0) { err = errno; goto out; }
  if (!S_ISREG(from_st.st_mode)) { err = ENOTSUP; goto out; }
  int to_exists = stat(to, &to_st) == 0;
  if (!to_exists && errno != ENOENT && errno != ENOTDIR) { err = errno; goto out; }
  if (to_exists && !S_ISREG(to_st.st_mode)) { err = ENOTSUP; goto out; }
  if (to_exists && from_st.st_dev == to_st.st_dev && from_st.st_ino == to_st.st_ino) { err = EEXIST; goto out; }
  if (to_exists && options == kCopySkipExisting) goto out;
  if (to_exists && options != kCopyOverwriteExisting) { err = EEXIST; goto out; }
  to_fd = open(to, O_WRONLY | O_CLOEXEC | (to_exists ? 0 : O_CREAT), from_st.st_mode);
  if (to_fd < 0) { err = errno; goto out; }
  if (to_exists) {
    struct stat opened;
    if (fstat(to_fd, &opened) != 0) { err = errno; goto out; }
    if (opened.st_dev != to_st.st_dev || opened.st_ino != to_st.st_ino) { err = EBADF; goto out; }
    if (fchmod(to_fd, from_st.st_mode) != 0 || ftruncate(to_fd, 0) != 0) { err = errno; goto out; }
  }
  char buffer[65536];
  for (;;) {
    ssize_t n = read(from_fd, buffer, sizeof buffer);
    if (n < 0) { if (errno == EINTR) continue; err = errno; goto out; }
    if (n == 0) break;
    for (ssize_t done = 0; done < n;) {
      ssize_t w = write(to_fd, buffer + done, (size_t)(n - done));
      if (w < 0) { if (errno == EINTR) continue; err = errno; goto out; }
      done += w;
    }
  }
out:
  if (to_fd >= 0) close(to_fd);
  close(from_fd);
  return err;
}

// equivalent(a, b, ec): one file by device and inode; ENOTSUP where either is not there.
static int equivalent(const char *a, const char *b, int *err) {
  struct stat sa, sb;
  *err = 0;
  if (stat(a, &sa) != 0 || stat(b, &sb) != 0) { *err = ENOTSUP; return 0; }
  return sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

static int is_directory(const char *p) { struct stat st; return stat(p, &st) == 0 && S_ISDIR(st.st_mode); }
static int is_regular_file(const char *p) { struct stat st; return stat(p, &st) == 0 && S_ISREG(st.st_mode); }
static int is_symlink(const char *p) { struct stat st; return lstat(p, &st) == 0 && S_ISLNK(st.st_mode); }
static int exists(const char *p) { struct stat st; return stat(p, &st) == 0; }

static int read_symlink(const char *p, char *out) {
  ssize_t n = readlink(p, out, PATH_ROOM - 1);
  if (n < 0) return errno;
  out[n] = '\0';
  return 0;
}

static void say_std(int err, const char *syscall, const char *path) {
  tabnode_fs_say_errno(err, syscall, strerror(err), path);
}

// ---- rmSync (RmSync) ---------------------------------------------------------------------------------------------

EXPORT(tabnode_fs_rm_sync) int tabnode_fs_rm_sync(const char *path, int max_retries, int recursive, int retry_delay) {
  tabnode_fs_error.kind = kTabnodeErrorNone;
  struct stat st;
  int known = lstat(path, &st) == 0;
  if (!known && (errno == ENOENT || errno == ENOTDIR)) return 0;
  char message[PATH_ROOM + 64];
  // File is a directory and recursive is false
  if (known && S_ISDIR(st.st_mode) && !recursive) {
    snprintf(message, sizeof message, "Path is a directory: %s", path);
    tabnode_fs_say_code("ERR_FS_EISDIR", message);
    return -1;
  }
  int i = 1, error = 0;
  while (max_retries >= 0) {
    error = recursive ? remove_all(path) : remove_one(path);
    if (!error || error == ENOENT) return 0;
    if (!(error == EBUSY || error == EMFILE || error == ENFILE || error == ENOTEMPTY || error == EPERM)) break;
    // sleep() takes seconds, so convert the millisecond delay.
    if (retry_delay > 0) sleep((unsigned)(i * retry_delay / 1000));
    max_retries--;
    i++;
  }
  if (error == EPERM) {
    snprintf(message, sizeof message, "Operation not permitted: %s", path);
    tabnode_fs_say_errno(EPERM, "rm", message, path);
  } else if (error == ENOTEMPTY) {
    snprintf(message, sizeof message, "Directory not empty: %s", path);
    tabnode_fs_say_errno(ENOTEMPTY, "rm", message, path);
  } else if (error == ENOTDIR) {
    snprintf(message, sizeof message, "Not a directory: %s", path);
    tabnode_fs_say_errno(ENOTDIR, "rm", message, path);
  } else if (error == EACCES) {
    snprintf(message, sizeof message, "Permission denied: %s", path);
    tabnode_fs_say_errno(EACCES, "rm", message, path);
  } else {
    snprintf(message, sizeof message, "Unknown error: %s", strerror(error));
    tabnode_fs_say_errno(UV_UNKNOWN, "rm", message, path);
  }
  return -1;
}

// ---- cpSyncCheckPaths (CpSyncCheckPaths) ------------------------------------------------------------------------

EXPORT(tabnode_fs_cp_check_paths) int tabnode_fs_cp_check_paths(const char *src, const char *dest, int dereference,
    int recursive) {
  tabnode_fs_error.kind = kTabnodeErrorNone;
  char message[3 * PATH_ROOM];
  struct stat src_st, dest_st;
  // Node asks symlink_status where it dereferences and status where it does not, and the reverse of dest.
  if ((dereference ? lstat(src, &src_st) : stat(src, &src_st)) != 0) {
    tabnode_fs_say_uv(-errno, dereference ? "stat" : "lstat", src, NULL);
    return -1;
  }
  int dest_error = (dereference ? stat(dest, &dest_st) : lstat(dest, &dest_st)) != 0 ? errno : 0;
  int dest_exists = !dest_error;
  int src_is_dir = S_ISDIR(src_st.st_mode) || (dereference && S_ISLNK(src_st.st_mode));
  char src_path[PATH_ROOM + 1];
  snprintf(src_path, PATH_ROOM, "%s", src);
  if (!dest_error) {
    // Check if src and dest are identical.
    int eq_err;
    if (equivalent(src, dest, &eq_err)) {
      snprintf(message, sizeof message, "src and dest cannot be the same %s", dest);
      tabnode_fs_say_code("ERR_FS_CP_EINVAL", message);
      return -1;
    }
    int dest_is_dir = S_ISDIR(dest_st.st_mode);
    if (src_is_dir && !dest_is_dir) {
      snprintf(message, sizeof message, "Cannot overwrite non-directory %s with directory %s", dest, src);
      tabnode_fs_say_code("ERR_FS_CP_DIR_TO_NON_DIR", message);
      return -1;
    }
    if (!src_is_dir && dest_is_dir) {
      snprintf(message, sizeof message, "Cannot overwrite directory %s with non-directory %s", dest, src);
      tabnode_fs_say_code("ERR_FS_CP_NON_DIR_TO_DIR", message);
      return -1;
    }
  }
  size_t src_length = strlen(src_path);
  if (src_length == 0 || src_path[src_length - 1] != '/') { src_path[src_length] = '/'; src_path[src_length + 1] = '\0'; }
  // Check if dest_path is a subdirectory of src_path.
  if (src_is_dir && strncmp(dest, src_path, strlen(src_path)) == 0) {
    snprintf(message, sizeof message, "Cannot copy %s to a subdirectory of self %s", src_path, dest);
    tabnode_fs_say_code("ERR_FS_CP_EINVAL", message);
    return -1;
  }
  char dest_parent[PATH_ROOM], src_parent[PATH_ROOM], dest_path_parent[PATH_ROOM], above[PATH_ROOM];
  parent_path(dest_parent, dest);
  parent_path(src_parent, src);
  parent_path(dest_path_parent, dest);
  // "/" parent is itself. Therefore, we need to check if the parent is the same as itself.
  for (;;) {
    parent_path(above, dest_parent);
    if (path_equal(src_parent, dest_parent) || !above[0] || path_equal(above, dest_parent)) break;
    int eq_err;
    if (equivalent(src, dest_path_parent, &eq_err)) {
      snprintf(message, sizeof message, "Cannot copy %s to a subdirectory of self %s", src_path, dest);
      tabnode_fs_say_code("ERR_FS_CP_EINVAL", message);
      return -1;
    }
    // If equivalent fails, it's highly likely that dest_parent does not exist
    if (eq_err) break;
    snprintf(dest_parent, sizeof dest_parent, "%s", above);
  }
  if (src_is_dir && !recursive) {
    snprintf(message, sizeof message, "Recursive option not enabled, cannot copy a directory: %s", src_path);
    tabnode_fs_say_code("ERR_FS_EISDIR", message);
    return -1;
  }
  if (S_ISSOCK(src_st.st_mode)) {
    snprintf(message, sizeof message, "Cannot copy a socket file: %s", dest);
    tabnode_fs_say_code("ERR_FS_CP_SOCKET", message);
    return -1;
  }
  if (S_ISFIFO(src_st.st_mode)) {
    snprintf(message, sizeof message, "Cannot copy a FIFO pipe: %s", dest);
    tabnode_fs_say_code("ERR_FS_CP_FIFO_PIPE", message);
    return -1;
  }
  if (!dest_exists || !exists(dest_path_parent)) create_directories(dest_path_parent);
  return 0;
}

// ---- cpSyncOverrideFile (CpSyncOverrideFile, CopyUtimes) --------------------------------------------------------

static int copy_utimes(const char *src, const char *dest) {
  uv_fs_t req;
  int result = uv_fs_stat(NULL, &req, src, NULL);
  if (result < 0) { uv_fs_req_cleanup(&req); tabnode_fs_say_uv(result, "stat", src, NULL); return -1; }
  const uv_stat_t *s = req.ptr;
  const double atime = s->st_atim.tv_sec + s->st_atim.tv_nsec / 1e9;
  const double mtime = s->st_mtim.tv_sec + s->st_mtim.tv_nsec / 1e9;
  uv_fs_req_cleanup(&req);
  int utime_result = uv_fs_utime(NULL, &req, dest, atime, mtime, NULL);
  uv_fs_req_cleanup(&req);
  if (utime_result < 0) { tabnode_fs_say_uv(utime_result, "utime", dest, NULL); return -1; }
  return 0;
}

EXPORT(tabnode_fs_cp_override_file) int tabnode_fs_cp_override_file(const char *src, const char *dest, int mode,
    int preserve_timestamps) {
  tabnode_fs_error.kind = kTabnodeErrorNone;
  // `!std::filesystem::remove(dest)`: a destination not there is no error, and still throws, with its value 0.
  if (remove(dest) == -1) {
    int err = errno == ENOENT ? 0 : errno;
    say_std(err, "unlink", dest);
    return -1;
  }
  if (mode == 0) {
    // if no mode is specified use the faster std::filesystem API
    int err = copy_file(src, dest, kCopyNone);
    if (err) { say_std(err, "cp", dest); return -1; }
  } else {
    uv_fs_t req;
    int result = uv_fs_copyfile(NULL, &req, src, dest, mode, NULL);
    uv_fs_req_cleanup(&req);
    if (result < 0) { tabnode_fs_say_uv(result, "cp", src, dest); return -1; }
  }
  if (preserve_timestamps && copy_utimes(src, dest)) return -1;
  return 0;
}

// ---- cpSyncCopyDir (CpSyncCopyDir) ------------------------------------------------------------------------------

typedef struct {
  int verbatim_symlinks, preserve_timestamps, force, error_on_exist, dereference;
  enum copy_options options;
} copy_dir_t;

static int copy_dir_contents(const copy_dir_t *c, const char *src, const char *dest) {
  char message[3 * PATH_ROOM];
  DIR *dir = opendir(src);
  if (!dir) { say_std(errno, "cp", src); return 0; }
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (!entry) {
      int err = errno;
      closedir(dir);
      if (err) { say_std(err, "cp", src); return 0; }
      return 1;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    char entry_path[PATH_ROOM], dest_file_path[PATH_ROOM];
    join(entry_path, src, entry->d_name);
    join(dest_file_path, dest, entry->d_name);
    const char *dest_str = dest;
    if (is_symlink(entry_path)) {
      char symlink_target[PATH_ROOM];
      int err = read_symlink(entry_path, symlink_target);
      if (err) { say_std(err, "cp", dest_str); goto fail; }
      if (c->verbatim_symlinks) {
        // copy_symlink: the link's own target, linked again.
        if (symlink(symlink_target, dest_file_path) != 0) { say_std(errno, "cp", dest_str); goto fail; }
        continue;
      }
      if (exists(dest_file_path)) {
        if (is_symlink(dest_file_path)) {
          char current[PATH_ROOM];
          err = read_symlink(dest_file_path, current);
          if (err) { say_std(err, "cp", dest_str); goto fail; }
          if (!c->dereference && is_directory(symlink_target) && is_inside_dir(symlink_target, current)) {
            snprintf(message, sizeof message, "Cannot copy %s to a subdirectory of self %s", symlink_target, current);
            tabnode_fs_say_code("ERR_FS_CP_EINVAL", message);
            goto fail;
          }
          // Prevent copy if src is a subdir of dest since unlinking dest in this case would result in removing src
          // contents and therefore a broken symlink would be created.
          if (is_directory(dest_file_path) && is_inside_dir(current, symlink_target)) {
            snprintf(message, sizeof message, "cannot overwrite %s with %s", current, symlink_target);
            tabnode_fs_say_code("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", message);
            goto fail;
          }
          err = remove_one(dest_file_path);
          if (err) { say_std(err, "cp", dest_str); goto fail; }
        } else if (is_regular_file(dest_file_path)) {
          if (!c->dereference || (!c->force && c->error_on_exist)) {
            say_std(EEXIST, "cp", dest_file_path);
            goto fail;
          }
        }
      }
      char joined[PATH_ROOM], absolute[PATH_ROOM], target_absolute[PATH_ROOM];
      join(joined, src, symlink_target);
      absolute_of(absolute, joined);
      weakly_canonical(target_absolute, absolute);
      // create_directory_symlink and create_symlink are both symlink(2) on POSIX.
      if (symlink(target_absolute, dest_file_path) != 0) { say_std(errno, "cp", dest_str); goto fail; }
    } else if (is_directory(entry_path)) {
      int err = create_directory(dest_file_path);
      if (err) { say_std(err, "cp", dest_file_path); goto fail; }
      if (!copy_dir_contents(c, entry_path, dest_file_path)) goto fail;
    } else if (is_regular_file(entry_path)) {
      int err = copy_file(entry_path, dest_file_path, c->options);
      if (err) {
        if (err == EEXIST) {
          snprintf(message, sizeof message,
              "[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (%s already exists)", dest_file_path);
          tabnode_fs_say_code("ERR_FS_CP_EEXIST", message);
          goto fail;
        }
        say_std(err, "cp", dest_str);
        goto fail;
      }
      if (c->preserve_timestamps && copy_utimes(entry_path, dest_file_path)) goto fail;
    }
  }
fail:
  closedir(dir);
  return 0;
}

EXPORT(tabnode_fs_cp_copy_dir) int tabnode_fs_cp_copy_dir(const char *src, const char *dest, int force,
    int dereference, int error_on_exist, int verbatim_symlinks, int preserve_timestamps) {
  tabnode_fs_error.kind = kTabnodeErrorNone;
  int err = create_directories(dest);
  if (err) { say_std(err, "cp", dest); return -1; }
  copy_dir_t c = {
    .verbatim_symlinks = verbatim_symlinks, .preserve_timestamps = preserve_timestamps, .force = force,
    .error_on_exist = error_on_exist, .dereference = dereference,
    .options = force ? kCopyOverwriteExisting : error_on_exist ? kCopyNone : kCopySkipExisting,
  };
  return copy_dir_contents(&c, src, dest) ? 0 : -1;
}
