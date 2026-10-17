import { readlineModule as nodeLibPublicReadline } from './readline-access';

/**
 * The internals Node's `events`, `util` and `internal/util/inspect` name that
 * are not vendored.
 *
 * Each is the whole of what those files take from it. Every one of them is
 * required lazily, inside the function that needs it -- Node wrote them that
 * way to break its own cycles -- so nothing here is built unless a program
 * walks the path that asks.
 */

/** `internal/console/global`: the realm's console, which `util.debuglog` logs through. */
export const internalConsoleGlobal = new Proxy({} as Record<string, unknown>, {
  get: (_target, key) => Reflect.get(globalThis.console as unknown as object, key),
  ownKeys: () => Reflect.ownKeys(globalThis.console),
  getOwnPropertyDescriptor: (_target, key) => ({
    configurable: true, enumerable: true,
    get: () => Reflect.get(globalThis.console as unknown as object, key),
  }),
});

/**
 * `internal/process/execution`: the one call `internal/util.js` makes into
 * it, reading the working directory where a failure to read it is not an
 * error but an empty answer.
 */
export const internalProcessExecution = {
  tryGetCwd: (): string => {
    try { return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? ''; }
    catch { return ''; }
  },
};

/**
 * `internal/process/warning`: Node emits a warning on the next tick through
 * `process.emitWarning`, and synchronously through this one where the tick
 * would come too late -- a deprecation raised while the process is exiting.
 */
export const internalProcessWarning = {
  emitWarningSync: (warning: unknown, type?: string, code?: string): void => {
    const realm = (globalThis as { process?: { emitWarning?: (w: unknown, t?: string, c?: string) => void } }).process;
    if (typeof realm?.emitWarning === 'function') { realm.emitWarning(warning, type, code); return; }
    try { console.error(String(warning)); } catch { /* a console that refuses is no reason to fail */ }
  },
};

/**
 * `internal/source_map/source_map_cache`: a tab compiles no source maps into
 * the engine's own error stacks. Each name answers the way Node's does with
 * source maps switched off.
 */
/**
 * The switch Node keeps for source-map support, per process: whether it is on, and for which code. It starts on
 * for a process started with `--enable-source-maps` (its own arguments or NODE_OPTIONS), as Node's does.
 *
 * What it switches is NOT here: no stack of this engine is remapped through a source map, on or off. So the first
 * time it is on for a process, by the flag or by a call, the process is warned once, by a code a program can
 * filter on, that positions stay the generated file's. Vendoring Node's own cache and stack preparation is what
 * would make the switch do its work.
 */
interface SourceMapsSupport { enabled: boolean; nodeModules: boolean; generatedCode: boolean }
type SourceMapsProcess = { execArgv?: unknown; env?: Record<string, unknown>; emitWarning?: (warning: string, options?: { type?: string; code?: string }) => void };
const sourceMapsByProcess = new WeakMap<object, SourceMapsSupport>();
const sourceMapsWarned = new WeakSet<object>();
export const SOURCE_MAPS_NOT_APPLIED = 'TABNODE_SOURCE_MAPS_NOT_APPLIED';
function warnSourceMapsNotApplied(process: SourceMapsProcess): void {
  if (sourceMapsWarned.has(process)) return;
  sourceMapsWarned.add(process);
  try { process.emitWarning?.('Source maps are not applied to stack traces in this engine: positions are the generated file\'s.', { type: 'Warning', code: SOURCE_MAPS_NOT_APPLIED }); }
  catch { /* a process that cannot warn is no reason to fail the switch */ }
}
export function sourceMapsSupportOf(process: SourceMapsProcess): SourceMapsSupport {
  let state = sourceMapsByProcess.get(process);
  if (!state) {
    const option = '--enable-source-maps';
    const flagged = (Array.isArray(process.execArgv) && process.execArgv.includes(option))
      || (typeof process.env?.NODE_OPTIONS === 'string' && process.env.NODE_OPTIONS.split(/\s+/u).includes(option));
    state = { enabled: flagged, nodeModules: flagged, generatedCode: flagged };
    sourceMapsByProcess.set(process, state);
    if (flagged) warnSourceMapsNotApplied(process);
  }
  return state;
}
export function setSourceMapsSupportOf(process: SourceMapsProcess, enabled: boolean, options: { nodeModules?: boolean; generatedCode?: boolean } = {}): void {
  const state = sourceMapsSupportOf(process);
  state.enabled = enabled;
  state.nodeModules = enabled && options.nodeModules === true;
  state.generatedCode = enabled && options.generatedCode === true;
  if (enabled) warnSourceMapsNotApplied(process);
}

/**
 * `internal/source_map/source_map_cache` as Node's own lib files ask for it: they read whether support is on to
 * decide whether to look a position up, and nothing is ever looked up here, so it answers off.
 */
export const internalSourceMapCache = {
  findSourceMap: (): undefined => void 0,
  maybeCacheSourceMap: (): void => {},
  sourceMapCacheToObject: (): undefined => void 0,
  getSourceMapsSupport: (): SourceMapsSupport => ({ enabled: false, nodeModules: false, generatedCode: false }),
  setSourceMapsSupport: (): void => {},
  rekeySourceMap: (): void => {},
  // Asked of a source map that was found; none ever is, so there is no line to give.
  getSourceLine: (): undefined => void 0,
};

/**
 * `internal/deps/undici/undici`: what `http.js` reaches for when a program
 * touches `http.WebSocket`, `http.CloseEvent` or `http.MessageEvent`.
 *
 * Node bundles undici to have those classes at all. A tab already has them --
 * they are the platform's, and they are what `new WebSocket(url)` means
 * everywhere else on the page -- so the realm's own are what the engine
 * answers with, rather than a second implementation of the same three names.
 */
export const internalUndici = {
  get WebSocket() { return (globalThis as { WebSocket?: unknown }).WebSocket; },
  get CloseEvent() { return (globalThis as { CloseEvent?: unknown }).CloseEvent; },
  get MessageEvent() { return (globalThis as { MessageEvent?: unknown }).MessageEvent; },
};

/**
 * `internal/readline/interface`: the one name `internal/fs/promises.js`
 * takes from it, at its top, so every use of `fs/promises` needs it.
 * `filehandle.readLines()` builds one of these over the file's own stream;
 * the engine's `readline` already has that class, over the same streams.
 */
export const internalReadlineInterface = {
  get Interface() { return readlineInterface(); },
};

// eslint-disable-next-line no-var, vars-on-top
var readlineInterfaceCache: unknown;
function readlineInterface(): unknown {
  // Required late, not imported: `readline` is an EventEmitter, and this file
  // is on the loader's own path.
  return readlineInterfaceCache ??= (nodeLibPublicReadline() as { Interface: unknown }).Interface;
}

/**
 * `internal/worker/js_transferable`: the marks Node puts on an object that
 * can cross a `postMessage`. `internal/fs/promises.js` marks its `FileHandle`
 * so one can be sent to a worker. Nothing crosses a thread boundary here --
 * a handle is a number in this engine's own table -- so the marks are the
 * symbols and a no-op, which is what an unmarked object gets anyway.
 */
export const internalJsTransferable = {
  markTransferMode: (): void => {},
  kDeserialize: Symbol.for('nodejs.transfer.deserialize'),
  kTransfer: Symbol.for('nodejs.transfer.transfer'),
  kTransferList: Symbol.for('nodejs.transfer.transferList'),
  kClone: Symbol.for('nodejs.transfer.clone'),
  setDeserializerCreateObjectFunction: (): void => {},
};
