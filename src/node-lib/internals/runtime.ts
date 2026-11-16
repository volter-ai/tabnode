import { drainGuestNextTicks } from '../../guest-loop';
import { constantsBinding } from '../../shims/constants';
import { AsyncResource } from '../../shims/async_hooks';
import { handleOwnerSymbol } from '../binding/owner-symbol';
import { defineOnHost, forGuestRealm } from '../../host-globals';
/**
 * The internals Node's `net` names that are neither vendored nor a binding:
 * async ids, stream defaults, the option table, and the three
 * one-line answers (`assert`, `hasObserver`, `isBuildingSnapshot`).
 *
 * Each object holds exactly the names the vendored files destructure.
 */

/**
 * `internal/async_hooks`. The engine has no async-hooks graph, so an id is a
 * number nobody follows and a trigger scope is the call itself. The two
 * symbols matter and are real: `owner_symbol` is how a handle finds its
 * stream — `onStreamRead` reads `this[owner_symbol]` on every chunk — and
 * `async_id_symbol` is where `net.js` keeps a socket's id.
 */
let nextAsyncId = 1;
const symbols = {
  async_id_symbol: Symbol('async_id_symbol'),
  trigger_async_id_symbol: Symbol('trigger_async_id_symbol'),
  owner_symbol: handleOwnerSymbol,
  init_symbol: Symbol('init_symbol'),
  async_local_storage_context_symbol: Symbol('kAsyncLocalStorageContext'),
  destroy_symbol: Symbol('destroy_symbol'),
  async_id_fields: Symbol('async_id_fields'),
};

export const internalAsyncHooks = {
  symbols,
  newAsyncId: (): number => nextAsyncId++,
  /**
   * Node's `getOrSetAsyncId`: the id an object already carries, or a new one
   * put on it. `_http_server.js` asks it of every socket it accepts, to name
   * the scope the connection listener runs in.
   */
  getOrSetAsyncId: (object: Record<symbol, unknown>): number => {
    const key = symbols.async_id_symbol;
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key] as number;
    object[key] = nextAsyncId++;
    return object[key] as number;
  },
  getDefaultTriggerAsyncId: (): number => 0,
  defaultTriggerAsyncIdScope: <A extends unknown[], R>(
    _triggerAsyncId: number, block: (...args: A) => R, ...args: A
  ): R => block(...args),
  initHooksExist: (): boolean => false,
  afterHooksExist: (): boolean => false,
  destroyHooksExist: (): boolean => false,
  emitInit: (): void => {},
  emitBefore: (): void => {},
  emitAfter: (): void => {},
  emitDestroy: (): void => {},
  hasAsyncIdStack: (): boolean => false,
  registerDestroyHook: (): void => {},
};

/** Node's `AsyncResource` (shims/async_hooks.ts), which `events.js` extends and `async_wrap` answers. */
export { AsyncResource };

/** `internal/process/task_queues`: ticks precede the native microtask queue. */
export const internalTaskQueues = {
  queueMicrotask: (fn: () => void): void => queueMicrotask(fn),
  setHasTickScheduled: (): void => {},
  runNextTicks: drainGuestNextTicks,
};

/**
 * Node's own `internal/event_target` (vendored) answers whether a value is an EventTarget by its constructor's
 * `Symbol.for('nodejs.event_target')`, which Node's EventTarget class carries. A process's `EventTarget`, `AbortSignal`
 * and the rest of the realm's targets are the realm's (guest-scope.ts), so the realm's EventTarget carries it too while
 * a guest exists: `events.setMaxListeners(n, signal)`, `events.once` and `getEventListeners` take them, as Node takes
 * its own.
 */
forGuestRealm(() => {
  if (typeof EventTarget !== 'function') return;
  const kIsEventTarget = Symbol.for('nodejs.event_target');
  if (!Object.prototype.hasOwnProperty.call(EventTarget, kIsEventTarget)) {
    defineOnHost(EventTarget, kIsEventTarget, { value: true, configurable: true });
  }
});

/**
 * `internal/options`: the command-line options Node's `net`, `http` and
 * `util` read. The engine takes no command line of its own, so each is
 * Node's own default.
 */
const optionValues: Record<string, unknown> = {
  '--network-family-autoselection': true,
  '--network-family-autoselection-attempt-timeout': 250,
  '--no-deprecation': false,
  '--throw-deprecation': false,
  '--trace-deprecation': false,
  '--pending-deprecation': false,
  '--report-uncaught-exception': false,
  '--experimental-print-required-tla': false,
  '--max-http-header-size': 16 * 1024,
  '--insecure-http-parser': false,
  '--enable-source-maps': false,
  '--use-env-proxy': false,
  '--experimental-transform-types': false,
  // Node 24's default: Node's AsyncLocalStorage and its timers keep their stores in the context frame
  // (internal/async_context_frame), which the engine keeps (shims/async_hooks.ts).
  '--async-context-frame': true,
  // TLS (node_options.h:228-372), Node's defaults, but the CA store: the engine's is the image's bundle as
  // `--use-openssl-ca` makes it (ADR-0016 §4), so the option says so and tls.getCACertificates() agrees.
  '--tls-min-v1.0': false,
  '--tls-min-v1.1': false,
  '--tls-min-v1.2': false,
  '--tls-min-v1.3': false,
  '--tls-max-v1.2': false,
  '--tls-max-v1.3': false,
  '--tls-keylog': '',
  '--trace-tls': false,
  '--use-openssl-ca': true,
  '--use-bundled-ca': false,
  '--use-system-ca': false,
  // DEFAULT_CIPHER_LIST_CORE (node_constants.h:52-76), as the `node` program compiled it.
  get '--tls-cipher-list'() { return constantsBinding().crypto.defaultCoreCipherList; },
};

/**
 * Options one run was started with, answered only while a call made for that
 * run is on the stack. Node reads an option of its own process; the engine
 * holds many processes in one realm, so a caller that knows whose call it is
 * (the module loader stripping a `.ts` file for a run started with
 * `--experimental-transform-types`) says so for the length of that call.
 */
let optionOverrides: Record<string, unknown> | null = null;
export function withOptionValues<T>(overrides: Record<string, unknown>, fn: () => T): T {
  const previous = optionOverrides;
  optionOverrides = { ...(previous ?? {}), ...overrides };
  try { return fn(); } finally { optionOverrides = previous; }
}

/**
 * `--eval` is the code passed to `-e`/`--eval`/`-p`/`--print`, or `""` for a
 * file run. Node's `util.parseArgs()` uses its length to locate program arguments;
 * the run's own execArgv identifies the evaluation mode and source.
 */
function evalOption(): string {
  const execArgv = (globalThis as { process?: { execArgv?: unknown } }).process?.execArgv;
  if (!Array.isArray(execArgv)) return '';
  for (let at = 0; at < execArgv.length; at++) {
    const option = execArgv[at];
    if (typeof option !== 'string') continue;
    if (option === '-e' || option === '--eval' || option === '-p' || option === '--print' || option === '-pe') return String(execArgv[at + 1] ?? '');
    const inline = /^--(?:eval|print)=(.*)$/su.exec(option);
    if (inline) return inline[1]!;
  }
  return '';
}

interface OptionsProcess { env?: Record<string, string | undefined>; emitWarning?(message: string): void }
/** The processes Node's `warnOnAllowUnauthorized` has already warned (a module-level flag of each process's). */
const warnedAllowUnauthorized = new WeakSet<object>();
/**
 * Node's `getAllowUnauthorized` (lib/internal/options.js) over `process`: NODE_TLS_REJECT_UNAUTHORIZED=0 turns
 * verification off, with Node's warning, once per process.
 */
export function allowUnauthorizedOf(process: OptionsProcess | undefined): boolean {
  const allowUnauthorized = process?.env?.NODE_TLS_REJECT_UNAUTHORIZED === '0';
  if (allowUnauthorized && process && !warnedAllowUnauthorized.has(process)) {
    warnedAllowUnauthorized.add(process);
    process.emitWarning?.(
      'Setting the NODE_TLS_REJECT_UNAUTHORIZED ' +
      'environment variable to \'0\' makes TLS connections ' +
      'and HTTPS requests insecure by disabling ' +
      'certificate verification.');
  }
  return allowUnauthorized;
}
export const internalOptions = {
  getOptionValue: (name: string): unknown => (optionOverrides !== null && name in optionOverrides ? optionOverrides[name]
    : name === '--eval' ? evalOption() : optionValues[name]),
  getEmbedderOptions: () => ({ shouldNotRegisterESMLoader: false, noGlobalSearchPaths: false, noBrowserGlobals: false }),
  /** Node's `getAllowUnauthorized` for the realm's own graph; a process's `internal/options` answers it over itself. */
  getAllowUnauthorized: (): boolean => allowUnauthorizedOf((globalThis as { process?: OptionsProcess }).process),
};

/** `internal/perf/observe`: nothing observes `net` in the engine. */
export const internalPerfObserve = {
  hasObserver: (): boolean => false,
  startPerf: (): void => {},
  stopPerf: (): void => {},
};

/** `internal/assert`: Node's internal assertion, which no program should ever see. */
export function internalAssert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(`Internal assertion failed${message ? `: ${message}` : ''}`);
}
internalAssert.fail = (message?: string): never => {
  throw new Error(`Internal assertion failed${message ? `: ${message}` : ''}`);
};
internalAssert.ok = internalAssert;

/** `internal/v8/startup_snapshot`: the engine never builds one. */
export const internalStartupSnapshot = {
  namespace: {
    isBuildingSnapshot: (): boolean => false,
    addSerializeCallback: (): void => {},
    addDeserializeCallback: (): void => {},
    setDeserializeMainFunction: (): void => {},
  },
  runDeserializeCallbacks: (): void => {},
};

/**
 * `internal/process/permission`: the engine runs no permission model, so
 * nothing is denied and there are no flags for `child_process.js` to copy
 * into a child's `NODE_OPTIONS`.
 */
export const internalPermission = {
  isEnabled: (): boolean => false,
  has: (): boolean => true,
  availableFlags: (): string[] => [],
};
