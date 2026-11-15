// NODE'S CRYPTO CONSTANTS (Tabnode ADR-0018 item 7, ADR-0016 §4): src/node_constants.cc's DefineCryptoConstants
// (865-1092) and node_constants.h's DEFAULT_CIPHER_LIST_CORE (52-76), compiled against the OpenSSL libnode.so holds, as
// Node compiles them into its binary. The build extracts them from Node's tarball (scripts/build-libnode.sh).
#include <cstdio>
#include <string>

#include "crypto_util.h"

// The headers and fallback definitions node_constants.cc includes under HAVE_OPENSSL (39-95), Node's own.
#define HAVE_OPENSSL 1
#include "crypto_constants_prelude.inc"
#include "default_cipher_list.inc"

// The body is Node's, extracted by the build; each definition is written as a line: "n NAME VALUE" for a number
// (Node's NODE_DEFINE_CONSTANT is a Number of the value) and "s NAME VALUE" for a string. Answers the text,
// malloc'd, its length in *length.
CRYPTO_EXPORT(tabnode_crypto_constants) char* tabnode_crypto_constants(size_t* length) {
  std::string target;
  char line[512];
#define NODE_DEFINE_CONSTANT(target, name)                                                     \
  do {                                                                                         \
    snprintf(line, sizeof(line), "n %s %.17g\n", #name, static_cast<double>(name));            \
    target.append(line);                                                                       \
  } while (0)
#define NODE_DEFINE_STRING_CONSTANT(target, name, value)                                       \
  do {                                                                                         \
    target.append("s ").append(name).append(" ").append(value).append("\n");                   \
  } while (0)
#include "crypto_constants_body.inc"
#undef NODE_DEFINE_CONSTANT
#undef NODE_DEFINE_STRING_CONSTANT
  return Copy(target.data(), target.size(), length);
}

