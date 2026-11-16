// process.env's store without V8 (Tabnode ADR-0018 §7): Node v24.21.0's src/node_env_var.cc RealEnvStore, the
// process's own environment, libc's environ through libuv, so what JavaScript sets is what libuv, OpenSSL, libc and
// the process's children read. The engine's half (src/node-lib/binding/env_var.ts) is the Environment's env proxy
// (EnvGetter, EnvSetter, EnvQuery, EnvDeleter, EnvEnumerator, EnvDefiner), which reads the key's and the value's
// Utf8Value and calls these. Node holds per_process::env_var_mutex around each; the process has one thread that runs
// JavaScript, the only caller.
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <uv.h>
#include "wrap.h"

// RealEnvStore::Get (105-124) and Query (159-179): uv_os_getenv of `key` into `*size` bytes at `buffer`; libuv's
// answer, UV_ENOBUFS with the size the value needs, UV_ENOENT where there is none, else 0 and the value's length.
TABNODE_EXPORT(tabnode_getenv) int tabnode_getenv(const char *key, char *buffer, size_t *size) {
  return uv_os_getenv(key, buffer, size);
}

// DateTimeConfigurationChangeNotification's POSIX half (76-103): where the key is TZ, libc's tzset. (Node then has
// V8 redetect its time zone; the realm's Date is the page's, whose zone is the browser's.)
static void date_time_configuration_change(const char *key) {
  if (strcmp(key, "TZ") == 0) tzset();
}

// RealEnvStore::Set (144-156): uv_os_setenv of the key's and the value's Utf8Value, then the TZ notification.
TABNODE_EXPORT(tabnode_setenv) int tabnode_setenv(const char *key, const char *value) {
  int err = uv_os_setenv(key, value);
  date_time_configuration_change(key);
  return err;
}

// RealEnvStore::Delete (186-192): uv_os_unsetenv of the key's Utf8Value, then the TZ notification.
TABNODE_EXPORT(tabnode_unsetenv) int tabnode_unsetenv(const char *key) {
  int err = uv_os_unsetenv(key);
  date_time_configuration_change(key);
  return err;
}

// RealEnvStore::Enumerate (194-218): uv_os_environ's items, their count into `*count`, NULL where libuv failed (Node
// CHECKs it does not); each item's name, and their release, uv_os_free_environ.
TABNODE_EXPORT(tabnode_environ) uv_env_item_t *tabnode_environ(int *count) {
  uv_env_item_t *items;
  if (uv_os_environ(&items, count) != 0) return NULL;
  return items;
}
TABNODE_EXPORT(tabnode_environ_name) const char *tabnode_environ_name(uv_env_item_t *items, int index) { return items[index].name; }
TABNODE_EXPORT(tabnode_environ_free) void tabnode_environ_free(uv_env_item_t *items, int count) { uv_os_free_environ(items, count); }
