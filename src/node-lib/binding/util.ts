/**
 * `internalBinding('util')`: what V8 tells Node about a value.
 *
 * `internal/util/inspect.js` is the reason this file is the size it is.
 * Printing a value the way Node prints it means asking V8 questions
 * JavaScript cannot ask itself, and each one is answered here out of the
 * realm's own built-ins -- an object's non-index properties, the name of the
 * constructor that made it, the entries inside a `Map` or a `Set`.
 *
 * THE TWO NAMED LOSSES, and why they are losses rather than gaps to close:
 *
 * `getProxyDetails` asks V8 for a `Proxy`'s target and handler. A proxy is
 * invisible to the code it wraps -- that is the whole of what a proxy is --
 * and no JavaScript can see through one. This answers undefined, which is
 * `not a proxy`, so `inspect` prints the value the proxy stands for. That is
 * also what Node prints without `--show-proxy`, so the loss shows only under
 * `showProxy: true`.
 *
 * `defineLazyProperties` is how `util.js` exposes `parseArgs`, `TextDecoder`,
 * `MIMEType` and the rest: each is a getter that requires its own file on the
 * first read. It must reach the loader's require, not the realm's -- there is
 * no `require` on a realm -- or every one of those names reads undefined.
 *
 * `getConstructorName` asks V8 which constructor made a value, which V8 knows
 * from the object's own shape even after its prototype has been severed.
 * This walks the prototype chain for an own `constructor`, which is the only
 * record JavaScript keeps -- so an object whose prototype was set to null
 * prints as `[Object: null prototype]` where Node prints `[Foo: null
 * prototype]`. Everything with a prototype still names its constructor.
 *
 * `getPromiseDetails` asks V8 for a promise's state and its value without
 * awaiting it. A promise's state cannot be read synchronously from
 * JavaScript; `then` is the only door and it is asynchronous by definition.
 * This answers `[kPending]`, so `inspect` prints `Promise { <pending> }` for
 * every promise, settled or not. A program that needs to know awaits it.
 */
import { guessHandleTypeOfFd } from './fds';

/** internal/util's `handleTypes`, in its order: the binding answers an index into it, as Node's does. */
const HANDLE_TYPES = ['TCP', 'TTY', 'UDP', 'FILE', 'PIPE', 'UNKNOWN'];
import { stdioKindOf } from './tty_wrap';
import { nodeLibInternalRequire } from '../load';
import { stackOverrides } from '../../stack-overrides';

/** A V8 call site, as much of it as is read here. */
interface CallSite {
  getFunctionName?(): string | null; getFileName?(): string | null; getScriptNameOrSourceURL?(): string | null;
  getLineNumber?(): number | null; getColumnNumber?(): number | null;
}

/**
 * V8's call sites above `above`, through the door Node's own files use for them: an entry in `internal/errors`'
 * `overrideStackTrace`, which the realm's stack hook reads first (`src/stack-overrides.ts`, runtime.ts
 * `__substrateCallSiteFileNames`), and `Error.captureStackTrace`. `Error.prepareStackTrace` is never assigned, so a
 * program that pinned it non-writable is not made to throw; where the realm's hook is not installed (a pinned,
 * non-configurable `prepareStackTrace`, a realm without V8's call sites) the stack is not call sites and the answer
 * is none. Every frame is taken: the callers of these ask rarely and the engine's own frames are passed over.
 */
function callSitesAbove(above: Function): CallSite[] {
  const holder: { stack?: unknown } = {};
  stackOverrides.set(holder, (_error, sites) => sites);
  const limit = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
  const settable = limit !== undefined && 'value' in limit && limit.writable === true;
  try {
    if (settable) Error.stackTraceLimit = Infinity;
    (Error as { captureStackTrace?: (target: object, above?: Function) => void }).captureStackTrace?.(holder, above);
    const sites = holder.stack;
    return Array.isArray(sites) ? sites as CallSite[] : [];
  } catch {
    return [];
  } finally {
    if (settable) Error.stackTraceLimit = limit.value as number;
    stackOverrides.delete(holder);
  }
}

function scriptNameOf(site: CallSite): string {
  return site.getScriptNameOrSourceURL?.() || site.getFileName?.() || '';
}

/**
 * Whether a frame is the engine's own: a script the realm loaded by URL (the engine's bundle, a dependency it
 * compiles under its name) rather than a file of the process. A guest's module is named by its path in the
 * process's tree (runtime.ts `__substrateScriptName`, which names a `file:` URL by its path too), and a builtin by
 * `node:`. A frame with no name (a guest's own `eval`) is passed over, as Node passes over one.
 */
function isEngineScript(name: string): boolean {
  return name === '' || (!name.startsWith('/') && !name.startsWith('node:'));
}

/** Node's `propertyFilter` and promise-state constants, by their own values. */
const constants = {
  ALL_PROPERTIES: 0,
  ONLY_WRITABLE: 1,
  ONLY_ENUMERABLE: 2,
  ONLY_CONFIGURABLE: 4,
  SKIP_STRINGS: 8,
  SKIP_SYMBOLS: 16,
  kPending: 0,
  kFulfilled: 1,
  kRejected: 2,
};

// A real rejection handler marks the host promise handled; no invented state.
const intrinsicThen = Promise.prototype.then;

/** Whether a key is an array index, which `getOwnNonIndexProperties` leaves out. */
function isIndexKey(key: string): boolean {
  const number = Number(key);
  return Number.isInteger(number) && number >= 0 && String(number) === key;
}

export const utilBinding = {
  privateSymbols: {
    arrow_message_private_symbol: Symbol('arrow_message_private_symbol'),
    decorated_private_symbol: Symbol('decorated_private_symbol'),
    untransferable_object_private_symbol: Symbol('untransferable_object_private_symbol'),
    host_defined_option_symbol: Symbol('host_defined_option_symbol'),
    transfer_mode_private_symbol: Symbol('transfer_mode_private_symbol'),
  },
  constants,
  constructSharedArrayBuffer(length: number): SharedArrayBuffer {
    if (typeof SharedArrayBuffer !== 'function') {
      throw Object.assign(new Error('SharedArrayBuffer is unavailable in this execution realm.'), { code: 'ERR_UNSUPPORTED_OPERATION' });
    }
    return new SharedArrayBuffer(length);
  },
  markPromiseAsHandled(promise: Promise<unknown>): void {
    intrinsicThen.call(promise, undefined, () => undefined);
  },
  arrayBufferViewHasBuffer(view: ArrayBufferView): boolean {
    return view.buffer !== undefined;
  },

  /**
   * Whether the nearest user frame is a file under a `node_modules` directory (node_util.cc:328-359). Node asks it so a
   * deprecation a dependency triggers -- `url.parse`'s DEP0169, `punycode`'s DEP0040, `Buffer()`'s DEP0005 -- is not
   * printed to a program that did not write the call. Node passes over its own `node:` frames; here the engine's own
   * frames (its loader compiling a builtin, `require`, the shims) stand between too and are passed over as well,
   * without counting toward the limit, which Node's frames never are.
   */
  isInsideNodeModules: (framesLimit?: unknown): boolean => {
    const limit = typeof framesLimit === 'number' && (framesLimit | 0) === framesLimit ? framesLimit : 10;
    let counted = 0;
    for (const site of callSitesAbove(utilBinding.isInsideNodeModules)) {
      const name = scriptNameOf(site);
      if (isEngineScript(name)) continue;
      if (++counted > limit) break;
      if (name.startsWith('node:')) continue;
      return /[/\\]node_modules[/\\]/.test(name);
    }
    return false;
  },

  /**
   * An object's own properties that are not array indices, filtered the way
   * V8's `GetOwnNonIndexProperties` filters: `ONLY_ENUMERABLE` keeps the
   * enumerable ones, `SKIP_SYMBOLS` and `SKIP_STRINGS` drop a kind outright.
   * `inspect` asks for this to list an array's non-index keys and a typed
   * array's own properties without walking its elements.
   */
  getOwnNonIndexProperties: (target: object, filter = 0): Array<string | symbol> => {
    const keys: Array<string | symbol> = [];
    if ((filter & constants.SKIP_STRINGS) === 0) {
      for (const key of Object.getOwnPropertyNames(target)) {
        if (isIndexKey(key)) continue;
        if ((filter & constants.ONLY_ENUMERABLE) !== 0) {
          const own = Object.getOwnPropertyDescriptor(target, key);
          if (!own?.enumerable) continue;
        }
        keys.push(key);
      }
    }
    if ((filter & constants.SKIP_SYMBOLS) === 0) {
      for (const key of Object.getOwnPropertySymbols(target)) {
        if ((filter & constants.ONLY_ENUMERABLE) !== 0) {
          const own = Object.getOwnPropertyDescriptor(target, key);
          if (!own?.enumerable) continue;
        }
        keys.push(key);
      }
    }
    return keys;
  },

  /** The promise loss named at the top of this file. */
  getPromiseDetails: (): [number] => [constants.kPending],

  /** The proxy loss named at the top of this file. */
  getProxyDetails: (): undefined => void 0,

  /**
   * The entries inside a `Map` or a `Set`, which `inspect` prints. V8 reads
   * them out of the object's own storage; this reads them the way any program
   * does, which answers for a real map or set. An ITERATOR over one keeps its
   * position in V8's own state and cannot be previewed without consuming it,
   * so an iterator previews as empty rather than being spent -- a printed
   * value is not worth destroying the thing printed.
   */
  previewEntries: (value: unknown, isIterator?: boolean): [unknown[], boolean] => {
    if (value instanceof Map) {
      const entries: unknown[] = [];
      for (const [key, item] of value) { entries.push(key, item); }
      return [entries, true];
    }
    if (value instanceof Set) return [[...value], false];
    if (isIterator) return [[], false];
    return [[], false];
  },

  /**
   * The name of the constructor that made a value, as V8 reports it: the
   * first prototype in the chain with an own `constructor` whose name is not
   * empty. `inspect` prints it before an object's braces.
   */
  getConstructorName: (value: object): string => {
    let current: object | null = value;
    while (current !== null) {
      const own = Object.getOwnPropertyDescriptor(current, 'constructor');
      const constructor = own?.value as { name?: string } | undefined;
      if (typeof constructor === 'function' && constructor.name) return constructor.name;
      current = Object.getPrototypeOf(current) as object | null;
    }
    return '';
  },

  /** A pointer's value, printed for an external. A tab has no externals. */
  getExternalValue: (): bigint => BigInt(0),

  /**
   * What kind of thing a descriptor is, out of the engine's own table; a
   * standard fd is what the run was given on it, as libuv's
   * `uv_guess_handle` answers: a terminal 'TTY', a regular file or a
   * character device 'FILE', a pipe 'PIPE'. It agrees with `tty.isatty` and
   * `fstat` per fd.
   */
  // Node's binding answers the type's index in internal/util's `handleTypes`, which maps it to the name. Answering
  // the name made that lookup undefined, and `new net.Socket({ fd })` refused every descriptor it was given
  // (ERR_INVALID_FD_TYPE: undefined): a program reading a pipe its parent passed at fd 3 could not open it.
  guessHandleType: (fd: number) => {
    const type = fd !== 0 && fd !== 1 && fd !== 2 ? guessHandleTypeOfFd(fd)
      : ((kind) => kind === 'tty' ? 'TTY' : kind === 'file' || kind === 'char' ? 'FILE' : guessHandleTypeOfFd(fd))(stdioKindOf(fd));
    return HANDLE_TYPES.indexOf(type);
  },

  /**
   * Node's `defineLazyProperties`: each key becomes a getter that requires
   * the module the first time it is read, so a builtin that exposes another
   * builtin's class does not load it to say so.
   */
  defineLazyProperties: lazyProperties(nodeLibInternalRequire),

  /**
   * The stack, as `util.getCallSites()` reports it: one entry per frame with
   * the function's name, the script it is in, and where in that script, read
   * off V8's own call sites (`callSitesAbove`). The harness
   * of Node's own tests calls it on every `mustNotCall`, which is why a
   * missing one showed up as thirty test files at once.
   */
  getCallSites: (frameCount = 10): Array<Record<string, unknown>> => {
    const sites: Array<Record<string, unknown>> = [];
    for (const site of callSitesAbove(utilBinding.getCallSites)) {
      const scriptName = site.getFileName?.() ?? site.getScriptNameOrSourceURL?.() ?? '';
      // A frame inside a builtin is not the caller's business: Node drops the
      // `node:util` frame its own `getCallSites` stands in, and so does this,
      // with the engine's own frames, which Node has none of.
      if (scriptName.startsWith('node:') || isEngineScript(scriptName)) continue;
      sites.push({
        functionName: site.getFunctionName?.() ?? '',
        scriptName,
        scriptId: '0',
        lineNumber: site.getLineNumber?.() ?? 0,
        column: site.getColumnNumber?.() ?? 0,
        columnNumber: site.getColumnNumber?.() ?? 0,
      });
      if (sites.length === frameCount) break;
    }
    return sites;
  },

  /**
   * A `.env` file's contents as an object, which `util.parseEnv` returns and
   * which `--env-file` loads a process's environment from. Node parses it in
   * C++; the rules are the ones its own fixture states, and they are the
   * whole of the format: a `KEY=VALUE` per line, `export ` allowed in front
   * of the key and dropped, a `#` starting a comment outside quotes wherever
   * it stands -- `a#b` is `a`, no space needed -- and a
   * value that may be wrapped in single quotes, double quotes or backticks --
   * a quoted value keeps its spaces and may run over several lines, and only
   * a double-quoted one expands `\n` and `\r`.
   */
  parseEnv: (content: string): Record<string, string> => {
    const parsed: Record<string, string> = {};
    const text = String(content);
    let at = 0;
    while (at < text.length) {
      // A line's key, up to its `=`; anything with no `=` is not a setting.
      let lineEnd = text.indexOf('\n', at);
      if (lineEnd === -1) lineEnd = text.length;
      let line = text.slice(at, lineEnd);
      const hash = line.indexOf('#');
      const keyEnd = line.indexOf('=');
      if (keyEnd === -1 || (hash !== -1 && hash < keyEnd)) { at = lineEnd + 1; continue; }
      let key = line.slice(0, keyEnd).trim();
      if (key.startsWith('export ')) key = key.slice(7).trim();
      if (key === '') { at = lineEnd + 1; continue; }

      const rest = text.slice(at + keyEnd + 1);
      const first = rest[rest.search(/\S|$/u)];
      if (first === '"' || first === "'" || first === '`') {
        // A quoted value ends at its own closing quote, wherever that is.
        const open = at + keyEnd + 1 + rest.indexOf(first);
        const close = text.indexOf(first, open + 1);
        if (close !== -1) {
          const value = text.slice(open + 1, close);
          parsed[key] = first === '"' ? value.replace(/\\n/gu, '\n').replace(/\\r/gu, '\r') : value;
          const after = text.indexOf('\n', close);
          at = after === -1 ? text.length : after + 1;
          continue;
        }
      }
      // An unquoted value runs to the end of its line, minus any comment.
      line = text.slice(at + keyEnd + 1, lineEnd);
      const comment = line.indexOf('#');
      parsed[key] = (comment === -1 ? line : line.slice(0, comment)).trim();
      at = lineEnd + 1;
    }
    return parsed;
  },

  /**
   * A blocking sleep. This realm has one thread and nothing else in it can
   * run while this spins, which is exactly what a blocking sleep is; only a program
   * that asked for one gets it.
   */
  sleep: (milliseconds: number): void => {
    const until = Date.now() + milliseconds;
    while (Date.now() < until) { /* the caller asked to block */ }
  },
};

export default utilBinding;

function lazyProperties(require: (name: string) => unknown) {
  return (target: object, id: string, keys: string[], writable = true): void => {
    for (const key of keys) {
      let built: unknown;
      let ready = false;
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get() {
          if (!ready) { ready = true; built = (require(id) as Record<string, unknown>)[key]; }
          return built;
        },
        set: writable ? (value: unknown) => { built = value; ready = true; } : void 0,
      });
    }
  };
}

/** Lazy builtin exports must resolve inside the requesting process. */
export function createUtilBinding(require: (name: string) => unknown) {
  return { ...utilBinding, defineLazyProperties: lazyProperties(require) };
}
