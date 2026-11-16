/**
 * `path`, as Node's own `lib/path.js`, for the engine's own code and the library's `path` export.
 *
 * A guest's `require('path')` is Node v24.21.0's `lib/path.js` in its process's builtin graph (`node-lib/load.ts`),
 * over Node's own `internal/constants`, `internal/validators`, `internal/errors`, `internal/util` and, for
 * `matchesGlob`, `internal/fs/glob` with its vendored minimatch. The engine's own TypeScript and the library export
 * take that same file through the same loader, on first use, as `url.ts` takes `url`: the default stands for Node's
 * `path` object, which is `path.posix` itself, the flavour Node picks on the engine's platform.
 */
import { lazyExport, lazyModule } from '../node-lib/lazy';

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

// Node's `path`, loaded on the first use of anything here, never when this module is evaluated: the engine is imported
// before a node realm's program is attached, and Node's library read then would build the program's bindings in their
// engine form (ADR-0018 §7). `path` is its posix flavour itself, as lib/path.js exports it, and `path/win32` the other;
// each name stands for Node's own (lazy.ts), and every member read through them, `sep` and `delimiter` among them, is
// Node's.
export const posix = lazyModule<PlatformPath>('path');
export const win32 = lazyModule<PlatformPath>('path/win32');

export const normalize = lazyExport<PlatformPath['normalize']>('path', 'normalize');
export const join = lazyExport<PlatformPath['join']>('path', 'join');
export const resolve = lazyExport<PlatformPath['resolve']>('path', 'resolve');
export const isAbsolute = lazyExport<PlatformPath['isAbsolute']>('path', 'isAbsolute');
export const relative = lazyExport<PlatformPath['relative']>('path', 'relative');
export const dirname = lazyExport<PlatformPath['dirname']>('path', 'dirname');
export const basename = lazyExport<PlatformPath['basename']>('path', 'basename');
export const extname = lazyExport<PlatformPath['extname']>('path', 'extname');
export const parse = lazyExport<PlatformPath['parse']>('path', 'parse');
export const format = lazyExport<PlatformPath['format']>('path', 'format');
export const toNamespacedPath = lazyExport<PlatformPath['toNamespacedPath']>('path', 'toNamespacedPath');
export const matchesGlob = lazyExport<PlatformPath['matchesGlob']>('path', 'matchesGlob');

export default posix;
