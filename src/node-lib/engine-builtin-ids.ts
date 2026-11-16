/**
 * The builtin ids the engine answers itself rather than with a vendored file of Node's (ADR-0018 §7, BUILTINS.md), by
 * the table that answers each. Data only, with no import: the build reads it beside the vendored set
 * (vite.lib.config.js, `builtin-closure.ts`) and refuses a library whose files can require an id neither answers, and
 * each table below is typed by its list, so a table and its list cannot differ.
 */

/** The realm's one Environment's own files (load.ts REALM_ENVIRONMENT). */
export const REALM_ENVIRONMENT_IDS = ['internal/timers', 'internal/async_context_frame', 'internal/crypto/keys'] as const;

/** What the node realm makes itself: its process, the realm's web streams and the engine's SQLite (realm.ts). */
export const REALM_OWN_IDS = ['process', 'stream/web', 'sqlite'] as const;

/** A public id that is another module's member (load.ts ALIASES). */
export const REALM_ALIAS_IDS = ['fs/promises', 'dns/promises', 'path/posix', 'path/win32', 'util/types'] as const;

/** The realm's own web classes under Node's ids (realm.ts REALM_WEB_MODULES). */
export const REALM_WEB_MODULE_IDS = ['internal/webstreams/readablestream', 'internal/webstreams/writablestream',
  'internal/webstreams/transformstream', 'internal/webstreams/queuingstrategies', 'internal/webstreams/encoding',
  'internal/webstreams/compression', 'internal/encoding', 'internal/file'] as const;

/** The hand-bound internals (internals/index.ts): its conditional names, then its table's. */
export const ENGINE_INTERNAL_IDS = ['internal/deps/acorn/acorn/dist/acorn', 'internal/modules/helpers',
  'internal/webstreams/adapters', 'internal/url', 'internal/locks', 'internal/options', 'internal/blob',
  'internal/process/per_thread', 'internal/process/execution', 'internal/process/warning',
  'internal/util/types', 'internal/async_hooks', 'internal/process/task_queues', 'internal/process/permission',
  'internal/perf/observe', 'internal/assert', 'internal/v8/startup_snapshot', 'internal/abort_controller',
  'internal/file', 'internal/socketaddress', 'internal/blocklist', 'internal/bootstrap/realm', 'internal/encoding',
  'internal/console/global', 'internal/source_map/source_map_cache', 'internal/deps/amaro/dist/index',
  'internal/worker/js_transferable', 'internal/worker'] as const;

/** The engine's own public modules (public-modules.ts, BUILTINS.md Kind 2). */
export const ENGINE_PUBLIC_IDS = ['dns', 'cluster', 'v8', 'async_hooks', 'vm', 'worker_threads', 'http2', 'inspector',
  'inspector/promises', 'perf_hooks', 'repl', 'domain'] as const;

export type RealmAliasId = typeof REALM_ALIAS_IDS[number];
export type RealmWebModuleId = typeof REALM_WEB_MODULE_IDS[number];
export type EngineInternalId = typeof ENGINE_INTERNAL_IDS[number];
export type EnginePublicId = typeof ENGINE_PUBLIC_IDS[number];

/** Every id the engine answers, which a realm's builtin ids hold beside the vendored set's. */
export const ENGINE_BUILTIN_IDS: readonly string[] = [...new Set<string>([...REALM_ENVIRONMENT_IDS, ...REALM_OWN_IDS,
  ...REALM_ALIAS_IDS, ...REALM_WEB_MODULE_IDS, ...ENGINE_INTERNAL_IDS, ...ENGINE_PUBLIC_IDS])];
