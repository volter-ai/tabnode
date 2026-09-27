/**
 * The vendored Node files, by the name Node's own `require` calls each one.
 *
 * Every file here is `nodejs/node` v22.18.0's, byte for byte. None is edited,
 * ever: a bug in one is fixed by moving the file to a newer Node, and a thing
 * one needs that the engine lacks is supplied by the binding or by a
 * hand-bound internal, never by a change here. `?lazytext` (scripts/lazy-text-plugin.mjs)
 * reads each as a function returning its text; `load.ts` evaluates it in the scope Node's `BuiltinModule` gives a
 * builtin.
 */
import NAVIGATOR from './internal/navigator.js?lazytext';
import PATH from './path.js?lazytext';
import NET from './net.js?lazytext';
import BUFFER from './buffer.js?lazytext';
import INTERNAL_BUFFER from './internal/buffer.js?lazytext';
import STREAM from './stream.js?lazytext';
import STREAM_PROMISES from './stream/promises.js?lazytext';
import STREAMS_ADD_ABORT_SIGNAL from './internal/streams/add-abort-signal.js?lazytext';
import STREAMS_COMPOSE from './internal/streams/compose.js?lazytext';
import STREAMS_DESTROY from './internal/streams/destroy.js?lazytext';
import STREAMS_DUPLEX from './internal/streams/duplex.js?lazytext';
import STREAMS_DUPLEXIFY from './internal/streams/duplexify.js?lazytext';
import STREAMS_DUPLEXPAIR from './internal/streams/duplexpair.js?lazytext';
import STREAMS_END_OF_STREAM from './internal/streams/end-of-stream.js?lazytext';
import STREAMS_FROM from './internal/streams/from.js?lazytext';
import STREAMS_LAZY_TRANSFORM from './internal/streams/lazy_transform.js?lazytext';
import STREAMS_LEGACY from './internal/streams/legacy.js?lazytext';
import STREAMS_OPERATORS from './internal/streams/operators.js?lazytext';
import STREAMS_PASSTHROUGH from './internal/streams/passthrough.js?lazytext';
import STREAMS_PIPELINE from './internal/streams/pipeline.js?lazytext';
import STREAMS_READABLE from './internal/streams/readable.js?lazytext';
import STREAMS_STATE from './internal/streams/state.js?lazytext';
import STREAMS_TRANSFORM from './internal/streams/transform.js?lazytext';
import STREAMS_UTILS from './internal/streams/utils.js?lazytext';
import STREAMS_WRITABLE from './internal/streams/writable.js?lazytext';
import CHILD_PROCESS from './child_process.js?lazytext';
import INTERNAL_NET from './internal/net.js?lazytext';
import INTERNAL_CHILD_PROCESS from './internal/child_process.js?lazytext';
import INTERNAL_STREAM_BASE_COMMONS from './internal/stream_base_commons.js?lazytext';
import INTERNAL_SOCKET_LIST from './internal/socket_list.js?lazytext';
import INTERNAL_ERRORS from './internal/errors.js?lazytext';
import INTERNAL_VALIDATORS from './internal/validators.js?lazytext';
import INTERNAL_ABORT_LISTENER from './internal/events/abort_listener.js?lazytext';
import INTERNAL_CHILD_PROCESS_SERIALIZATION from './internal/child_process/serialization.js?lazytext';
import INTERNAL_MODULES_CUSTOMIZATION_HOOKS from './internal/modules/customization_hooks.js?lazytext';
import INTERNAL_MODULES_TYPESCRIPT from './internal/modules/typescript.js?lazytext';
import EVENTS from './events.js?lazytext';
import INTERNAL_CONSTANTS from './internal/constants.js?lazytext';
import INTERNAL_MIME from './internal/mime.js?lazytext';
import HTTP from './http.js?lazytext';
import HTTPS from './https.js?lazytext';
import HTTP_COMMON from './_http_common.js?lazytext';
import HTTP_INCOMING from './_http_incoming.js?lazytext';
import HTTP_OUTGOING from './_http_outgoing.js?lazytext';
import HTTP_SERVER from './_http_server.js?lazytext';
import HTTP_CLIENT from './_http_client.js?lazytext';
import HTTP_AGENT from './_http_agent.js?lazytext';
import INTERNAL_HTTP from './internal/http.js?lazytext';
import INTERNAL_FREELIST from './internal/freelist.js?lazytext';
import READLINE from './readline.js?lazytext';
import READLINE_PROMISES from './readline/promises.js?lazytext';
import INTERNAL_READLINE_CALLBACKS from './internal/readline/callbacks.js?lazytext';
import INTERNAL_READLINE_EMITKEYPRESSEVENTS from './internal/readline/emitKeypressEvents.js?lazytext';
import INTERNAL_READLINE_INTERFACE from './internal/readline/interface.js?lazytext';
import INTERNAL_READLINE_PROMISES from './internal/readline/promises.js?lazytext';
import INTERNAL_READLINE_UTILS from './internal/readline/utils.js?lazytext';
import ZLIB from './zlib.js?lazytext';
import OS from './os.js?lazytext';
import TTY from './tty.js?lazytext';
import INTERNAL_TTY from './internal/tty.js?lazytext';
import ASSERT from './assert.js?lazytext';
import ASSERT_STRICT from './assert/strict.js?lazytext';
import QUERYSTRING from './querystring.js?lazytext';
import PUNYCODE from './punycode.js?lazytext';
import NODE_CONSTANTS from './constants.js?lazytext';
import DIAGNOSTICS_CHANNEL from './diagnostics_channel.js?lazytext';
import INTERNAL_QUERYSTRING from './internal/querystring.js?lazytext';
import INTERNAL_ASSERTION_ERROR from './internal/assert/assertion_error.js?lazytext';
import INTERNAL_CALLTRACKER from './internal/assert/calltracker.js?lazytext';
import INTERNAL_ASSERT_UTILS from './internal/assert/utils.js?lazytext';
import INTERNAL_MYERS_DIFF from './internal/assert/myers_diff.js?lazytext';
import FS from './fs.js?lazytext';
import INTERNAL_FS_UTILS from './internal/fs/utils.js?lazytext';
import INTERNAL_FS_PROMISES from './internal/fs/promises.js?lazytext';
import INTERNAL_FS_DIR from './internal/fs/dir.js?lazytext';
import INTERNAL_FS_WATCHERS from './internal/fs/watchers.js?lazytext';
import INTERNAL_FS_STREAMS from './internal/fs/streams.js?lazytext';
import INTERNAL_FS_RIMRAF from './internal/fs/rimraf.js?lazytext';
import INTERNAL_FS_SYNC_WRITE_STREAM from './internal/fs/sync_write_stream.js?lazytext';
import INTERNAL_FS_RECURSIVE_WATCH from './internal/fs/recursive_watch.js?lazytext';
import INTERNAL_FS_GLOB from './internal/fs/glob.js?lazytext';
import INTERNAL_DEPS_MINIMATCH from './internal/deps/minimatch/index.js?lazytext';
import INTERNAL_FS_READ_CONTEXT from './internal/fs/read/context.js?lazytext';
import INTERNAL_FS_CP_CP_SYNC from './internal/fs/cp/cp-sync.js?lazytext';
import INTERNAL_FS_CP_CP from './internal/fs/cp/cp.js?lazytext';
import INTERNAL_PARSE_ARGS from './internal/util/parse_args/parse_args.js?lazytext';
import INTERNAL_PARSE_ARGS_UTILS from './internal/util/parse_args/utils.js?lazytext';
import UTIL from './util.js?lazytext';
import INTERNAL_UTIL from './internal/util.js?lazytext';
import INTERNAL_UTIL_INSPECT from './internal/util/inspect.js?lazytext';
import INTERNAL_UTIL_COMPARISONS from './internal/util/comparisons.js?lazytext';
import INTERNAL_UTIL_DEBUGLOG from './internal/util/debuglog.js?lazytext';
import INTERNAL_UTIL_COLORS from './internal/util/colors.js?lazytext';
import INTERNAL_FIXED_QUEUE from './internal/fixed_queue.js?lazytext';
import INTERNAL_EVENTS_SYMBOLS from './internal/events/symbols.js?lazytext';

/** The Node the vendored files come from, reported in `BUILTINS.md`. */
export const NODE_LIB_VERSION = 'v22.18.0';

/**
 * Each file's text, made a string when it is read: a top-level constant was a
 * second copy, in every realm, of text the bundle's source already holds.
 * The engine requires about half of the library as it loads (net and
 * child_process bind at module scope, and the builtins table is filled then);
 * the rest (http and its parts, zlib, tty among them) is made only when a
 * program requires it. Ask whether a file is here with `hasNodeLibSource`,
 * which makes nothing; enumerating this object (keys, entries, a spread, JSON)
 * would make every string at once.
 */
export const NODE_LIB_SOURCES: Readonly<Record<string, string>> = lazily({
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
});

function lazily(texts: Record<string, () => string>): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const [name, text] of Object.entries(texts)) Object.defineProperty(sources, name, { get: text, enumerable: true });
  return sources;
}

export function hasNodeLibSource(name: string): boolean {
  return Object.hasOwn(NODE_LIB_SOURCES, name);
}

