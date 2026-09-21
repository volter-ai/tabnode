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

export const builtinModules = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
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
