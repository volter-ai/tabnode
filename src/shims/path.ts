/**
 * `path`, as Node's own `lib/path.js`, for the engine's own code and the library's `path` export.
 *
 * A guest's `require('path')` is Node v24.21.0's `lib/path.js` in its process's builtin graph (`node-lib/load.ts`),
 * over Node's own `internal/constants`, `internal/validators`, `internal/errors`, `internal/util` and, for
 * `matchesGlob`, `internal/fs/glob` with its vendored minimatch. The engine's own TypeScript and the library export
 * take that same file through the same loader, loaded when this module is evaluated as `net-module.ts` loads `net`,
 * so every export here IS Node's: the default is `path.posix` itself (`posix.posix === posix`, the flavour Node picks
 * on the engine's platform, as `path.js` exports it), and each name is its own member (`path.join === join`).
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

const nodePath = loadNodeLib('path') as PlatformPath;

export const posix: PlatformPath = nodePath.posix;
export const win32: PlatformPath = nodePath.win32;

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
