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
import { nodeLibInternalRequire } from '../load';

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

  /** Node warns differently for a deprecation raised inside a dependency; nothing here is. */
  isInsideNodeModules: (): boolean => false,

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

  /** What kind of thing a descriptor is, out of the engine's own table. */
  guessHandleType: guessHandleTypeOfFd,

  /**
   * Node's `defineLazyProperties`: each key becomes a getter that requires
   * the module the first time it is read, so a builtin that exposes another
   * builtin's class does not load it to say so.
   */
  defineLazyProperties: lazyProperties(nodeLibInternalRequire),

  /**
   * The stack, as `util.getCallSites()` reports it: one entry per frame with
   * the function's name, the script it is in, and where in that script. V8's
   * own structured-stack door is what Node reads too -- `Error
   * .prepareStackTrace` handed an array of call sites -- so this asks the
   * realm the same question and shapes the answer the same way. The harness
   * of Node's own tests calls it on every `mustNotCall`, which is why a
   * missing one showed up as thirty test files at once.
   */
  getCallSites: (frameCount = 10): Array<Record<string, unknown>> => {
    const original = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = Math.max(frameCount + 2, 10);
      Error.prepareStackTrace = (_error, sites: unknown[]) => sites.map((raw) => {
        const site = raw as {
          getFunctionName?: () => string | null; getFileName?: () => string | null;
          getLineNumber?: () => number | null; getColumnNumber?: () => number | null;
          getScriptNameOrSourceURL?: () => string | null;
        };
        return {
          functionName: site.getFunctionName?.() ?? '',
          scriptName: site.getFileName?.() ?? site.getScriptNameOrSourceURL?.() ?? '',
          scriptId: '0',
          lineNumber: site.getLineNumber?.() ?? 0,
          column: site.getColumnNumber?.() ?? 0,
          columnNumber: site.getColumnNumber?.() ?? 0,
        };
      });
      const holder: { stack?: unknown } = {};
      Error.captureStackTrace(holder, utilBinding.getCallSites);
      const sites = holder.stack as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(sites)) return [];
      // A frame inside a builtin is not the caller's business: Node drops the
      // `node:util` frame its own `getCallSites` stands in, and so does this.
      return sites.filter((site) => !String(site.scriptName ?? '').startsWith('node:')).slice(0, frameCount);
    } finally {
      Error.prepareStackTrace = original;
      Error.stackTraceLimit = limit;
    }
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
   * A blocking sleep. A tab has one thread and nothing else can run while
   * this spins, which is exactly what a blocking sleep is; only a program
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
