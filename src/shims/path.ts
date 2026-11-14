/**
 * `path`, as Node's own `lib/path.js`, for the engine's own code and the library's `path` export.
 *
 * A guest's `require('path')` is Node v24.21.0's `lib/path.js` in its process's builtin graph (`node-lib/load.ts`),
 * over Node's own `internal/constants`, `internal/validators`, `internal/errors`, `internal/util` and, for
 * `matchesGlob`, `internal/fs/glob` with its vendored minimatch. The engine's own TypeScript reads that same file
 * through the same loader, outside any process, on its first use rather than when this module is evaluated (the
 * rule `node-lib/lazy.ts` states): `posix` and `win32` are Node's objects, and each function below is `posix`'s.
 * The default export is `posix`, the flavour Node picks on the engine's platform, as `path.js` exports it.
 */
import { lazyModule } from '../node-lib/lazy';

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

/** `require('path')`, which is `path.posix` itself (`posix.posix === posix`). */
export const posix: PlatformPath = lazyModule<PlatformPath>('path');
export const win32: PlatformPath = lazyModule<PlatformPath>('path', 'win32');

export function normalize(path: string): string { return posix.normalize(path); }
export function join(...paths: string[]): string { return posix.join(...paths); }
export function resolve(...paths: string[]): string { return posix.resolve(...paths); }
export function isAbsolute(path: string): boolean { return posix.isAbsolute(path); }
export function relative(from: string, to: string): string { return posix.relative(from, to); }
export function dirname(path: string): string { return posix.dirname(path); }
export function basename(path: string, suffix?: string): string { return posix.basename(path, suffix); }
export function extname(path: string): string { return posix.extname(path); }
export function parse(path: string): ParsedPath { return posix.parse(path); }
export function format(pathObject: FormatInputPathObject): string { return posix.format(pathObject); }
export function toNamespacedPath<T>(path: T): T { return posix.toNamespacedPath(path); }
export function matchesGlob(path: string, pattern: string): boolean { return posix.matchesGlob(path, pattern); }

export default posix;
