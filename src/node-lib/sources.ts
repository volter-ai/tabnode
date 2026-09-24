/**
 * The vendored Node files, by the name Node's own `require` calls each one.
 *
 * Every file here is `nodejs/node` v22.18.0's, byte for byte. None is edited,
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

/** The Node the vendored files come from, reported in `BUILTINS.md`. */
export const NODE_LIB_VERSION = 'v22.18.0';

export const NODE_LIB_SOURCES: Record<string, string> = {
  'internal/navigator': NAVIGATOR,
  path: PATH,
  'net': NET,
  'buffer': BUFFER,
  'internal/buffer': INTERNAL_BUFFER,
  'stream': STREAM,
  'stream/promises': STREAM_PROMISES,
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
};
