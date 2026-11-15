// THE ENGINE'S BYTES IN THE PROCESS'S MEMORY (Tabnode ADR-0018 §3). Where Node's C++ reads a call's JavaScript values
// into C (a Utf8Value, a std::vector<char*> of them, a uv_buf_t over a Buffer's bytes), the engine lays the same
// values out in the process's memory and the C reads them there: a call's record, a write's bytes (which its request
// owns until its callback), a name. Each is allocated here, written by the engine, and freed here once the call or
// its request is done: libnode's own allocator, as Node's. Node's `new` aborts where memory is out; so does this.
#include <stdlib.h>

__attribute__((export_name("tabnode_malloc"))) void *tabnode_malloc(size_t size) {
  void *at = malloc(size ? size : 1);
  if (!at) abort();
  return at;
}
__attribute__((export_name("tabnode_free"))) void tabnode_free(void *at) { free(at); }
