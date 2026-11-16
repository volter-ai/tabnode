// NODE'S START BEFORE V8 (Tabnode ADR-0018 §7): what Node v24.21.0's node::Start does from its command line to its
// environment, compiled from Node's own text as Node compiles it into its binary, each range extracted from Node's
// tarball (scripts/build-libnode.sh):
// - the options: node_options.h's structs and OptionsParser (19-699), node_options-inl.h's AddOption, Implies, Insert
//   and Parse (12-520), and node_options.cc's per_process options, every CheckOptions (40-311), the four parsers and
//   their tables (389-1662), and HandleEnvOptions and ParseNodeOptionsEnvVar (2171-2240), with node.h's
//   OptionEnvvarSettings (364-371), node_revert.h's Revert (16-78) and node_large_page.cc's MapStaticCodeToLargePages
//   and LargePagesError (417-462);
// - the env files: node_dotenv.h's Dotenv (13-39) and node_dotenv.cc's GetDataFromArgs, ParseContent, ParsePath and
//   AssignNodeOptionsIfAvailable (19-65, 105-350);
// - the config file: node_config_file.h's ConfigReader (17-64) and node_config_file.cc (6-341), over Node's simdjson;
// - `--run`: node_task_runner.h's ProcessRunner (16-88) and node_task_runner.cc (6-373), over simdjson and libuv;
// - what they use of Node's utilities: node_exit_code.h's ExitCode (7-46), util.h's ToLower, ToUpper,
//   StringEqualNoCase, USE and OnScopeLeave (369-383, 611-638), util-inl.h's definitions (194-240), util.cc's
//   ReadFileSync (264-301), and debug_utils-inl.h's SPrintF and FPrintF (14-65, 84-200).
// It is built as Node's Linux binary configures it (HAVE_OPENSSL, OpenSSL 3, HAVE_SQLITE, HAVE_AMARO,
// NODE_USE_V8_PLATFORM, no sandbox, no pointer compression), but with neither an inspector nor ICU, as the realm's
// `config` says (hasInspector and hasIntl false), and with OpenSSL's own store as the default root store
// (NODE_OPENSSL_CERT_STORE, `--openssl-use-def-ca-store`), which is the image's bundle (ADR-0016 §4).
//
// What is not Node's text is where V8 stands, and what Node's util.h, node_mutex.h and debug_utils.cc give it, which
// include V8:
// - CHECK and its comparisons and UNREACHABLE abort as util.h's do, DCHECK_EQ checks nothing as in Node's release
//   build, Mutex is node_mutex.h's over a uv_mutex_t, and FWrite is debug_utils.cc's on a POSIX system.
// - A binding function's call (v8::FunctionCallbackInfo) is the text its answer is written into: the functions
//   node_options.cc's Initialize sets (GetCLIOptionsValues 1685-1805, GetCLIOptionsInfo 1807-1877,
//   GetEnvOptionsInputType 1914-1945, GetNamespaceOptionsInputType 1952-2011, GetOptionsAsFlags 2013-2120) write
//   their values as JSON, in the order Node creates its properties, and the engine's half
//   (src/node-lib/binding/options.ts) makes the objects, Maps and arrays Node makes of them; Dotenv's ToObject is
//   its JSON, and its SetEnvironment sets the process's environment through node_env_var.c.
// - credentials::SafeGetenv is node_credentials.cc's (74-104) over the process's environment, RealEnvStore's
//   uv_os_getenv, under its refusal in credentials.c.
// - ProcessGlobalArgsInternal, InitializeNodeWithArgsInternal and InitializeOncePerProcessInternal (node.cc:726-818,
//   832-1008, 1113-1283) run from `main` before the engine starts, with Node's `node`'s flags (none), and so do
//   OpenSSL's start and InitCryptoOnce (crypto_util.cc, node_main_instance.cc:139). V8::SetFlagsFromCommandLine is
//   the page's engine's, which takes no flag: a word Node's parser hands V8 is taken where Node's table names it as
//   V8's, and refused as Node refuses what V8 does not take (`bad option`) where it does not; the flags
//   ProcessGlobalArgsInternal adds for V8 itself are the page's engine's to decide and are not made. `--v8-options`
//   prints V8's options, of which the page's engine has none.
#include <algorithm>
#include <array>
#include <cerrno>
#include <csignal>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <limits>
#include <locale>
#include <map>
#include <memory>
#include <optional>
#include <ranges>
#include <regex>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>

#include <fcntl.h>
#include <uv.h>

#include "simdjson.h"

#define HAVE_OPENSSL 1
#define HAVE_INSPECTOR 0
#define NODE_USE_V8_PLATFORM 1
#define HAVE_SQLITE 1
#define HAVE_AMARO 1
#define NODE_OPENSSL_CERT_STORE 1
#define NODE_EXTERN_PRIVATE

#include "openssl/opensslv.h"
#include "quic/guard.h"
#include "node_version.h"
#include "node_constants_header.inc"

// util.h's assertions: the expression, where it failed, then abort.
#define CHECK(expression)                                                                     \
  do {                                                                                        \
    if (!(expression)) {                                                                      \
      fprintf(stderr, "%s:%d: Assertion `%s' failed.\n", __FILE__, __LINE__, #expression);  \
      fflush(stderr);                                                                         \
      abort();                                                                                \
    }                                                                                         \
  } while (0)
#define CHECK_EQ(a, b) CHECK((a) == (b))
#define CHECK_NE(a, b) CHECK((a) != (b))
#define CHECK_GE(a, b) CHECK((a) >= (b))
#define CHECK_LT(a, b) CHECK((a) < (b))
// util.h's release DCHECKs, which check nothing; its attributes (util.h:58, debug_utils.h:18).
#define DCHECK_EQ(a, b) do { } while (0)
#define MUST_USE_RESULT __attribute__((warn_unused_result))
#define COLD_NOINLINE __attribute__((cold, noinline))
#define UNREACHABLE()                                                     \
  do {                                                                    \
    fprintf(stderr, "%s:%d: Unreachable code reached.\n", __FILE__, __LINE__); \
    fflush(stderr);                                                       \
    abort();                                                              \
  } while (0)

// What node_options.h and node_dotenv.h name of V8: a binding function's call, declared for the parser's friends,
// and the Maybe and the object Dotenv's SetEnvironment and ToObject answer, defined below where V8 stands.
namespace v8 {
class Value {};
template <typename T>
class FunctionCallbackInfo;
template <typename T>
class Maybe {};
// An object Node makes: here its JSON, its properties in the order Node sets them.
class Object {
 public:
  std::string json;
};
template <typename T>
class MaybeLocal {
 public:
  T value;
};
}  // namespace v8

extern "C" int tabnode_safe_getenv_refused(void);
extern "C" int tabnode_setenv(const char* key, const char* value);

namespace node {

#include "node_options_envvar.inc"
#include "node_exit_code.inc"

// util.h's ToLower, ToUpper and StringEqualNoCase (369-383), USE and OnScopeLeave (611-638), util-inl.h's definitions
// of the first three (194-240), and util.cc's ReadFileSync (264-301).
#include "node_util_h.inc"
#include "node_util_scope.inc"
#include "node_util_inl.inc"
#include "node_util_read.inc"

// debug_utils.cc's FWrite (504-545) on a POSIX system: the bytes, as they are, to the stream.
void FWrite(FILE* file, const std::string& str) { fwrite(str.data(), str.size(), 1, file); }

// debug_utils-inl.h's ToStringHelper, SPrintF and FPrintF (14-65, 84-200), without ToStringHelper's conversion of a V8
// value (66-82).
#include "node_debug_utils_a.inc"
#include "node_debug_utils_b.inc"

// node_mutex.h's Mutex (MutexBase<LibuvMutexTraits>): a uv_mutex_t, held for a ScopedLock's life.
class Mutex {
 public:
  Mutex() { CHECK_EQ(0, uv_mutex_init(&mutex_)); }
  ~Mutex() { uv_mutex_destroy(&mutex_); }
  Mutex(const Mutex&) = delete;
  Mutex& operator=(const Mutex&) = delete;

  class ScopedLock {
   public:
    explicit ScopedLock(const Mutex& mutex) : mutex_(mutex) { uv_mutex_lock(&mutex_.mutex_); }
    ~ScopedLock() { uv_mutex_unlock(&mutex_.mutex_); }
    ScopedLock(const ScopedLock&) = delete;
    ScopedLock& operator=(const ScopedLock&) = delete;

   private:
    const Mutex& mutex_;
  };

 private:
  mutable uv_mutex_t mutex_;
};

class Environment;

namespace credentials {
// SafeGetenv (node_credentials.cc:74-104) with no Environment: nothing where the process may not read its
// environment, else RealEnvStore::Get's (node_env_var.cc:105-124) uv_os_getenv into 256 bytes, again into the size it
// asked for where they were too few.
bool SafeGetenv(const char* key, std::string* text, Environment* env = nullptr) {
  (void)env;
  if (tabnode_safe_getenv_refused()) return false;
  size_t size = 256;
  std::string value(size, '\0');
  int ret = uv_os_getenv(key, value.data(), &size);
  if (ret == UV_ENOBUFS) {
    value.resize(size);
    ret = uv_os_getenv(key, value.data(), &size);
  }
  if (ret < 0) return false;
  value.resize(size);
  *text = value;
  return true;
}
}  // namespace credentials

namespace per_process {
// node.cc:166.
unsigned int reverted_cve = 0;
}  // namespace per_process

}  // namespace node

#include "node_revert.inc"
#include "node_options_header.inc"

namespace v8 {
// A binding function's call: the text its answer is written into.
template <typename T>
class FunctionCallbackInfo {
 public:
  explicit FunctionCallbackInfo(std::string* answer) : answer_(answer) {}
  std::string* answer() const { return answer_; }

 private:
  std::string* answer_;
};
}  // namespace v8

#include "node_options_inl.inc"
#include "node_options_cc_checks.inc"

#include "node_options_cc_parsers.inc"

// The answers' JSON: a string, a number, a boolean, a list of strings.
static void JsonString(std::string* out, const std::string& text) {
  out->push_back('"');
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') {
      out->push_back('\\');
      out->push_back(static_cast<char>(c));
    } else if (c < 0x20) {
      char escape[8];
      snprintf(escape, sizeof(escape), "\\u%04x", c);
      out->append(escape);
    } else {
      out->push_back(static_cast<char>(c));
    }
  }
  out->push_back('"');
}
static void JsonNumber(std::string* out, double value) {
  char number[32];
  snprintf(number, sizeof(number), "%.17g", value);
  out->append(number);
}
static void JsonBoolean(std::string* out, bool value) { out->append(value ? "true" : "false"); }
static void JsonStrings(std::string* out, const std::vector<std::string>& list) {
  out->push_back('[');
  for (size_t i = 0; i < list.size(); i++) {
    if (i > 0) out->push_back(',');
    JsonString(out, list[i]);
  }
  out->push_back(']');
}

// GetCLIOptionsValues (1685-1805): each option's value, by name, in the parser's order, a boolean's `--no-` name
// before its own; `[name]` alone where Node's value is undefined (a no-op or a V8 option, but
// --abort-on-uncaught-exception and --stack-trace-limit), a host and port as `{"host", "port"}`.
void GetCLIOptionsValues(const v8::FunctionCallbackInfo<v8::Value>& args) {
  std::string* out = args.answer();
  Mutex::ScopedLock lock(per_process::cli_options_mutex);
  PerProcessOptions* opts = per_process::cli_options.get();
  bool first = true;
  auto open = [&](const std::string& name) {
    out->append(first ? "[" : ",");
    first = false;
    out->push_back('[');
    JsonString(out, name);
  };
  for (const auto& item : _ppop_instance.options_) {
    const auto& option_info = item.second;
    auto field = option_info.field;
    switch (option_info.type) {
      case kNoOp:
      case kV8Option:
        open(item.first);
        if (item.first == "--abort-on-uncaught-exception") {
          out->push_back(',');
          JsonBoolean(out, opts->per_isolate->per_env->abort_on_uncaught_exception);
        } else if (item.first == "--stack-trace-limit") {
          out->push_back(',');
          JsonNumber(out, static_cast<double>(*_ppop_instance.Lookup<int64_t>(field, opts)));
        }
        break;
      case kBoolean: {
        bool original_value = *_ppop_instance.Lookup<bool>(field, opts);
        open("--no" + item.first.substr(1, item.first.size()));
        out->push_back(',');
        JsonBoolean(out, !original_value);
        out->push_back(']');
        open(item.first);
        out->push_back(',');
        JsonBoolean(out, original_value);
        break;
      }
      case kInteger:
        open(item.first);
        out->push_back(',');
        JsonNumber(out, static_cast<double>(*_ppop_instance.Lookup<int64_t>(field, opts)));
        break;
      case kUInteger:
        open(item.first);
        out->push_back(',');
        JsonNumber(out, static_cast<double>(*_ppop_instance.Lookup<uint64_t>(field, opts)));
        break;
      case kString:
        open(item.first);
        out->push_back(',');
        JsonString(out, *_ppop_instance.Lookup<std::string>(field, opts));
        break;
      case kStringList:
        open(item.first);
        out->push_back(',');
        JsonStrings(out, *_ppop_instance.Lookup<StringVector>(field, opts));
        break;
      case kHostPort: {
        const HostPort& host_port = *_ppop_instance.Lookup<HostPort>(field, opts);
        open(item.first);
        out->append(",{\"host\":");
        JsonString(out, host_port.host());
        out->append(",\"port\":");
        JsonNumber(out, host_port.port());
        out->push_back('}');
        break;
      }
      default:
        UNREACHABLE();
    }
    out->push_back(']');
  }
  out->append(first ? "[]" : "]");
}

// GetCLIOptionsInfo (1807-1877): `options`, each option's `[name, helpText, envVarSettings, type, defaultIsTrue]`, and
// `aliases`, each alias's `[name, expansion]`, in the parser's order.
void GetCLIOptionsInfo(const v8::FunctionCallbackInfo<v8::Value>& args) {
  std::string* out = args.answer();
  Mutex::ScopedLock lock(per_process::cli_options_mutex);
  out->append("{\"options\":[");
  bool first = true;
  for (const auto& item : _ppop_instance.options_) {
    const auto& option_info = item.second;
    if (!first) out->push_back(',');
    first = false;
    out->push_back('[');
    JsonString(out, item.first);
    out->push_back(',');
    JsonString(out, option_info.help_text);
    out->push_back(',');
    JsonNumber(out, static_cast<int>(option_info.env_setting));
    out->push_back(',');
    JsonNumber(out, static_cast<int>(option_info.type));
    out->push_back(',');
    JsonBoolean(out, option_info.default_is_true);
    out->push_back(']');
  }
  out->append("],\"aliases\":[");
  first = true;
  for (const auto& alias : _ppop_instance.aliases_) {
    if (!first) out->push_back(',');
    first = false;
    out->push_back('[');
    JsonString(out, alias.first);
    out->push_back(',');
    JsonStrings(out, alias.second);
    out->push_back(']');
  }
  out->append("]}");
}

// AddOptionTypeToObject (314-387): an option's `[name, type, description]`, its type's name for the config file's
// schema; nothing for a no-op or a V8 option.
static void AddOptionType(std::string* out, bool* first, const std::string& option_name,
                          const OptionMappingDetails& option_details) {
  std::string type;
  switch (static_cast<int>(option_details.type)) {
    case 0:
    case 1:
      break;
    case 2:
      type = "boolean";
      break;
    case 3:
    case 4:
    case 6:
      type = "number";
      break;
    case 5:
      type = "string";
      break;
    case 7:
      type = "array";
      break;
    default:
      UNREACHABLE();
  }
  if (type.empty()) return;
  if (!*first) out->push_back(',');
  *first = false;
  out->push_back('[');
  JsonString(out, option_name);
  out->push_back(',');
  JsonString(out, type);
  out->push_back(',');
  JsonString(out, option_details.help_text);
  out->push_back(']');
}

// GetEnvOptionsInputType (1914-1945): every option NODE_OPTIONS allows, its type and its help text.
void GetEnvOptionsInputType(const v8::FunctionCallbackInfo<v8::Value>& args) {
  std::string* out = args.answer();
  Mutex::ScopedLock lock(per_process::cli_options_mutex);
  out->push_back('[');
  bool first = true;
  for (const auto& item : _ppop_instance.options_) {
    if (!item.first.empty() && !item.first.starts_with('[') && item.second.env_setting == kAllowedInEnvvar) {
      const auto mapping_details = options_parser::OptionMappingDetails{item.second.type, item.second.help_text};
      AddOptionType(out, &first, item.first, mapping_details);
    }
  }
  out->push_back(']');
}

// GetNamespaceOptionsInputType (1952-2011): each namespace's options, their types and help texts.
void GetNamespaceOptionsInputType(const v8::FunctionCallbackInfo<v8::Value>& args) {
  std::string* out = args.answer();
  Mutex::ScopedLock lock(per_process::cli_options_mutex);
  auto namespace_options = options_parser::MapNamespaceOptionsAssociations();
  out->push_back('[');
  bool first_namespace = true;
  for (const auto& ns_entry : namespace_options) {
    if (!first_namespace) out->push_back(',');
    first_namespace = false;
    out->push_back('[');
    JsonString(out, ns_entry.first);
    out->append(",[");
    bool first = true;
    for (const auto& opt_entry : ns_entry.second) AddOptionType(out, &first, opt_entry.first, opt_entry.second);
    out->append("]]");
  }
  out->push_back(']');
}

// GetOptionsAsFlags (2013-2120): the options in force as flags.
void GetOptionsAsFlags(const v8::FunctionCallbackInfo<v8::Value>& args) {
  Mutex::ScopedLock lock(per_process::cli_options_mutex);
  std::vector<std::string> flags;
  PerProcessOptions* opts = per_process::cli_options.get();
  for (const auto& item : _ppop_instance.options_) {
    const std::string& option_name = item.first;
    const auto& option_info = item.second;
    auto field = option_info.field;
    if (option_name.empty() || option_name.starts_with('[')) continue;
    if (option_info.type == kNoOp || option_info.type == kV8Option) continue;
    switch (option_info.type) {
      case kBoolean: {
        bool current_value = *_ppop_instance.Lookup<bool>(field, opts);
        if (option_info.default_is_true) {
          if (!current_value) flags.push_back("--no-" + option_name.substr(2));
        } else {
          if (current_value) flags.push_back(option_name);
        }
        break;
      }
      case kInteger:
        flags.push_back(option_name + "=" + std::to_string(*_ppop_instance.Lookup<int64_t>(field, opts)));
        break;
      case kUInteger:
        flags.push_back(option_name + "=" + std::to_string(*_ppop_instance.Lookup<uint64_t>(field, opts)));
        break;
      case kString: {
        const std::string& current_value = *_ppop_instance.Lookup<std::string>(field, opts);
        if (!current_value.empty()) flags.push_back(option_name + "=" + current_value);
        break;
      }
      case kStringList:
        for (const std::string& value : *_ppop_instance.Lookup<StringVector>(field, opts)) {
          flags.push_back(option_name + "=" + value);
        }
        break;
      case kHostPort: {
        const HostPort& host_port = *_ppop_instance.Lookup<HostPort>(field, opts);
        if (!host_port.host().empty() || host_port.port() != 0) {
          std::string host_port_str = host_port.host();
          if (host_port.port() != 0) {
            if (!host_port_str.empty()) host_port_str += ":";
            host_port_str += std::to_string(host_port.port());
          }
          if (!host_port_str.empty()) flags.push_back(option_name + "=" + host_port_str);
        }
        break;
      }
      default:
        break;
    }
  }
  JsonStrings(args.answer(), flags);
}

// V8::SetFlagsFromCommandLine with remove_flags, as the page's engine takes flags: none of its own, so a word is
// taken where Node's table names it as V8's (an option of kV8Option's type, which is also what an implication hands
// V8, or --stack-trace-limit, which Node passes down), its name read as V8 reads a flag's (dashes for underscores, a
// `no` or `no-` prefix, a value after `=`), and left for the `bad option` where not. Every such option is in no
// namespace (MapOptionsByNamespace's "").
static bool IsV8FlagOfNodes(const std::string& arg) {
  static const auto options = MapOptionsByNamespace("");
  auto is_v8 = [](const std::string& name) {
    auto it = options.find(name);
    return it != options.end() && (it->second.type == kV8Option || name == "--stack-trace-limit");
  };
  std::string name = arg.substr(0, arg.find('='));
  for (std::string::size_type i = 2; i < name.size(); ++i) {
    if (name[i] == '_') name[i] = '-';
  }
  if (is_v8(name)) return true;
  if (name.starts_with("--no-")) return is_v8("--" + name.substr(5));
  if (name.starts_with("--no")) return is_v8("--" + name.substr(4));
  return false;
}

// node_options.cc's own close of options_parser (2171), then HandleEnvOptions, ParseNodeOptionsEnvVar and the close
// of node.
#include "node_options_cc_env.inc"

namespace node {

#include "node_large_page.inc"

// node_dotenv.h's Dotenv (11-41) and node_dotenv.cc's GetDataFromArgs, ParseContent, ParsePath and
// AssignNodeOptionsIfAvailable (19-65, 105-350).
#include "node_dotenv_h.inc"
#include "node_dotenv_args.inc"
#include "node_dotenv_parse.inc"

// RealEnvStore::Get (node_env_var.cc:105-124): uv_os_getenv into 256 bytes, again into the size it asked for.
static std::optional<std::string> RealEnvGet(const char* key) {
  size_t size = 256;
  std::string value(size, '\0');
  int ret = uv_os_getenv(key, value.data(), &size);
  if (ret == UV_ENOBUFS) {
    value.resize(size);
    ret = uv_os_getenv(key, value.data(), &size);
  }
  if (ret < 0) return std::nullopt;
  value.resize(size);
  return value;
}

// Dotenv::SetEnvironment (node_dotenv.cc:67-85) over the process's RealEnvStore: each variable the environment does
// not hold, set through node_env_var.c (uv_os_setenv and the TZ notification).
v8::Maybe<void> Dotenv::SetEnvironment(Environment* env) {
  (void)env;
  for (const auto& entry : store_) {
    auto existing = RealEnvGet(entry.first.data());
    if (!existing.has_value()) tabnode_setenv(entry.first.c_str(), entry.second.c_str());
  }
  return {};
}

// Dotenv::ToObject (node_dotenv.cc:87-104): an object of the variables, as JSON, in the store's order.
v8::MaybeLocal<v8::Object> Dotenv::ToObject(Environment* env) const {
  (void)env;
  v8::MaybeLocal<v8::Object> result;
  std::string& out = result.value.json;
  out.push_back('{');
  bool first = true;
  for (const auto& entry : store_) {
    if (!first) out.push_back(',');
    first = false;
    options_parser::JsonString(&out, entry.first);
    out.push_back(':');
    options_parser::JsonString(&out, entry.second);
  }
  out.push_back('}');
  return result;
}

// node_config_file.h's ConfigReader (16-65) and node_config_file.cc (5-342), over Node's simdjson.
#include "node_config_file_h.inc"
#include "node_config_file_cc.inc"

// node_internals.h's InitializationResultImpl, without the platform the page's engine is.
struct InitializationResultImpl {
  ExitCode exit_code_enum() const { return exit_code_; }
  std::vector<std::string> args_;
  std::vector<std::string> exec_args_;
  std::vector<std::string> errors_;
  bool early_return_ = false;
  ExitCode exit_code_ = ExitCode::kNoFailure;
};

}  // namespace node

// node_task_runner.h's ProcessRunner (16-88) and node_task_runner.cc's `--run` (6-373), over Node's simdjson and the
// process's libuv.
#include "node_task_runner_h.inc"
#include "node_task_runner_cc.inc"

namespace node {

namespace per_process {
// node.cc's per-process Dotenv and ConfigReader.
Dotenv dotenv_file;
ConfigReader config_reader;
// NODE_EXTRA_CA_CERTS as the process started (crypto::UseExtraCaCerts, crypto_context.cc:2663-2666).
std::string extra_root_certs_file;
}  // namespace per_process

// ProcessGlobalArgsInternal (node.cc:726-818).
static ExitCode ProcessGlobalArgsInternal(std::vector<std::string>* args, std::vector<std::string>* exec_args,
                                          std::vector<std::string>* errors, OptionEnvvarSettings settings) {
  std::vector<std::string> v8_args;

  Mutex::ScopedLock lock(per_process::cli_options_mutex);
  options_parser::Parse(args, exec_args, &v8_args, per_process::cli_options.get(), settings, errors);

  if (!errors->empty()) return ExitCode::kInvalidCommandLineArgument;

  std::string revert_error;
  for (const std::string& cve : per_process::cli_options->security_reverts) {
    Revert(cve.c_str(), &revert_error);
    if (!revert_error.empty()) {
      errors->emplace_back(std::move(revert_error));
      return ExitCode::kInvalidCommandLineArgument2;
    }
  }

  if (per_process::cli_options->disable_proto != "delete" && per_process::cli_options->disable_proto != "throw" &&
      per_process::cli_options->disable_proto != "") {
    errors->emplace_back("invalid mode passed to --disable-proto");
    return ExitCode::kInvalidCommandLineArgument2;
  }

  auto env_opts = per_process::cli_options->per_isolate->per_env;
  if (std::ranges::find(v8_args, "--abort-on-uncaught-exception") != v8_args.end() ||
      std::ranges::find(v8_args, "--abort_on_uncaught_exception") != v8_args.end()) {
    env_opts->abort_on_uncaught_exception = true;
  }

  if (std::ranges::find(v8_args, "--prof") != v8_args.end()) {
    uv_loop_configure(uv_default_loop(), UV_LOOP_BLOCK_SIGNAL, SIGPROF);
  }

  // Anything that's still in v8_argv is not a V8 or a node option.
  std::vector<std::string> remaining;
  if (!v8_args.empty()) remaining.push_back(v8_args[0]);
  for (size_t i = 1; i < v8_args.size(); i++) {
    if (!options_parser::IsV8FlagOfNodes(v8_args[i])) remaining.push_back(v8_args[i]);
  }
  for (size_t i = 1; i < remaining.size(); i++) errors->push_back("bad option: " + remaining[i]);

  if (remaining.size() > 1) return ExitCode::kInvalidCommandLineArgument;

  return ExitCode::kNoFailure;
}

// InitializeNodeWithArgsInternal (node.cc:832-1008) with Node's `node`'s flags (none): stdio not inherited, the
// command line kept for the report, the environment's options, the env files (and their NODE_OPTIONS), the config
// file (and its), NODE_OPTIONS, the config file's namespaced flags, the command line, the title.
static ExitCode InitializeNodeWithArgsInternal(std::vector<std::string>* argv, std::vector<std::string>* exec_argv,
                                               std::vector<std::string>* errors) {
  uv_disable_stdio_inheritance();

  per_process::cli_options->cmdline = *argv;

  HandleEnvOptions(per_process::cli_options->per_isolate->per_env);

  std::string node_options;
  std::string node_options_from_dotenv;
  auto env_files = node::Dotenv::GetDataFromArgs(*argv);

  if (!env_files.empty()) {
    for (const auto& file_data : env_files) {
      switch (per_process::dotenv_file.ParsePath(file_data.path)) {
        case Dotenv::ParseResult::Valid:
          break;
        case Dotenv::ParseResult::InvalidContent:
          errors->push_back(file_data.path + ": invalid format");
          break;
        case Dotenv::ParseResult::FileError:
          if (file_data.is_optional) {
            fprintf(stderr, "%s not found. Continuing without it.\n", file_data.path.c_str());
            continue;
          }
          errors->push_back(file_data.path + ": not found");
          break;
        default:
          UNREACHABLE();
      }
    }

    per_process::dotenv_file.AssignNodeOptionsIfAvailable(&node_options_from_dotenv);
  }

  std::string node_options_from_config;
  auto config_path = per_process::config_reader.GetDataFromArgs(argv);
  if (per_process::config_reader.HasInvalidDefaultConfigFileArgument()) {
    errors->push_back("--experimental-default-config-file does not take an argument");
    return ExitCode::kInvalidCommandLineArgument;
  }
  if (config_path) {
    switch (per_process::config_reader.ParseConfig(*config_path)) {
      case ParseResult::Valid:
        break;
      case ParseResult::InvalidContent:
        errors->push_back(std::string(*config_path) + ": invalid content");
        break;
      case ParseResult::FileError:
        errors->push_back(std::string(*config_path) + ": not found");
        break;
      default:
        UNREACHABLE();
    }
    node_options_from_config = per_process::config_reader.GetNodeOptions();
    std::vector<std::string> env_argv_from_config = ParseNodeOptionsEnvVar(node_options_from_config, errors);
    if (env_argv_from_config.size() != per_process::config_reader.GetFlagsSize()) {
      errors->emplace_back("The number of NODE_OPTIONS doesn't match the number of flags in the config file");
    }
  }

  node_options = node_options_from_config + node_options_from_dotenv;

  // NODE_OPTIONS environment variable is preferred over the file one.
  if (credentials::SafeGetenv("NODE_OPTIONS", &node_options) || !node_options.empty()) {
    std::vector<std::string> env_argv = ParseNodeOptionsEnvVar(node_options, errors);

    if (!errors->empty()) return ExitCode::kInvalidCommandLineArgument;

    // [0] is expected to be the program name, fill it in from the real argv.
    env_argv.insert(env_argv.begin(), argv->at(0));

    const ExitCode exit_code = ProcessGlobalArgsInternal(&env_argv, nullptr, errors, kAllowedInEnvvar);
    if (exit_code != ExitCode::kNoFailure) return exit_code;
  }

  // The config file's namespaced flags, then the command line's, which override them.
  std::vector<std::string> extra_argv = per_process::config_reader.GetNamespaceFlags();
  extra_argv.insert(extra_argv.begin(), argv->at(0));
  ExitCode exit_code = ProcessGlobalArgsInternal(&extra_argv, nullptr, errors, kDisallowedInEnvvar);
  if (exit_code != ExitCode::kNoFailure) return exit_code;
  exit_code = ProcessGlobalArgsInternal(argv, exec_argv, errors, kDisallowedInEnvvar);
  if (exit_code != ExitCode::kNoFailure) return exit_code;

  // Set the process.title immediately after processing argv if --title is set.
  if (!per_process::cli_options->title.empty()) uv_set_process_title(per_process::cli_options->title.c_str());

  return ExitCode::kNoFailure;
}

// The process's arguments once read: the program's name, the script and its arguments (`process.argv`), and the
// options (`process.execArgv`).
static std::vector<std::string> process_args;
static std::vector<std::string> process_exec_args;

}  // namespace node

namespace tabnode {
int StartOpenSSL(const char* conf_file, bool shared_config, bool enable_fips, bool force_fips, std::string* error,
                 bool* failed);
void InitCryptoOnce(bool legacy_provider, int64_t secure_heap, int64_t secure_heap_min);
}  // namespace tabnode

// InitializeOncePerProcessInternal (node.cc:1113-1283) with Node's `node`'s flags, then StartInternal's report of its
// errors (1577-1586), and InitCryptoOnce as NodeMainInstance runs it (node_main_instance.cc:139): the command line;
// large pages; `--run`; `--version`, `--completion-bash` and `--v8-options`; OpenSSL's start (its configuration file,
// FIPS) and NODE_EXTRA_CA_CERTS. The exit code where the process ends here (`*early_return` set), else 0.
extern "C" __attribute__((export_name("tabnode_initialize_node_with_args"))) int tabnode_initialize_node_with_args(
    int argc, char** argv, int* early_return) {
  using namespace node;
  CHECK(argc > 0);
  const std::vector<std::string> args(argv, argv + argc);
  auto result = std::make_shared<InitializationResultImpl>();
  result->args_ = args;

  [&]() {
    result->exit_code_ = InitializeNodeWithArgsInternal(&result->args_, &result->exec_args_, &result->errors_);
    if (result->exit_code_enum() != ExitCode::kNoFailure) {
      result->early_return_ = true;
      return;
    }

    if (per_process::cli_options->use_largepages == "on" || per_process::cli_options->use_largepages == "silent") {
      int lp_result = MapStaticCodeToLargePages();
      if (per_process::cli_options->use_largepages == "on" && lp_result != 0) {
        result->errors_.emplace_back(LargePagesError(lp_result));
      }
    }

    if (!per_process::cli_options->run.empty()) {
      auto positional_args = task_runner::GetPositionalArgs(args);
      result->early_return_ = true;
      task_runner::RunTask(result, per_process::cli_options->run, positional_args);
      return;
    }

    if (per_process::cli_options->print_version) {
      printf("%s\n", NODE_VERSION);
      result->exit_code_ = ExitCode::kNoFailure;
      result->early_return_ = true;
      return;
    }

    if (per_process::cli_options->print_bash_completion) {
      std::string completion = options_parser::GetBashCompletion();
      printf("%s\n", completion.c_str());
      result->exit_code_ = ExitCode::kNoFailure;
      result->early_return_ = true;
      return;
    }

    if (per_process::cli_options->print_v8_help) {
      result->exit_code_ = ExitCode::kNoFailure;
      result->early_return_ = true;
      return;
    }

    const char* conf_file = nullptr;
    std::string env_openssl_conf;
    credentials::SafeGetenv("OPENSSL_CONF", &env_openssl_conf);
    if (!env_openssl_conf.empty()) conf_file = env_openssl_conf.c_str();
    if (!per_process::cli_options->openssl_config.empty()) conf_file = per_process::cli_options->openssl_config.c_str();
    std::string openssl_error;
    bool openssl_failed = false;
    int openssl_code = tabnode::StartOpenSSL(conf_file, per_process::cli_options->openssl_shared_config,
                                             per_process::cli_options->enable_fips_crypto,
                                             per_process::cli_options->force_fips_crypto, &openssl_error,
                                             &openssl_failed);
    if (openssl_failed) {
      result->exit_code_ = static_cast<ExitCode>(openssl_code);
      result->early_return_ = true;
      result->errors_.emplace_back(std::move(openssl_error));
      return;
    }

    std::string extra_ca_certs;
    if (credentials::SafeGetenv("NODE_EXTRA_CA_CERTS", &extra_ca_certs)) per_process::extra_root_certs_file = extra_ca_certs;

    tabnode::InitCryptoOnce(per_process::cli_options->openssl_legacy_provider, per_process::cli_options->secure_heap,
                            per_process::cli_options->secure_heap_min);
  }();

  for (const std::string& error : result->errors_) {
    FPrintF(stderr, "%s: %s\n", result->args_.at(0), error);
  }
  fflush(stdout);
  fflush(stderr);
  *early_return = result->early_return_ ? 1 : 0;
  process_args = std::move(result->args_);
  process_exec_args = std::move(result->exec_args_);
  return static_cast<int>(result->exit_code_enum());
}

// An answer's text, malloc'd for the engine, its length at `length`.
static char* Answer(const std::string& text, size_t* length) {
  char* copy = static_cast<char*>(malloc(text.size() + 1));
  if (copy == nullptr) return nullptr;
  memcpy(copy, text.data(), text.size());
  copy[text.size()] = '\0';
  *length = text.size();
  return copy;
}

// The process's arguments as the command line left them: `{"args", "execArgs"}`.
extern "C" __attribute__((export_name("tabnode_process_args"))) char* tabnode_process_args(size_t* length) {
  std::string text = "{\"args\":";
  node::options_parser::JsonStrings(&text, node::process_args);
  text.append(",\"execArgs\":");
  node::options_parser::JsonStrings(&text, node::process_exec_args);
  text.push_back('}');
  return Answer(text, length);
}

// internalBinding('options')'s functions (Initialize, 2122-2161), each answer's text.
#define OPTIONS_ANSWER(name, function)                                                              \
  extern "C" __attribute__((export_name(#name))) char* name(size_t* length) {                       \
    std::string text;                                                                               \
    node::options_parser::function(v8::FunctionCallbackInfo<v8::Value>(&text));                    \
    return Answer(text, length);                                                                    \
  }
OPTIONS_ANSWER(tabnode_cli_options_values, GetCLIOptionsValues)
OPTIONS_ANSWER(tabnode_cli_options_info, GetCLIOptionsInfo)
OPTIONS_ANSWER(tabnode_options_as_flags, GetOptionsAsFlags)
OPTIONS_ANSWER(tabnode_env_options_input_type, GetEnvOptionsInputType)
OPTIONS_ANSWER(tabnode_namespace_options_input_type, GetNamespaceOptionsInputType)

// NODE_EXTRA_CA_CERTS as the process started, the file crypto::UseExtraCaCerts records; empty for none.
extern "C" __attribute__((export_name("tabnode_extra_ca_certs"))) const char* tabnode_extra_ca_certs(void) {
  return node::per_process::extra_root_certs_file.c_str();
}

// StartExecution's env files (node.cc:343-346): the per-process Dotenv's variables set in the environment.
extern "C" __attribute__((export_name("tabnode_dotenv_set_environment"))) void tabnode_dotenv_set_environment(void) {
  USE(node::per_process::dotenv_file.SetEnvironment(nullptr));
}

// LoadEnvFile's Dotenv (node_process_methods.cc:616-634): the file at `path` parsed and, where it is valid, its
// variables set; ParseResult's Valid (0), FileError (1) or InvalidContent (2), which the engine's half throws as Node.
extern "C" __attribute__((export_name("tabnode_load_env_file"))) int tabnode_load_env_file(const char* path) {
  node::Dotenv dotenv{};
  node::Dotenv::ParseResult parsed = dotenv.ParsePath(path);
  if (parsed == node::Dotenv::ParseResult::Valid) USE(dotenv.SetEnvironment(nullptr));
  return static_cast<int>(parsed);
}

// util's ParseEnv (node_util.cc:240-253): `length` bytes of content parsed as Dotenv parses them, ToObject's JSON.
extern "C" __attribute__((export_name("tabnode_dotenv_parse"))) char* tabnode_dotenv_parse(const char* content,
                                                                                            size_t length,
                                                                                            size_t* answer) {
  node::Dotenv dotenv{};
  dotenv.ParseContent(std::string_view(content, length));
  return Answer(dotenv.ToObject(nullptr).value.json, answer);
}

// Metadata::Versions' `modules`, `napi` and `simdjson` (node_metadata.cc:110-112, 156): NODE_MODULE_VERSION,
// NODE_API_SUPPORTED_VERSION_MAX and SIMDJSON_VERSION as the program compiled them.
extern "C" __attribute__((export_name("tabnode_modules_version"))) const char* tabnode_modules_version(void) {
  return NODE_STRINGIFY(NODE_MODULE_VERSION);
}
extern "C" __attribute__((export_name("tabnode_napi_version"))) const char* tabnode_napi_version(void) {
  return NODE_STRINGIFY(NODE_API_SUPPORTED_VERSION_MAX);
}
extern "C" __attribute__((export_name("tabnode_simdjson_version"))) const char* tabnode_simdjson_version(void) {
  return SIMDJSON_VERSION;
}
