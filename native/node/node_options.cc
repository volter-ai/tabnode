// NODE'S OPTIONS (Tabnode ADR-0018 §7): Node v24.21.0's command-line options, its option table and its parser, compiled
// from Node's own text as node::Start compiles them into its binary: node_options.h's structs and OptionsParser
// (19-699), node_options-inl.h's AddOption, Implies, Insert and Parse (12-520), and node_options.cc's per_process
// options, every CheckOptions (40-311), the four parsers and their tables (389-1662), and HandleEnvOptions and
// ParseNodeOptionsEnvVar (2171-2240), with node.h's OptionEnvvarSettings (364-371), node_revert.h's Revert (16-78) and
// large_pages/node_large_page.cc's MapStaticCodeToLargePages and LargePagesError (417-462). The build extracts each
// range from Node's tarball (scripts/build-libnode.sh). It is built as Node's Linux binary configures it
// (HAVE_OPENSSL, OpenSSL 3, HAVE_SQLITE, HAVE_AMARO, NODE_USE_V8_PLATFORM, no sandbox, no pointer compression), but
// with neither an inspector nor ICU, as the realm's `config` says (hasInspector and hasIntl false), and with OpenSSL's
// own store as the default root store (NODE_OPENSSL_CERT_STORE, `--openssl-use-def-ca-store`), which is the image's
// bundle (ADR-0016 §4).
//
// What is not Node's text is where V8 stands, and what Node's util.h and node_mutex.h give it, which include V8:
// - CHECK, CHECK_EQ, CHECK_NE and UNREACHABLE abort as util.h's do, and Mutex is node_mutex.h's over a uv_mutex_t.
// - A binding function's call (v8::FunctionCallbackInfo) is the text its answer is written into: the functions
//   node_options.cc's Initialize sets (GetCLIOptionsValues 1685-1805, GetCLIOptionsInfo 1807-1877,
//   GetEnvOptionsInputType 1914-1945, GetNamespaceOptionsInputType 1952-2011, GetOptionsAsFlags 2013-2120) write
//   their values as JSON, in the order Node creates its properties, and the engine's half
//   (src/node-lib/binding/options.ts) makes the objects, Maps and arrays Node makes of them.
// - credentials::SafeGetenv is node_credentials.cc's (74-104) over the process's environment, RealEnvStore's
//   uv_os_getenv, under its refusal in credentials.c.
// - ProcessGlobalArgsInternal and the part of InitializeNodeWithArgsInternal and InitializeOncePerProcessInternal that
//   reads the command line (node.cc:726-818, 832-1008, 1113-1175, 1577-1586) run from `main` before the engine
//   starts. V8::SetFlagsFromCommandLine is the page's engine's, which takes no flag: a word Node's parser hands V8 is
//   taken where Node's table names it (a V8 option of Node's, --stack-trace-limit, an implication's), and refused as
//   Node refuses what V8 does not take (`bad option`) where it does not; the flags ProcessGlobalArgsInternal adds for
//   V8 itself are the page's engine's to decide and are not made. `--v8-options` prints V8's options, of which the
//   page's engine has none.
#include <algorithm>
#include <array>
#include <cerrno>
#include <csignal>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <ranges>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <uv.h>

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
#define UNREACHABLE()                                                     \
  do {                                                                    \
    fprintf(stderr, "%s:%d: Unreachable code reached.\n", __FILE__, __LINE__); \
    fflush(stderr);                                                       \
    abort();                                                              \
  } while (0)

// What node_options.h names of V8: a binding function's call, declared for the parser's friends.
namespace v8 {
class Value {};
template <typename T>
class FunctionCallbackInfo;
}  // namespace v8

extern "C" int tabnode_safe_getenv_refused(void);

namespace node {

#include "node_options_envvar.inc"

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
// taken where Node's table names it (Node hands V8 its V8 options, --stack-trace-limit and its implications' targets),
// its name read as V8 reads a flag's (dashes for underscores, a `no` prefix, a value after `=`), and left for the
// `bad option` where not.
static bool IsV8FlagOfNodes(const std::string& arg) {
  std::string name = arg.substr(0, arg.find('='));
  for (std::string::size_type i = 2; i < name.size(); ++i) {
    if (name[i] == '_') name[i] = '-';
  }
  if (name.starts_with("--no-")) name.erase(2, 3);
  else if (name.starts_with("--no") && _ppop_instance.options_.find("--" + name.substr(4)) != _ppop_instance.options_.end()) {
    name.erase(2, 2);
  }
  return _ppop_instance.options_.find(name) != _ppop_instance.options_.end();
}

// node_options.cc's own close of options_parser (2171), then HandleEnvOptions, ParseNodeOptionsEnvVar and the close
// of node.
#include "node_options_cc_env.inc"

namespace node {

#include "node_large_page.inc"

// ProcessGlobalArgsInternal (node.cc:726-818).
static int ProcessGlobalArgsInternal(std::vector<std::string>* args, std::vector<std::string>* exec_args,
                                     std::vector<std::string>* errors, OptionEnvvarSettings settings) {
  std::vector<std::string> v8_args;

  Mutex::ScopedLock lock(per_process::cli_options_mutex);
  options_parser::Parse(args, exec_args, &v8_args, per_process::cli_options.get(), settings, errors);

  if (!errors->empty()) return 9;  // kInvalidCommandLineArgument

  std::string revert_error;
  for (const std::string& cve : per_process::cli_options->security_reverts) {
    Revert(cve.c_str(), &revert_error);
    if (!revert_error.empty()) {
      errors->emplace_back(std::move(revert_error));
      return 12;  // kInvalidCommandLineArgument2
    }
  }

  if (per_process::cli_options->disable_proto != "delete" && per_process::cli_options->disable_proto != "throw" &&
      per_process::cli_options->disable_proto != "") {
    errors->emplace_back("invalid mode passed to --disable-proto");
    return 12;  // kInvalidCommandLineArgument2
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

  if (remaining.size() > 1) return 9;  // kInvalidCommandLineArgument

  return 0;
}

// The process's arguments once read: the program's name, the script and its arguments (`process.argv`), and the
// options (`process.execArgv`).
static std::vector<std::string> process_args;
static std::vector<std::string> process_exec_args;

}  // namespace node

// InitializeOncePerProcessInternal's reading of the command line (node.cc:1113-1175) over
// InitializeNodeWithArgsInternal's (832-1008), then StartInternal's report of its errors (1577-1586): the environment's
// options, NODE_OPTIONS (only what it allows), the command line, the title it sets; large pages; `--version`,
// `--completion-bash` and `--v8-options`. The exit code where the process ends here (`*early_return` set), else 0.
extern "C" __attribute__((export_name("tabnode_initialize_node_with_args"))) int tabnode_initialize_node_with_args(
    int argc, char** argv, int* early_return) {
  using namespace node;
  CHECK(argc > 0);
  std::vector<std::string> args(argv, argv + argc);
  std::vector<std::string> exec_args;
  std::vector<std::string> errors;
  *early_return = 0;
  int exit_code = 0;

  per_process::cli_options->cmdline = args;
  HandleEnvOptions(per_process::cli_options->per_isolate->per_env);

  std::string node_options;
  if (credentials::SafeGetenv("NODE_OPTIONS", &node_options) || !node_options.empty()) {
    std::vector<std::string> env_argv = ParseNodeOptionsEnvVar(node_options, &errors);
    if (!errors.empty()) {
      exit_code = 9;  // kInvalidCommandLineArgument
    } else {
      env_argv.insert(env_argv.begin(), args.at(0));
      exit_code = ProcessGlobalArgsInternal(&env_argv, nullptr, &errors, kAllowedInEnvvar);
    }
  }
  if (exit_code == 0) exit_code = ProcessGlobalArgsInternal(&args, &exec_args, &errors, kDisallowedInEnvvar);
  if (exit_code == 0 && !per_process::cli_options->title.empty()) {
    uv_set_process_title(per_process::cli_options->title.c_str());
  }

  if (exit_code != 0) {
    *early_return = 1;
  } else {
    if (per_process::cli_options->use_largepages == "on" || per_process::cli_options->use_largepages == "silent") {
      int lp_result = MapStaticCodeToLargePages();
      if (per_process::cli_options->use_largepages == "on" && lp_result != 0) {
        errors.emplace_back(LargePagesError(lp_result));
      }
    }
    if (per_process::cli_options->print_version) {
      printf("%s\n", NODE_VERSION);
      *early_return = 1;
    } else if (per_process::cli_options->print_bash_completion) {
      std::string completion = options_parser::GetBashCompletion();
      printf("%s\n", completion.c_str());
      *early_return = 1;
    } else if (per_process::cli_options->print_v8_help) {
      *early_return = 1;
    }
  }

  for (const std::string& error : errors) fprintf(stderr, "%s: %s\n", args.at(0).c_str(), error.c_str());
  fflush(stdout);
  fflush(stderr);
  process_args = std::move(args);
  process_exec_args = std::move(exec_args);
  return exit_code;
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
