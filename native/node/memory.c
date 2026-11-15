// THE ENGINE'S RECORDS IN THE PROCESS'S MEMORY (Tabnode ADR-0018 §3). Where Node's C++ reads a call's JavaScript
// values into C (a Utf8Value, a std::vector<char*> of them, a uv_buf_t over a Buffer's bytes), the engine lays the
// same values out as one record in the process's memory and the C reads it there: the record is allocated here,
// written whole by the engine, and freed here once the call has returned. libnode's own allocator, as Node's.
#include <stdlib.h>

__attribute__((export_name("tabnode_malloc"))) void *tabnode_malloc(size_t size) { return malloc(size); }
__attribute__((export_name("tabnode_free"))) void tabnode_free(void *at) { free(at); }
