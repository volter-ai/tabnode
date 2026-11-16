// NODE'S CONSTANTS (Tabnode ADR-0018 §3): Node v24.21.0's src/node_constants.cc, every Define* function its
// CreatePerContextProperties calls (126-1333), compiled from Node's own text against the WALI SDK's musl headers,
// libuv's uv.h and the OpenSSL the program links, as Node compiles them into its binary against its system's: the
// errno, signal, priority, fs, crypto, zlib, dlopen, trace and internal groups, and os's UV_UDP_REUSEADDR (1388). The build
// extracts the functions, the system headers and fallbacks the file includes (30-113) and node_constants.h's own
// definitions (30-78) from Node's tarball (scripts/build-libnode.sh); tracing/trace_event_common.h is Node's, which its
// env-inl.h includes. Only V8 is not here: a Define* function's target is the text its definitions are written into,
// from which the engine builds `internalBinding('constants')` (src/shims/constants.ts).
//
// DefineZlibConstants is src/node_zlib.cc's (1922-2106), with the chunk and level bounds (74-88) and the mode enum
// (146-159) it reads, compiled against the zlib, brotli and zstd headers of the program's own copies (ADR-0018 item 10),
// as node_zlib.cc includes them.
//
// Beside them, the constants the wraps' Initialize functions define from uv.h and their own headers, written the same
// way: tcp_wrap.cc:133-137, pipe_wrap.cc:98-103, udp_wrap.cc:230-233 and tty_wrap.cc:71-73.
#include <cstdio>
#include <limits>
#include <string>

#include <uv.h>

#include "crypto_util.h"

#define ZSTD_STATIC_LINKING_ONLY
#include "brotli/decode.h"
#include "brotli/encode.h"
#include "zlib.h"
#include "zstd.h"
#include "zstd_errors.h"

// node.gypi:85 defines __POSIX__ where the OS is not Windows; node_constants.cc includes <dlfcn.h> under it.
#define __POSIX__ 1
#define HAVE_OPENSSL 1
#include "node_constants_prelude.inc"
#include "node_constants_header.inc"
#include "tracing/trace_event_common.h"

namespace node {

// What Node hands a Define* function as its target (a V8 object of the binding), here the text its definitions are
// written into: one line each, "GROUP n NAME VALUE" for a number (NODE_DEFINE_CONSTANT's Number of the value) and
// "GROUP s NAME VALUE" for a string (NODE_DEFINE_STRING_CONSTANT's).
struct Object {
  std::string* text;
  const char* group;
};
template <typename T>
using Local = T;

static void DefineNumber(Object target, const char* name, double value) {
  char line[256];
  snprintf(line, sizeof(line), "%s n %s %.17g\n", target.group, name, value);
  target.text->append(line);
}

static void DefineString(Object target, const char* name, const char* value) {
  target.text->append(target.group).append(" s ").append(name).append(" ").append(value).append("\n");
}

#define NODE_DEFINE_CONSTANT(target, constant) DefineNumber((target), #constant, static_cast<double>(constant))
#define NODE_DEFINE_STRING_CONSTANT(target, name, value) DefineString((target), (name), (value))

namespace constants {
#include "node_constants_body.inc"
}  // namespace constants

#include "node_zlib_constants.inc"

// TCPWrap's and PipeWrap's SocketType (tcp_wrap.h:38-41, pipe_wrap.h:37-41).
namespace tcp_wrap {
enum SocketType { SOCKET, SERVER };
}
namespace pipe_wrap {
enum SocketType { SOCKET, SERVER, IPC };
}

}  // namespace node

// CreatePerContextProperties (node_constants.cc:1335-1422), each group under its name, and the wraps' constants under
// their bindings' names: the program's text, malloc'd, its length in *length.
CRYPTO_EXPORT(tabnode_constants) char* tabnode_constants(size_t* length) {
  using namespace node;
  using namespace node::constants;
  std::string text;
  DefineErrnoConstants({&text, "errno"});
  DefineWindowsErrorConstants({&text, "errno"});
  DefineSignalConstants({&text, "signals"});
  DefinePriorityConstants({&text, "priority"});
  DefineFsConstants({&text, "fs"});
  DefineCryptoConstants({&text, "crypto"});
  DefineZlibConstants({&text, "zlib"});
  DefineDLOpenConstants({&text, "dlopen"});
  DefineTraceConstants({&text, "trace"});
  DefineInternalConstants({&text, "internal"});
  Object os_constants{&text, "os"};
  NODE_DEFINE_CONSTANT(os_constants, UV_UDP_REUSEADDR);
  {
    using namespace node::tcp_wrap;
    Object constants{&text, "tcp_wrap"};
    NODE_DEFINE_CONSTANT(constants, SOCKET);
    NODE_DEFINE_CONSTANT(constants, SERVER);
    NODE_DEFINE_CONSTANT(constants, UV_TCP_IPV6ONLY);
    NODE_DEFINE_CONSTANT(constants, UV_TCP_REUSEPORT);
  }
  {
    using namespace node::pipe_wrap;
    Object constants{&text, "pipe_wrap"};
    NODE_DEFINE_CONSTANT(constants, SOCKET);
    NODE_DEFINE_CONSTANT(constants, SERVER);
    NODE_DEFINE_CONSTANT(constants, IPC);
    NODE_DEFINE_CONSTANT(constants, UV_READABLE);
    NODE_DEFINE_CONSTANT(constants, UV_WRITABLE);
  }
  {
    Object constants{&text, "udp_wrap"};
    NODE_DEFINE_CONSTANT(constants, UV_UDP_IPV6ONLY);
    NODE_DEFINE_CONSTANT(constants, UV_UDP_REUSEADDR);
    NODE_DEFINE_CONSTANT(constants, UV_UDP_REUSEPORT);
  }
  {
    Object target{&text, "tty_wrap"};
    NODE_DEFINE_CONSTANT(target, UV_TTY_MODE_NORMAL);
    NODE_DEFINE_CONSTANT(target, UV_TTY_MODE_IO);
    NODE_DEFINE_CONSTANT(target, UV_TTY_MODE_RAW_VT);
  }
  return Copy(text.data(), text.size(), length);
}
