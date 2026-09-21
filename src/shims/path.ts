/**
 * `path`, as Node's own `lib/path.js`.
 *
 * What died: the engine's `path` was hand-written and POSIX-only. `path.win32`
 * was a stub whose members were the POSIX ones under Windows' `sep`, so
 * `path.win32.join('C:\\a', 'b')` answered a POSIX join; `normalize` collapsed
 * `./` and dropped trailing slashes, so `join('foo/', 'bar/')` came back
 * `foo/bar` where Node gives `foo/bar/`; `basename` normalised first, so
 * `basename('a//b/')` differed; `parse` and `format` were approximations;
 * `toNamespacedPath` and `matchesGlob` were bolted on by the module table.
 * Node's own test/parallel/test-path-*.js: 1 of 16 passed.
 *
 * What this is: Node's `lib/path.js` v22.18.0, vendored unmodified in
 * `../node-lib/path.js`, evaluated once here on a binding that supplies the
 * four things the Node runtime would have given it — `primordials`,
 * `require` of the three internals it names, `module`, and a `process` whose
 * `cwd()` and `platform` are the engine's. Both flavours are Node's: the
 * default export is `posix` (the engine's filesystem is POSIX and its process
 * never reports win32), and `win32` is Node's real Windows implementation,
 * which packages ask for and which Node's tests exercise on every platform.
 *
 * The rule for this file: it binds, it does not implement. A path bug is
 * fixed by moving the vendored file to a newer Node, never by editing either.
 */
import { globToRegExp } from '../utils/glob';

import NODE_PATH_SOURCE from '../node-lib/path.js?raw';
// internal/errors and internal/validators, shared with every Node file the
// engine runs on a binding (see src/node-internals.ts).
import { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, validateObject, validateString } from '../node-internals';

// ---------------------------------------------------------------------------
// primordials — the fourteen names path.js destructures, written literally
// over the built-ins. Node's primordials are the built-ins captured before a
// program can monkey-patch them; captured here at module load for the same
// reason.
// ---------------------------------------------------------------------------

const uncurry = <A extends unknown[], R>(fn: (...args: A) => R) =>
  Function.prototype.call.bind(fn) as unknown as (self: unknown, ...args: A) => R;

const primordials = {
  ArrayPrototypeIncludes: uncurry(Array.prototype.includes),
  ArrayPrototypeJoin: uncurry(Array.prototype.join),
  ArrayPrototypeSlice: uncurry(Array.prototype.slice),
  FunctionPrototypeBind: uncurry(Function.prototype.bind),
  StringPrototypeCharCodeAt: uncurry(String.prototype.charCodeAt),
  StringPrototypeIncludes: uncurry(String.prototype.includes),
  StringPrototypeIndexOf: uncurry(String.prototype.indexOf),
  StringPrototypeLastIndexOf: uncurry(String.prototype.lastIndexOf),
  StringPrototypeRepeat: uncurry(String.prototype.repeat),
  StringPrototypeReplace: uncurry(String.prototype.replace),
  StringPrototypeSlice: uncurry(String.prototype.slice),
  StringPrototypeSplit: uncurry(String.prototype.split),
  StringPrototypeToLowerCase: uncurry(String.prototype.toLowerCase),
  StringPrototypeToUpperCase: uncurry(String.prototype.toUpperCase),
};

// ---------------------------------------------------------------------------
// internal/constants — the CHAR_* codes path.js names.
// ---------------------------------------------------------------------------

const constants = {
  CHAR_UPPERCASE_A: 65, /* A */
  CHAR_LOWERCASE_A: 97, /* a */
  CHAR_UPPERCASE_Z: 90, /* Z */
  CHAR_LOWERCASE_Z: 122, /* z */
  CHAR_DOT: 46, /* . */
  CHAR_FORWARD_SLASH: 47, /* / */
  CHAR_BACKWARD_SLASH: 92, /* \ */
  CHAR_COLON: 58, /* : */
  CHAR_QUESTION_MARK: 63, /* ? */
};

// ---------------------------------------------------------------------------
// process — the engine's, read at call time. A runtime's cwd changes under a
// guest (and the engine's own tests move it), so `cwd()` delegates on every
// call rather than closing over a value; path.js captures this object once,
// as it captures Node's.
// ---------------------------------------------------------------------------

const engineProcess = (): Record<string, unknown> | undefined =>
  (globalThis as unknown as { process?: Record<string, unknown> }).process;

const platformOf = (): string => {
  const platform = engineProcess()?.platform;
  return typeof platform === 'string' ? platform : 'linux';
};

const processBinding = {
  get platform(): string {
    return platformOf();
  },
  cwd(): string {
    const cwd = engineProcess()?.cwd;
    return typeof cwd === 'function' ? (cwd as () => string)() : '/';
  },
  get env(): Record<string, string | undefined> {
    const env = engineProcess()?.env;
    return (env as Record<string, string | undefined>) ?? {};
  },
};

// ---------------------------------------------------------------------------
// internal/util — the three names path.js takes from it.
// ---------------------------------------------------------------------------

// The engine's platform, not the host's: a guest runs on the engine's
// 'linux' whether the build is measured on a Mac, a Windows host, or a
// browser, so `path` is posix and matchesGlob is case-sensitive everywhere.
const isWindows = false;
const isMacOS = false;

function getLazy<T>(fn: () => T): () => T {
  let value: T;
  let loaded = false;
  return () => {
    if (!loaded) {
      value = fn();
      loaded = true;
    }
    return value;
  };
}

// ---------------------------------------------------------------------------
// internal/deps/minimatch/index — `path.matchesGlob` is the only caller, and
// it asks minimatch for one boolean under fixed options. Node's minimatch is
// 4k lines of a matcher the engine does not otherwise need; the engine's one
// glob-to-RegExp translation (`src/utils/glob.ts`, the same one fs's glob
// uses) answers it, under the two options that reach it: `platform`, which
// decides whether a backslash is a separator, and `nocase`.
// ---------------------------------------------------------------------------

interface MinimatchOptions {
  nocase?: boolean;
  platform?: string;
}

const minimatchStandIn = {
  minimatch(target: string, pattern: string, options?: MinimatchOptions): boolean {
    // path.matchesGlob passes windowsPathsNoEscape, so on the win32 flavour a
    // backslash is a separator in both the path and the pattern, never an
    // escape; folding both to '/' is what that option means.
    const windows = options?.platform === 'win32';
    const subject = windows ? target.replace(/\\/g, '/') : target;
    const glob = windows ? pattern.replace(/\\/g, '/') : pattern;
    return globToRegExp(glob, options?.nocase === true).test(subject);
  },
};

// ---------------------------------------------------------------------------
// The binding's `require`, and the one evaluation of Node's file.
// ---------------------------------------------------------------------------

function nodeInternalRequire(specifier: string): unknown {
  switch (specifier) {
    case 'internal/constants':
      return constants;
    case 'internal/validators':
      return { validateObject, validateString };
    case 'internal/util':
      return { getLazy, isWindows, isMacOS };
    case 'internal/deps/minimatch/index':
      return minimatchStandIn;
    case 'internal/errors':
      return { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } };
    default:
      throw new Error(`node-lib/path.js asked for an internal the binding does not provide: ${specifier}`);
  }
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export interface FormatInputPathObject {
  root?: string | undefined;
  dir?: string | undefined;
  base?: string | undefined;
  ext?: string | undefined;
  name?: string | undefined;
}

export interface PlatformPath {
  normalize(path: string): string;
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  parse(path: string): ParsedPath;
  format(pathObject: FormatInputPathObject): string;
  toNamespacedPath<T>(path: T): T;
  matchesGlob(path: string, pattern: string): boolean;
  _makeLong<T>(path: T): T;
  readonly sep: string;
  readonly delimiter: string;
  readonly posix: PlatformPath;
  readonly win32: PlatformPath;
}

// The vendored file is a CommonJS module of the Node runtime: it is handed the
// scope Node would have handed it and run once. The engine already loads its
// vendored punycode this way (src/punycode-source.ts).
const nodePath: PlatformPath = (() => {
  const module: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('primordials', 'require', 'module', 'exports', 'process', NODE_PATH_SOURCE)(
    primordials,
    nodeInternalRequire,
    module,
    module.exports,
    processBinding,
  );
  return module.exports as PlatformPath;
})();

export const posix: PlatformPath = nodePath.posix;
export const win32: PlatformPath = nodePath.win32;

// The engine's flavour is the one Node picks for this platform — posix, since
// the engine's process never reports win32. The named exports are its own
// members, so `path.join === join` as in Node.
export const sep = nodePath.sep;
export const delimiter = nodePath.delimiter;
export const normalize = nodePath.normalize;
export const join = nodePath.join;
export const resolve = nodePath.resolve;
export const isAbsolute = nodePath.isAbsolute;
export const relative = nodePath.relative;
export const dirname = nodePath.dirname;
export const basename = nodePath.basename;
export const extname = nodePath.extname;
export const parse = nodePath.parse;
export const format = nodePath.format;
export const toNamespacedPath = nodePath.toNamespacedPath;
export const matchesGlob = nodePath.matchesGlob;

export default nodePath;
