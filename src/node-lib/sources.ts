import FAST_UTF8_STREAM from './internal/streams/fast-utf8-stream.js?raw';
/**
 * The vendored Node files, by the name Node's own `require` calls each one.
 *
 * Every file here is `nodejs/node` v24.21.0's, byte for byte. None is edited,
 * ever: a bug in one is fixed by moving the file to a newer Node, and a thing
 * one needs that the engine lacks is supplied by the binding or by a
 * hand-bound internal, never by a change here. Vite's `?raw` reads each as
 * text; `load.ts` evaluates it in the scope Node's `BuiltinModule` gives a
 * builtin.
 */
import NAVIGATOR from './internal/navigator.js?raw';
import PATH from './path.js?raw';
import NET from './net.js?raw';
import BUFFER from './buffer.js?raw';
import INTERNAL_BUFFER from './internal/buffer.js?raw';
import STREAM from './stream.js?raw';
import STREAM_PROMISES from './stream/promises.js?raw';
import STREAM_CONSUMERS from './stream/consumers.js?raw';
import STREAMS_ADD_ABORT_SIGNAL from './internal/streams/add-abort-signal.js?raw';
import STREAMS_COMPOSE from './internal/streams/compose.js?raw';
import STREAMS_DESTROY from './internal/streams/destroy.js?raw';
import STREAMS_DUPLEX from './internal/streams/duplex.js?raw';
import STREAMS_DUPLEXIFY from './internal/streams/duplexify.js?raw';
import STREAMS_DUPLEXPAIR from './internal/streams/duplexpair.js?raw';
import STREAMS_END_OF_STREAM from './internal/streams/end-of-stream.js?raw';
import STREAMS_FROM from './internal/streams/from.js?raw';
import STREAMS_LAZY_TRANSFORM from './internal/streams/lazy_transform.js?raw';
import STREAMS_LEGACY from './internal/streams/legacy.js?raw';
import STREAMS_OPERATORS from './internal/streams/operators.js?raw';
import STREAMS_PASSTHROUGH from './internal/streams/passthrough.js?raw';
import STREAMS_PIPELINE from './internal/streams/pipeline.js?raw';
import STREAMS_READABLE from './internal/streams/readable.js?raw';
import STREAMS_STATE from './internal/streams/state.js?raw';
import STREAMS_TRANSFORM from './internal/streams/transform.js?raw';
import STREAMS_UTILS from './internal/streams/utils.js?raw';
import STREAMS_WRITABLE from './internal/streams/writable.js?raw';
import CHILD_PROCESS from './child_process.js?raw';
import INTERNAL_NET from './internal/net.js?raw';
import DGRAM from './dgram.js?raw';
import INTERNAL_DGRAM from './internal/dgram.js?raw';
import INTERNAL_CHILD_PROCESS from './internal/child_process.js?raw';
import INTERNAL_STREAM_BASE_COMMONS from './internal/stream_base_commons.js?raw';
import INTERNAL_SOCKET_LIST from './internal/socket_list.js?raw';
import INTERNAL_ERRORS from './internal/errors.js?raw';
import INTERNAL_VALIDATORS from './internal/validators.js?raw';
import INTERNAL_ABORT_LISTENER from './internal/events/abort_listener.js?raw';
import INTERNAL_CHILD_PROCESS_SERIALIZATION from './internal/child_process/serialization.js?raw';
import INTERNAL_MODULES_CUSTOMIZATION_HOOKS from './internal/modules/customization_hooks.js?raw';
import INTERNAL_MODULES_TYPESCRIPT from './internal/modules/typescript.js?raw';
import EVENTS from './events.js?raw';
import INTERNAL_CONSTANTS from './internal/constants.js?raw';
import INTERNAL_MIME from './internal/mime.js?raw';
import HTTP from './http.js?raw';
import HTTPS from './https.js?raw';
import TLS from './tls.js?raw';
import TLS_COMMON_LEGACY from './_tls_common.js?raw';
import TLS_WRAP_LEGACY from './_tls_wrap.js?raw';
import INTERNAL_TLS_COMMON from './internal/tls/common.js?raw';
import INTERNAL_TLS_SECURE_CONTEXT from './internal/tls/secure-context.js?raw';
import INTERNAL_TLS_WRAP from './internal/tls/wrap.js?raw';
import INTERNAL_JS_STREAM_SOCKET from './internal/js_stream_socket.js?raw';
import HTTP_COMMON from './_http_common.js?raw';
import HTTP_INCOMING from './_http_incoming.js?raw';
import HTTP_OUTGOING from './_http_outgoing.js?raw';
import HTTP_SERVER from './_http_server.js?raw';
import HTTP_CLIENT from './_http_client.js?raw';
import HTTP_AGENT from './_http_agent.js?raw';
import INTERNAL_HTTP from './internal/http.js?raw';
import INTERNAL_FREELIST from './internal/freelist.js?raw';
import READLINE from './readline.js?raw';
import READLINE_PROMISES from './readline/promises.js?raw';
import INTERNAL_READLINE_CALLBACKS from './internal/readline/callbacks.js?raw';
import INTERNAL_READLINE_EMITKEYPRESSEVENTS from './internal/readline/emitKeypressEvents.js?raw';
import INTERNAL_READLINE_INTERFACE from './internal/readline/interface.js?raw';
import INTERNAL_READLINE_PROMISES from './internal/readline/promises.js?raw';
import INTERNAL_READLINE_UTILS from './internal/readline/utils.js?raw';
import ZLIB from './zlib.js?raw';
import OS from './os.js?raw';
import TTY from './tty.js?raw';
import INTERNAL_TTY from './internal/tty.js?raw';
import ASSERT from './assert.js?raw';
import ASSERT_STRICT from './assert/strict.js?raw';
import QUERYSTRING from './querystring.js?raw';
import PUNYCODE from './punycode.js?raw';
import STRING_DECODER from './string_decoder.js?raw';
import URL_LEGACY from './url.js?raw';
import NODE_CONSTANTS from './constants.js?raw';
import DIAGNOSTICS_CHANNEL from './diagnostics_channel.js?raw';
import INTERNAL_QUERYSTRING from './internal/querystring.js?raw';
import INTERNAL_ASSERTION_ERROR from './internal/assert/assertion_error.js?raw';
import INTERNAL_CALLTRACKER from './internal/assert/calltracker.js?raw';
import INTERNAL_ASSERT_UTILS from './internal/assert/utils.js?raw';
import INTERNAL_MYERS_DIFF from './internal/assert/myers_diff.js?raw';
import FS from './fs.js?raw';
import INTERNAL_FS_UTILS from './internal/fs/utils.js?raw';
import INTERNAL_FS_PROMISES from './internal/fs/promises.js?raw';
import INTERNAL_FS_DIR from './internal/fs/dir.js?raw';
import INTERNAL_FS_WATCHERS from './internal/fs/watchers.js?raw';
import INTERNAL_FS_STREAMS from './internal/fs/streams.js?raw';
import INTERNAL_FS_RIMRAF from './internal/fs/rimraf.js?raw';
import INTERNAL_FS_SYNC_WRITE_STREAM from './internal/fs/sync_write_stream.js?raw';
import INTERNAL_FS_RECURSIVE_WATCH from './internal/fs/recursive_watch.js?raw';
import INTERNAL_FS_GLOB from './internal/fs/glob.js?raw';
import INTERNAL_DEPS_MINIMATCH from './internal/deps/minimatch/index.js?raw';
import INTERNAL_DEPS_UNDICI from './internal/deps/undici/undici.js?raw';
import INTERNAL_WASM_WEB_API from './internal/wasm_web_api.js?raw';
import INTERNAL_FS_READ_CONTEXT from './internal/fs/read/context.js?raw';
import INTERNAL_FS_CP_CP_SYNC from './internal/fs/cp/cp-sync.js?raw';
import INTERNAL_FS_CP_CP from './internal/fs/cp/cp.js?raw';
import INTERNAL_PARSE_ARGS from './internal/util/parse_args/parse_args.js?raw';
import INTERNAL_PARSE_ARGS_UTILS from './internal/util/parse_args/utils.js?raw';
import UTIL from './util.js?raw';
import INTERNAL_UTIL from './internal/util.js?raw';
import INTERNAL_UTIL_INSPECT from './internal/util/inspect.js?raw';
import INTERNAL_UTIL_COMPARISONS from './internal/util/comparisons.js?raw';
import INTERNAL_UTIL_DEBUGLOG from './internal/util/debuglog.js?raw';
import INTERNAL_UTIL_COLORS from './internal/util/colors.js?raw';
import INTERNAL_FIXED_QUEUE from './internal/fixed_queue.js?raw';
import INTERNAL_EVENTS_SYMBOLS from './internal/events/symbols.js?raw';
import INTERNAL_REPL_HISTORY from './internal/repl/history.js?raw';
import TIMERS from './timers.js?raw';
import TIMERS_PROMISES from './timers/promises.js?raw';
import INTERNAL_TIMERS from './internal/timers.js?raw';
import INTERNAL_LINKEDLIST from './internal/linkedlist.js?raw';
import INTERNAL_PRIORITY_QUEUE from './internal/priority_queue.js?raw';
import INTERNAL_ASYNC_CONTEXT_FRAME from './internal/async_context_frame.js?raw';
import INTERNAL_ALS_ASYNC_CONTEXT_FRAME from './internal/async_local_storage/async_context_frame.js?raw';
import INTERNAL_ALS_RUN_SCOPE from './internal/async_local_storage/run_scope.js?raw';
import INTERNAL_PROCESS_SIGNAL from './internal/process/signal.js?raw';
import INTERNAL_WORKER_IO from './internal/worker/io.js?raw';
import INTERNAL_PER_CONTEXT_MESSAGEPORT from './internal/per_context/messageport.js?raw';
import INTERNAL_EVENT_TARGET from './internal/event_target.js?raw';
import INTERNAL_WEBIDL from './internal/webidl.js?raw';
import INTERNAL_PERF_UTILS from './internal/perf/utils.js?raw';
import CRYPTO from './crypto.js?raw';
import INTERNAL_CRYPTO_AES from './internal/crypto/aes.js?raw';
import INTERNAL_CRYPTO_ARGON2 from './internal/crypto/argon2.js?raw';
import INTERNAL_CRYPTO_CERTIFICATE from './internal/crypto/certificate.js?raw';
import INTERNAL_CRYPTO_CFRG from './internal/crypto/cfrg.js?raw';
import INTERNAL_CRYPTO_CHACHA20_POLY1305 from './internal/crypto/chacha20_poly1305.js?raw';
import INTERNAL_CRYPTO_CIPHER from './internal/crypto/cipher.js?raw';
import INTERNAL_CRYPTO_DIFFIEHELLMAN from './internal/crypto/diffiehellman.js?raw';
import INTERNAL_CRYPTO_EC from './internal/crypto/ec.js?raw';
import INTERNAL_CRYPTO_HASH from './internal/crypto/hash.js?raw';
import INTERNAL_CRYPTO_HASHNAMES from './internal/crypto/hashnames.js?raw';
import INTERNAL_CRYPTO_HKDF from './internal/crypto/hkdf.js?raw';
import INTERNAL_CRYPTO_KEM from './internal/crypto/kem.js?raw';
import INTERNAL_CRYPTO_KEYGEN from './internal/crypto/keygen.js?raw';
import INTERNAL_CRYPTO_KEYS from './internal/crypto/keys.js?raw';
import INTERNAL_CRYPTO_MAC from './internal/crypto/mac.js?raw';
import INTERNAL_CRYPTO_ML_DSA from './internal/crypto/ml_dsa.js?raw';
import INTERNAL_CRYPTO_ML_KEM from './internal/crypto/ml_kem.js?raw';
import INTERNAL_CRYPTO_PBKDF2 from './internal/crypto/pbkdf2.js?raw';
import INTERNAL_CRYPTO_RANDOM from './internal/crypto/random.js?raw';
import INTERNAL_CRYPTO_RSA from './internal/crypto/rsa.js?raw';
import INTERNAL_CRYPTO_SCRYPT from './internal/crypto/scrypt.js?raw';
import INTERNAL_CRYPTO_SIG from './internal/crypto/sig.js?raw';
import INTERNAL_CRYPTO_UTIL from './internal/crypto/util.js?raw';
import INTERNAL_CRYPTO_WEBCRYPTO from './internal/crypto/webcrypto.js?raw';
import INTERNAL_CRYPTO_WEBCRYPTO_UTIL from './internal/crypto/webcrypto_util.js?raw';
import INTERNAL_CRYPTO_WEBIDL from './internal/crypto/webidl.js?raw';
import INTERNAL_CRYPTO_X509 from './internal/crypto/x509.js?raw';

import INTERNAL_STREAMS_ITER_TYPES from './internal/streams/iter/types.js?raw';

import INTERNAL_STREAMS_ITER_CONSUMERS from './internal/streams/iter/consumers.js?raw';

import INTERNAL_STREAMS_ITER_RINGBUFFER from './internal/streams/iter/ringbuffer.js?raw';

import INTERNAL_STREAMS_ITER_PULL from './internal/streams/iter/pull.js?raw';

import INTERNAL_STREAMS_ITER_BROADCAST from './internal/streams/iter/broadcast.js?raw';

import INTERNAL_STREAMS_ITER_FROM from './internal/streams/iter/from.js?raw';

import INTERNAL_STREAMS_ITER_PUSH from './internal/streams/iter/push.js?raw';

import INTERNAL_STREAMS_ITER_UTILS from './internal/streams/iter/utils.js?raw';

import INTERNAL_STREAMS_ITER_TRANSFORM from './internal/streams/iter/transform.js?raw';

import INTERNAL_STREAMS_ITER_DUPLEX from './internal/streams/iter/duplex.js?raw';

import INTERNAL_STREAMS_ITER_CLASSIC from './internal/streams/iter/classic.js?raw';

import INTERNAL_STREAMS_ITER_SHARE from './internal/streams/iter/share.js?raw';

import INTERNAL_ERRORS_ERROR_SOURCE from './internal/errors/error_source.js?raw';

// Node's bootstrap and what it loads where the realm's process is `node` (ADR-0018 §7).
import BOOTSTRAP_BOOTSTRAP_REALM from './internal/bootstrap/realm.js?raw';
import BOOTSTRAP_BOOTSTRAP_NODE from './internal/bootstrap/node.js?raw';
import BOOTSTRAP_BOOTSTRAP_WEB_EXPOSED_WILDCARD from './internal/bootstrap/web/exposed-wildcard.js?raw';
import BOOTSTRAP_BOOTSTRAP_WEB_EXPOSED_WINDOW_OR_WORKER from './internal/bootstrap/web/exposed-window-or-worker.js?raw';
import BOOTSTRAP_BOOTSTRAP_SWITCHES_IS_MAIN_THREAD from './internal/bootstrap/switches/is_main_thread.js?raw';
import BOOTSTRAP_BOOTSTRAP_SWITCHES_DOES_OWN_PROCESS_STATE from './internal/bootstrap/switches/does_own_process_state.js?raw';
import BOOTSTRAP_PER_CONTEXT_DOMEXCEPTION from './internal/per_context/domexception.js?raw';
import BOOTSTRAP_PROCESS_PER_THREAD from './internal/process/per_thread.js?raw';
import BOOTSTRAP_PROCESS_TASK_QUEUES from './internal/process/task_queues.js?raw';
import BOOTSTRAP_PROCESS_PROMISES from './internal/process/promises.js?raw';
import BOOTSTRAP_PROCESS_EXECUTION from './internal/process/execution.js?raw';
import BOOTSTRAP_PROCESS_WARNING from './internal/process/warning.js?raw';
import BOOTSTRAP_PROCESS_PRE_EXECUTION from './internal/process/pre_execution.js?raw';
import BOOTSTRAP_PROCESS_PERMISSION from './internal/process/permission.js?raw';
import BOOTSTRAP_PROCESS_FINALIZATION from './internal/process/finalization.js?raw';
import BOOTSTRAP_PROCESS_REPORT from './internal/process/report.js?raw';
import BOOTSTRAP_ASYNC_HOOKS from './internal/async_hooks.js?raw';
import BOOTSTRAP_PROMISE_HOOKS from './internal/promise_hooks.js?raw';
import BOOTSTRAP_ASYNC_LOCAL_STORAGE_ASYNC_HOOKS from './internal/async_local_storage/async_hooks.js?raw';
import BOOTSTRAP_TRACE_EVENTS_ASYNC_HOOKS from './internal/trace_events_async_hooks.js?raw';
import BOOTSTRAP_CONSOLE_CONSTRUCTOR from './internal/console/constructor.js?raw';
import BOOTSTRAP_CONSOLE_GLOBAL from './internal/console/global.js?raw';
import BOOTSTRAP_CLI_TABLE from './internal/cli_table.js?raw';
import BOOTSTRAP_OPTIONS from './internal/options.js?raw';
import BOOTSTRAP_WORKER_JS_TRANSFERABLE from './internal/worker/js_transferable.js?raw';
import BOOTSTRAP_V8_STARTUP_SNAPSHOT from './internal/v8/startup_snapshot.js?raw';
import BOOTSTRAP_MODULES_HELPERS from './internal/modules/helpers.js?raw';
import BOOTSTRAP_SOURCE_MAP_SOURCE_MAP_CACHE from './internal/source_map/source_map_cache.js?raw';
import BOOTSTRAP_SOURCE_MAP_SOURCE_MAP_CACHE_MAP from './internal/source_map/source_map_cache_map.js?raw';
import BOOTSTRAP_SOURCE_MAP_PREPARE_STACK_TRACE from './internal/source_map/prepare_stack_trace.js?raw';
import BOOTSTRAP_SOURCE_MAP_SOURCE_MAP from './internal/source_map/source_map.js?raw';
import BOOTSTRAP_ASSERT from './internal/assert.js?raw';
import BOOTSTRAP_VM from './internal/vm.js?raw';
import BOOTSTRAP_DNS_UTILS from './internal/dns/utils.js?raw';
import BOOTSTRAP_MODULES_CJS_LOADER from './internal/modules/cjs/loader.js?raw';
import BOOTSTRAP_MODULES_ESM_LOADER from './internal/modules/esm/loader.js?raw';
import BOOTSTRAP_MODULES_ESM_UTILS from './internal/modules/esm/utils.js?raw';
import BOOTSTRAP_MODULES_ESM_ASSERT from './internal/modules/esm/assert.js?raw';
import BOOTSTRAP_MODULES_ESM_GET_FORMAT from './internal/modules/esm/get_format.js?raw';
import BOOTSTRAP_MODULES_ESM_LOAD from './internal/modules/esm/load.js?raw';
import BOOTSTRAP_MODULES_ESM_MODULE_JOB from './internal/modules/esm/module_job.js?raw';
import BOOTSTRAP_MODULES_ESM_MODULE_MAP from './internal/modules/esm/module_map.js?raw';
import BOOTSTRAP_MODULES_ESM_RESOLVE from './internal/modules/esm/resolve.js?raw';
import BOOTSTRAP_MODULES_ESM_TRANSLATORS from './internal/modules/esm/translators.js?raw';
import BOOTSTRAP_MODULES_ESM_HOOKS from './internal/modules/esm/hooks.js?raw';
import BOOTSTRAP_MODULES_ESM_INITIALIZE_IMPORT_META from './internal/modules/esm/initialize_import_meta.js?raw';
import BOOTSTRAP_MODULES_ESM_CREATE_DYNAMIC_MODULE from './internal/modules/esm/create_dynamic_module.js?raw';
import BOOTSTRAP_MODULES_ESM_SHARED_CONSTANTS from './internal/modules/esm/shared_constants.js?raw';
import BOOTSTRAP_MODULES_RUN_MAIN from './internal/modules/run_main.js?raw';
import BOOTSTRAP_MODULES_PACKAGE_JSON_READER from './internal/modules/package_json_reader.js?raw';
import BOOTSTRAP_MODULES_PACKAGE_MAP from './internal/modules/package_map.js?raw';
import BOOTSTRAP_DATA_URL from './internal/data_url.js?raw';
import BOOTSTRAP_ABORT_CONTROLLER from './internal/abort_controller.js?raw';
import BOOTSTRAP_UTIL_TRACE_SIGINT from './internal/util/trace_sigint.js?raw';
import BOOTSTRAP_FREEZE_INTRINSICS from './internal/freeze_intrinsics.js?raw';

/** The Node the vendored files come from, reported in `BUILTINS.md`. */
export const NODE_LIB_VERSION = 'v24.21.0';

export const NODE_LIB_SOURCES: Record<string, string> = {
  'internal/bootstrap/realm': BOOTSTRAP_BOOTSTRAP_REALM,
  'internal/bootstrap/node': BOOTSTRAP_BOOTSTRAP_NODE,
  'internal/bootstrap/web/exposed-wildcard': BOOTSTRAP_BOOTSTRAP_WEB_EXPOSED_WILDCARD,
  'internal/bootstrap/web/exposed-window-or-worker': BOOTSTRAP_BOOTSTRAP_WEB_EXPOSED_WINDOW_OR_WORKER,
  'internal/bootstrap/switches/is_main_thread': BOOTSTRAP_BOOTSTRAP_SWITCHES_IS_MAIN_THREAD,
  'internal/bootstrap/switches/does_own_process_state': BOOTSTRAP_BOOTSTRAP_SWITCHES_DOES_OWN_PROCESS_STATE,
  'internal/per_context/domexception': BOOTSTRAP_PER_CONTEXT_DOMEXCEPTION,
  'internal/process/per_thread': BOOTSTRAP_PROCESS_PER_THREAD,
  'internal/process/task_queues': BOOTSTRAP_PROCESS_TASK_QUEUES,
  'internal/process/promises': BOOTSTRAP_PROCESS_PROMISES,
  'internal/process/execution': BOOTSTRAP_PROCESS_EXECUTION,
  'internal/process/warning': BOOTSTRAP_PROCESS_WARNING,
  'internal/process/pre_execution': BOOTSTRAP_PROCESS_PRE_EXECUTION,
  'internal/process/permission': BOOTSTRAP_PROCESS_PERMISSION,
  'internal/process/finalization': BOOTSTRAP_PROCESS_FINALIZATION,
  'internal/process/report': BOOTSTRAP_PROCESS_REPORT,
  'internal/async_hooks': BOOTSTRAP_ASYNC_HOOKS,
  'internal/promise_hooks': BOOTSTRAP_PROMISE_HOOKS,
  'internal/async_local_storage/async_hooks': BOOTSTRAP_ASYNC_LOCAL_STORAGE_ASYNC_HOOKS,
  'internal/trace_events_async_hooks': BOOTSTRAP_TRACE_EVENTS_ASYNC_HOOKS,
  'internal/console/constructor': BOOTSTRAP_CONSOLE_CONSTRUCTOR,
  'internal/console/global': BOOTSTRAP_CONSOLE_GLOBAL,
  'internal/cli_table': BOOTSTRAP_CLI_TABLE,
  'internal/options': BOOTSTRAP_OPTIONS,
  'internal/worker/js_transferable': BOOTSTRAP_WORKER_JS_TRANSFERABLE,
  'internal/v8/startup_snapshot': BOOTSTRAP_V8_STARTUP_SNAPSHOT,
  'internal/modules/helpers': BOOTSTRAP_MODULES_HELPERS,
  'internal/source_map/source_map_cache': BOOTSTRAP_SOURCE_MAP_SOURCE_MAP_CACHE,
  'internal/source_map/source_map_cache_map': BOOTSTRAP_SOURCE_MAP_SOURCE_MAP_CACHE_MAP,
  'internal/source_map/prepare_stack_trace': BOOTSTRAP_SOURCE_MAP_PREPARE_STACK_TRACE,
  'internal/source_map/source_map': BOOTSTRAP_SOURCE_MAP_SOURCE_MAP,
  'internal/assert': BOOTSTRAP_ASSERT,
  'internal/vm': BOOTSTRAP_VM,
  'internal/dns/utils': BOOTSTRAP_DNS_UTILS,
  'internal/modules/cjs/loader': BOOTSTRAP_MODULES_CJS_LOADER,
  'internal/modules/esm/loader': BOOTSTRAP_MODULES_ESM_LOADER,
  'internal/modules/esm/utils': BOOTSTRAP_MODULES_ESM_UTILS,
  'internal/modules/esm/assert': BOOTSTRAP_MODULES_ESM_ASSERT,
  'internal/modules/esm/get_format': BOOTSTRAP_MODULES_ESM_GET_FORMAT,
  'internal/modules/esm/load': BOOTSTRAP_MODULES_ESM_LOAD,
  'internal/modules/esm/module_job': BOOTSTRAP_MODULES_ESM_MODULE_JOB,
  'internal/modules/esm/module_map': BOOTSTRAP_MODULES_ESM_MODULE_MAP,
  'internal/modules/esm/resolve': BOOTSTRAP_MODULES_ESM_RESOLVE,
  'internal/modules/esm/translators': BOOTSTRAP_MODULES_ESM_TRANSLATORS,
  'internal/modules/esm/hooks': BOOTSTRAP_MODULES_ESM_HOOKS,
  'internal/modules/esm/initialize_import_meta': BOOTSTRAP_MODULES_ESM_INITIALIZE_IMPORT_META,
  'internal/modules/esm/create_dynamic_module': BOOTSTRAP_MODULES_ESM_CREATE_DYNAMIC_MODULE,
  'internal/modules/esm/shared_constants': BOOTSTRAP_MODULES_ESM_SHARED_CONSTANTS,
  'internal/modules/run_main': BOOTSTRAP_MODULES_RUN_MAIN,
  'internal/modules/package_json_reader': BOOTSTRAP_MODULES_PACKAGE_JSON_READER,
  'internal/modules/package_map': BOOTSTRAP_MODULES_PACKAGE_MAP,
  'internal/data_url': BOOTSTRAP_DATA_URL,
  'internal/abort_controller': BOOTSTRAP_ABORT_CONTROLLER,
  'internal/util/trace_sigint': BOOTSTRAP_UTIL_TRACE_SIGINT,
  'internal/freeze_intrinsics': BOOTSTRAP_FREEZE_INTRINSICS,
  'internal/streams/fast-utf8-stream': FAST_UTF8_STREAM,
  'internal/errors/error_source': INTERNAL_ERRORS_ERROR_SOURCE,
  'internal/streams/iter/share': INTERNAL_STREAMS_ITER_SHARE,
  'internal/streams/iter/classic': INTERNAL_STREAMS_ITER_CLASSIC,
  'internal/streams/iter/duplex': INTERNAL_STREAMS_ITER_DUPLEX,
  'internal/streams/iter/transform': INTERNAL_STREAMS_ITER_TRANSFORM,
  'internal/streams/iter/utils': INTERNAL_STREAMS_ITER_UTILS,
  'internal/streams/iter/push': INTERNAL_STREAMS_ITER_PUSH,
  'internal/streams/iter/from': INTERNAL_STREAMS_ITER_FROM,
  'internal/streams/iter/broadcast': INTERNAL_STREAMS_ITER_BROADCAST,
  'internal/streams/iter/pull': INTERNAL_STREAMS_ITER_PULL,
  'internal/streams/iter/ringbuffer': INTERNAL_STREAMS_ITER_RINGBUFFER,
  'internal/streams/iter/consumers': INTERNAL_STREAMS_ITER_CONSUMERS,
  'internal/streams/iter/types': INTERNAL_STREAMS_ITER_TYPES,
  'internal/navigator': NAVIGATOR,
  path: PATH,
  'net': NET,
  'buffer': BUFFER,
  'internal/buffer': INTERNAL_BUFFER,
  'stream': STREAM,
  'stream/promises': STREAM_PROMISES,
  'stream/consumers': STREAM_CONSUMERS,
  'internal/streams/add-abort-signal': STREAMS_ADD_ABORT_SIGNAL,
  'internal/streams/compose': STREAMS_COMPOSE,
  'internal/streams/destroy': STREAMS_DESTROY,
  'internal/streams/duplex': STREAMS_DUPLEX,
  'internal/streams/duplexify': STREAMS_DUPLEXIFY,
  'internal/streams/duplexpair': STREAMS_DUPLEXPAIR,
  'internal/streams/end-of-stream': STREAMS_END_OF_STREAM,
  'internal/streams/from': STREAMS_FROM,
  'internal/streams/lazy_transform': STREAMS_LAZY_TRANSFORM,
  'internal/streams/legacy': STREAMS_LEGACY,
  'internal/streams/operators': STREAMS_OPERATORS,
  'internal/streams/passthrough': STREAMS_PASSTHROUGH,
  'internal/streams/pipeline': STREAMS_PIPELINE,
  'internal/streams/readable': STREAMS_READABLE,
  'internal/streams/state': STREAMS_STATE,
  'internal/streams/transform': STREAMS_TRANSFORM,
  'internal/streams/utils': STREAMS_UTILS,
  'internal/streams/writable': STREAMS_WRITABLE,
  'child_process': CHILD_PROCESS,
  'internal/net': INTERNAL_NET,
  'dgram': DGRAM,
  'internal/dgram': INTERNAL_DGRAM,
  'internal/child_process': INTERNAL_CHILD_PROCESS,
  'internal/stream_base_commons': INTERNAL_STREAM_BASE_COMMONS,
  'internal/socket_list': INTERNAL_SOCKET_LIST,
  'internal/errors': INTERNAL_ERRORS,
  'internal/validators': INTERNAL_VALIDATORS,
  'internal/events/abort_listener': INTERNAL_ABORT_LISTENER,
  'internal/child_process/serialization': INTERNAL_CHILD_PROCESS_SERIALIZATION,
  'internal/modules/customization_hooks': INTERNAL_MODULES_CUSTOMIZATION_HOOKS,
  'internal/modules/typescript': INTERNAL_MODULES_TYPESCRIPT,
  'events': EVENTS,
  'internal/constants': INTERNAL_CONSTANTS,
  'internal/mime': INTERNAL_MIME,
  'http': HTTP,
  'https': HTTPS,
  'tls': TLS,
  '_tls_common': TLS_COMMON_LEGACY,
  '_tls_wrap': TLS_WRAP_LEGACY,
  'internal/tls/common': INTERNAL_TLS_COMMON,
  'internal/tls/secure-context': INTERNAL_TLS_SECURE_CONTEXT,
  'internal/tls/wrap': INTERNAL_TLS_WRAP,
  'internal/js_stream_socket': INTERNAL_JS_STREAM_SOCKET,
  '_http_common': HTTP_COMMON,
  '_http_incoming': HTTP_INCOMING,
  '_http_outgoing': HTTP_OUTGOING,
  '_http_server': HTTP_SERVER,
  '_http_client': HTTP_CLIENT,
  '_http_agent': HTTP_AGENT,
  'internal/http': INTERNAL_HTTP,
  'internal/freelist': INTERNAL_FREELIST,
  'readline': READLINE,
  'readline/promises': READLINE_PROMISES,
  'internal/readline/callbacks': INTERNAL_READLINE_CALLBACKS,
  'internal/readline/emitKeypressEvents': INTERNAL_READLINE_EMITKEYPRESSEVENTS,
  'internal/readline/interface': INTERNAL_READLINE_INTERFACE,
  'internal/readline/promises': INTERNAL_READLINE_PROMISES,
  'internal/readline/utils': INTERNAL_READLINE_UTILS,
  'zlib': ZLIB,
  'os': OS,
  'tty': TTY,
  'internal/tty': INTERNAL_TTY,
  'assert': ASSERT,
  'assert/strict': ASSERT_STRICT,
  'querystring': QUERYSTRING,
  'punycode': PUNYCODE,
  'string_decoder': STRING_DECODER,
  'url': URL_LEGACY,
  'constants': NODE_CONSTANTS,
  'diagnostics_channel': DIAGNOSTICS_CHANNEL,
  'internal/querystring': INTERNAL_QUERYSTRING,
  'internal/assert/assertion_error': INTERNAL_ASSERTION_ERROR,
  'internal/assert/calltracker': INTERNAL_CALLTRACKER,
  'internal/assert/utils': INTERNAL_ASSERT_UTILS,
  'internal/assert/myers_diff': INTERNAL_MYERS_DIFF,
  'fs': FS,
  'internal/fs/utils': INTERNAL_FS_UTILS,
  'internal/fs/promises': INTERNAL_FS_PROMISES,
  'internal/fs/dir': INTERNAL_FS_DIR,
  'internal/fs/watchers': INTERNAL_FS_WATCHERS,
  'internal/fs/streams': INTERNAL_FS_STREAMS,
  'internal/fs/rimraf': INTERNAL_FS_RIMRAF,
  'internal/fs/sync_write_stream': INTERNAL_FS_SYNC_WRITE_STREAM,
  'internal/fs/recursive_watch': INTERNAL_FS_RECURSIVE_WATCH,
  'internal/fs/glob': INTERNAL_FS_GLOB,
  'internal/deps/minimatch/index': INTERNAL_DEPS_MINIMATCH,
  'internal/deps/undici/undici': INTERNAL_DEPS_UNDICI,
  'internal/wasm_web_api': INTERNAL_WASM_WEB_API,
  'internal/fs/read/context': INTERNAL_FS_READ_CONTEXT,
  'internal/fs/cp/cp-sync': INTERNAL_FS_CP_CP_SYNC,
  'internal/fs/cp/cp': INTERNAL_FS_CP_CP,
  'internal/util/parse_args/parse_args': INTERNAL_PARSE_ARGS,
  'internal/util/parse_args/utils': INTERNAL_PARSE_ARGS_UTILS,
  'util': UTIL,
  'internal/util': INTERNAL_UTIL,
  'internal/util/inspect': INTERNAL_UTIL_INSPECT,
  'internal/util/comparisons': INTERNAL_UTIL_COMPARISONS,
  'internal/util/debuglog': INTERNAL_UTIL_DEBUGLOG,
  'internal/util/colors': INTERNAL_UTIL_COLORS,
  'internal/fixed_queue': INTERNAL_FIXED_QUEUE,
  'internal/events/symbols': INTERNAL_EVENTS_SYMBOLS,
  'internal/repl/history': INTERNAL_REPL_HISTORY,
  'timers': TIMERS,
  'timers/promises': TIMERS_PROMISES,
  'internal/timers': INTERNAL_TIMERS,
  'internal/linkedlist': INTERNAL_LINKEDLIST,
  'internal/priority_queue': INTERNAL_PRIORITY_QUEUE,
  'internal/async_context_frame': INTERNAL_ASYNC_CONTEXT_FRAME,
  'internal/async_local_storage/async_context_frame': INTERNAL_ALS_ASYNC_CONTEXT_FRAME,
  'internal/async_local_storage/run_scope': INTERNAL_ALS_RUN_SCOPE,
  'internal/process/signal': INTERNAL_PROCESS_SIGNAL,
  'internal/worker/io': INTERNAL_WORKER_IO,
  'internal/per_context/messageport': INTERNAL_PER_CONTEXT_MESSAGEPORT,
  'internal/event_target': INTERNAL_EVENT_TARGET,
  'internal/webidl': INTERNAL_WEBIDL,
  'internal/perf/utils': INTERNAL_PERF_UTILS,
  'crypto': CRYPTO,
  'internal/crypto/aes': INTERNAL_CRYPTO_AES,
  'internal/crypto/argon2': INTERNAL_CRYPTO_ARGON2,
  'internal/crypto/certificate': INTERNAL_CRYPTO_CERTIFICATE,
  'internal/crypto/cfrg': INTERNAL_CRYPTO_CFRG,
  'internal/crypto/chacha20_poly1305': INTERNAL_CRYPTO_CHACHA20_POLY1305,
  'internal/crypto/cipher': INTERNAL_CRYPTO_CIPHER,
  'internal/crypto/diffiehellman': INTERNAL_CRYPTO_DIFFIEHELLMAN,
  'internal/crypto/ec': INTERNAL_CRYPTO_EC,
  'internal/crypto/hash': INTERNAL_CRYPTO_HASH,
  'internal/crypto/hashnames': INTERNAL_CRYPTO_HASHNAMES,
  'internal/crypto/hkdf': INTERNAL_CRYPTO_HKDF,
  'internal/crypto/kem': INTERNAL_CRYPTO_KEM,
  'internal/crypto/keygen': INTERNAL_CRYPTO_KEYGEN,
  'internal/crypto/keys': INTERNAL_CRYPTO_KEYS,
  'internal/crypto/mac': INTERNAL_CRYPTO_MAC,
  'internal/crypto/ml_dsa': INTERNAL_CRYPTO_ML_DSA,
  'internal/crypto/ml_kem': INTERNAL_CRYPTO_ML_KEM,
  'internal/crypto/pbkdf2': INTERNAL_CRYPTO_PBKDF2,
  'internal/crypto/random': INTERNAL_CRYPTO_RANDOM,
  'internal/crypto/rsa': INTERNAL_CRYPTO_RSA,
  'internal/crypto/scrypt': INTERNAL_CRYPTO_SCRYPT,
  'internal/crypto/sig': INTERNAL_CRYPTO_SIG,
  'internal/crypto/util': INTERNAL_CRYPTO_UTIL,
  'internal/crypto/webcrypto': INTERNAL_CRYPTO_WEBCRYPTO,
  'internal/crypto/webcrypto_util': INTERNAL_CRYPTO_WEBCRYPTO_UTIL,
  'internal/crypto/webidl': INTERNAL_CRYPTO_WEBIDL,
  'internal/crypto/x509': INTERNAL_CRYPTO_X509,
};
