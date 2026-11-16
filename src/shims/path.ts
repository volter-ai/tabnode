/**
 * `path`, as Node's own `lib/path.js`, for the engine's own code and the library's `path` export.
 *
 * A guest's `require('path')` is Node v24.21.0's `lib/path.js` in its process's builtin graph (`node-lib/load.ts`),
 * over Node's own `internal/constants`, `internal/validators`, `internal/errors`, `internal/util` and, for
 * `matchesGlob`, `internal/fs/glob` with its vendored minimatch. The engine's own TypeScript and the library export
 * take that same file through the same loader, on first use, so every export here stands for Node's: the default is
 * `path.posix` itself (`posix.posix === posix`, the flavour Node picks on the engine's platform, as `path.js` exports
 * it), and each name is its own member (`path.join === join`).
 */
import { loadNodeLib } from '../node-lib/load';

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

/**
 * Node's `path` module, loaded on the first use of anything here, never when this module is evaluated: the engine is
 * imported before a node realm's program is attached, and Node's library read then would build the program's
 * bindings in their engine form (ADR-0018 §7). Each name below stands for Node's own object or function, and every
 * read through one answers the stand-in where Node's answer is one of Node's objects or functions named here, so the
 * identities hold as Node's do: `posix.posix === posix`, `posix.win32 === win32`, `posix.join === join`.
 */
let loaded: { posix: PlatformPath; win32: PlatformPath } | undefined;
const standFor = new Map<unknown, unknown>();
const FUNCTIONS = ['normalize', 'join', 'resolve', 'isAbsolute', 'relative', 'dirname', 'basename', 'extname', 'parse',
  'format', 'toNamespacedPath', 'matchesGlob'] as const;
type PathFunction = typeof FUNCTIONS[number];

function nodePath(): { posix: PlatformPath; win32: PlatformPath } {
  if (loaded) return loaded;
  const module = loadNodeLib('path') as PlatformPath;
  loaded = { posix: module.posix, win32: module.win32 };
  standFor.set(loaded.posix, posix);
  standFor.set(loaded.win32, win32);
  for (const name of FUNCTIONS) standFor.set(loaded.posix[name], functions[name]);
  return loaded;
}

/** What a read of Node's answers: the stand-in where the value is one of Node's named here. */
function stood(value: unknown): unknown {
  return standFor.get(value) ?? value;
}

/** One of Node's two flavours, read on first use. */
function flavour(key: 'posix' | 'win32'): PlatformPath {
  const real = (): PlatformPath => nodePath()[key];
  return new Proxy({} as PlatformPath, {
    get: (_target, name) => stood(Reflect.get(real(), name)),
    set: (_target, name, value) => Reflect.set(real(), name, value),
    has: (_target, name) => Reflect.has(real(), name),
    deleteProperty: (_target, name) => Reflect.deleteProperty(real(), name),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_target, name) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(real(), name);
      if (descriptor === undefined) return undefined;
      return 'value' in descriptor ? { ...descriptor, value: stood(descriptor.value), configurable: true } : { ...descriptor, configurable: true };
    },
    defineProperty: (_target, name, descriptor) => Reflect.defineProperty(real(), name, descriptor),
    getPrototypeOf: () => Reflect.getPrototypeOf(real()),
  });
}

/** One of `path.posix`'s methods, read on first call. */
function method(name: PathFunction): PlatformPath[PathFunction] {
  const real = (): (...args: unknown[]) => unknown => nodePath().posix[name] as unknown as (...args: unknown[]) => unknown;
  // An arrow function is the target: Node's methods are methods, with no `prototype`, and neither is constructed.
  return new Proxy((() => undefined) as unknown as PlatformPath[PathFunction], {
    apply: (_target, thisArg, args) => Reflect.apply(real(), thisArg, args),
    get: (_target, key) => stood(Reflect.get(real(), key)),
    has: (_target, key) => Reflect.has(real(), key),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(real(), key);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(real()),
  });
}

export const posix: PlatformPath = flavour('posix');
export const win32: PlatformPath = flavour('win32');
const functions = Object.fromEntries(FUNCTIONS.map((name) => [name, method(name)])) as { [K in PathFunction]: PlatformPath[K] };

// lib/path.js's posix `sep` and `delimiter`, the flavour of the engine's platform: strings, known without the file.
export const sep = '/';
export const delimiter = ':';
export const normalize = functions.normalize;
export const join = functions.join;
export const resolve = functions.resolve;
export const isAbsolute = functions.isAbsolute;
export const relative = functions.relative;
export const dirname = functions.dirname;
export const basename = functions.basename;
export const extname = functions.extname;
export const parse = functions.parse;
export const format = functions.format;
export const toNamespacedPath = functions.toNamespacedPath;
export const matchesGlob = functions.matchesGlob;

export default posix;
