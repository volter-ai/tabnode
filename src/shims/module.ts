/**
 * Node.js module shim
 * Provides basic module system functionality
 */

import * as pathShim from './path';

export function createRequire(filename: string): (id: string) => unknown {
  // Return a require function that can be used by modules
  return function require(id: string): unknown {
    throw new Error(`Cannot find module '${id}' from '${filename}'`);
  };
}

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

export function isBuiltin(moduleName: string): boolean {
  // Strip node: prefix if present
  const name = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
  return builtinModules.includes(name);
}

export const _cache: Record<string, unknown> = {};
export const _extensions: Record<string, unknown> = {
  '.js': () => {},
  '.json': () => {},
  '.node': (_module: unknown, filename?: string) => {
    throw Object.assign(new Error('Cannot load native addon ' + (filename || '') + ': a tab runs no native code.'), { code: 'ERR_DLOPEN_FAILED' });
  },
};
export const _pathCache: Record<string, string> = {};

export function syncBuiltinESMExports(): void {
  // No-op in browser
}

export const Module = {
  createRequire,
  builtinModules,
  isBuiltin,
  _cache,
  _extensions,
  _pathCache,
  syncBuiltinESMExports,
};

export default Module;
