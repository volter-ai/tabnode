/**
 * The names of Node's builtins the engine answers, and Node's `isBuiltin` over them.
 *
 * `require('module')` is the runtime's own `Module` class (runtime.ts, `id === 'module'` in `requirePlain`), whose
 * `builtinModules` and `isBuiltin` are these; nothing else of Node's `module` is answered from this file.
 */

// Node's subpath builtins are builtins too (`require('module').builtinModules` lists them): a program that asks
// `isBuiltin('fs/promises')` before it resolves -- require-in-the-middle's wrapper, OpenTelemetry's, an APM's --
// was told no, resolved the name as a file and threw "Cannot find module 'fs/promises'" (Activepieces' server).
// Only names the engine answers are listed (runtime.ts checks each has a module).
export const builtinModules = [
  'assert',
  'assert/strict',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];

/** Canonical loader identity; scheme-only builtins keep their scheme. */
export function normalizeBuiltin(moduleName: string): string | undefined {
  if (moduleName === 'node:sqlite') return moduleName;
  const name = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
  return builtinModules.includes(name) ? name : undefined;
}

export function isBuiltin(moduleName: string): boolean {
  return normalizeBuiltin(moduleName) !== undefined;
}
