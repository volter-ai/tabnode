// internalBinding('credentials')'s POSIX half without V8 (Tabnode ADR-0018 §7): Node v24.21.0's src/node_credentials.cc,
// its libc calls in the program. A name (a user's or a group's) is resolved as uid_by_name and gid_by_name resolve one,
// getpwnam_r and getgrnam_r; the engine's half (src/node-lib/binding/credentials.ts) reads each argument as Node's
// does (a Uint32 or a string) and throws ThrowErrnoException where an answer is -1.
#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <pwd.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/syscall.h>
#include <unistd.h>
#include "wrap.h"

TABNODE_EXPORT(tabnode_getuid) uint32_t tabnode_getuid(void) { return (uint32_t)getuid(); }
TABNODE_EXPORT(tabnode_geteuid) uint32_t tabnode_geteuid(void) { return (uint32_t)geteuid(); }
TABNODE_EXPORT(tabnode_getgid) uint32_t tabnode_getgid(void) { return (uint32_t)getgid(); }
TABNODE_EXPORT(tabnode_getegid) uint32_t tabnode_getegid(void) { return (uint32_t)getegid(); }

// linux_at_secure (33-44): the kernel's AT_SECURE, read once.
static bool linux_at_secure(void) {
  static int value = -1;
  if (value < 0) value = getauxval(AT_SECURE) ? 1 : 0;
  return value != 0;
}

// HasOnly (50-67): whether the process's permitted capabilities are `capability` alone, capget's.
static bool has_only(int capability) {
  struct __user_cap_data_struct cap_data[_LINUX_CAPABILITY_U32S_3] = {0};
  struct __user_cap_header_struct cap_header_data = {_LINUX_CAPABILITY_VERSION_3, getpid()};
  if (syscall(SYS_capget, &cap_header_data, &cap_data) != 0) return false;
  _Static_assert(sizeof(cap_data) / sizeof(cap_data[0]) == 2, "two capability words");
  return cap_data[CAP_TO_INDEX(capability)].permitted == (unsigned int)CAP_TO_MASK(capability) &&
         cap_data[1 - CAP_TO_INDEX(capability)].permitted == 0;
}

// SafeGetenv's refusal (74-83): a secure-execution process with more than CAP_NET_BIND_SERVICE, or one whose real
// and effective ids differ, reads no environment variable; 1 where it is refused.
TABNODE_EXPORT(tabnode_safe_getenv_refused) int tabnode_safe_getenv_refused(void) {
  return ((!has_only(CAP_NET_BIND_SERVICE) && linux_at_secure()) || getuid() != geteuid() || getgid() != getegid()) ? 1 : 0;
}

// errno after a call that answered -1, for ThrowErrnoException.
TABNODE_EXPORT(tabnode_errno) int tabnode_errno(void) { return errno; }

// GetGroups: getgroups into `size` gids at `groups` (0 asks the count); the count, or -1 with errno.
TABNODE_EXPORT(tabnode_getgroups) int tabnode_getgroups(int size, uint32_t *groups) {
  if (size == 0) return getgroups(0, NULL);
  gid_t *list = malloc(sizeof(gid_t) * (size_t)size);
  if (list == NULL) { errno = ENOMEM; return -1; }
  int count = getgroups(size, list);
  for (int index = 0; index < count; index++) groups[index] = (uint32_t)list[index];
  free(list);
  return count;
}

// uid_by_name's string form (node_credentials.cc): getpwnam_r's uid, or uid_not_found ((uid_t)-1).
static uid_t uid_of(const char *name) {
  struct passwd pwd, *found = NULL;
  char buffer[4096];
  errno = 0;
  if (getpwnam_r(name, &pwd, buffer, sizeof(buffer), &found) == 0 && found != NULL) return found->pw_uid;
  return (uid_t)-1;
}

// gid_by_name's string form: getgrnam_r's gid, or gid_not_found ((gid_t)-1).
static gid_t gid_of(const char *name) {
  struct group grp, *found = NULL;
  char buffer[4096];
  errno = 0;
  if (getgrnam_r(name, &grp, buffer, sizeof(buffer), &found) == 0 && found != NULL) return found->gr_gid;
  return (gid_t)-1;
}

// A credential as the engine hands it: a name where `name` is not NULL, else the number `id`.
static uid_t uid_named(const char *name, uint32_t id) { return name != NULL ? uid_of(name) : (uid_t)id; }
static gid_t gid_named(const char *name, uint32_t id) { return name != NULL ? gid_of(name) : (gid_t)id; }

// SetUid, SetEUid, SetGid and SetEGid: 1 where the name is unknown (uid_not_found, gid_not_found), -1 with errno where
// the call fails, 0.
#define SETTER(name, type, resolve, not_found)                                                   \
  TABNODE_EXPORT(tabnode_##name) int tabnode_##name(const char *named, uint32_t id) {           \
    type value = resolve(named, id);                                                            \
    if (value == (type)not_found) return 1;                                                     \
    return name(value) ? -1 : 0;                                                                \
  }
SETTER(setuid, uid_t, uid_named, -1)
SETTER(seteuid, uid_t, uid_named, -1)
SETTER(setgid, gid_t, gid_named, -1)
SETTER(setegid, gid_t, gid_named, -1)

// SetGroups: each of `count` entries a name (`names[i]` not NULL) or a gid (`ids[i]`); the 1-based index of the first
// unknown name, -1 with errno where setgroups fails, 0.
TABNODE_EXPORT(tabnode_setgroups) int tabnode_setgroups(int count, const char *const *names, const uint32_t *ids) {
  gid_t *groups = malloc(sizeof(gid_t) * (size_t)(count > 0 ? count : 1));
  if (groups == NULL) { errno = ENOMEM; return -1; }
  for (int index = 0; index < count; index++) {
    gid_t gid = gid_named(names[index], ids[index]);
    if (gid == (gid_t)-1) { free(groups); return index + 1; }
    groups[index] = gid;
  }
  int rc = setgroups((size_t)count, groups);
  free(groups);
  return rc == -1 ? -1 : 0;
}

// InitGroups: the user a name or, by its uid, getpwuid_r's name (1 where none); the extra group a name or a gid (2
// where the name is unknown); -1 with errno where initgroups fails, 0.
TABNODE_EXPORT(tabnode_initgroups) int tabnode_initgroups(const char *user, uint32_t uid, const char *group, uint32_t gid) {
  char buffer[4096];
  const char *name = user;
  if (name == NULL) {
    struct passwd pwd, *found = NULL;
    if (getpwuid_r((uid_t)uid, &pwd, buffer, sizeof(buffer), &found) != 0 || found == NULL) return 1;
    name = found->pw_name;
  }
  gid_t extra = gid_named(group, gid);
  if (extra == (gid_t)-1) return 2;
  return initgroups(name, extra) ? -1 : 0;
}
