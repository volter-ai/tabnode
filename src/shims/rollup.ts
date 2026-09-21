/**
 * Rollup shim - Uses @rollup/browser for browser-compatible Rollup
 *
 * Vite uses Rollup for bundling. The native Rollup package doesn't work
 * in browsers, so we need to use @rollup/browser instead.
 */

import { heldWork } from '../host-globals';
import * as acorn from 'acorn';
import { ROLLUP_BROWSER_CDN, ROLLUP_BROWSER_VERSION } from '../config/cdn';

/** What a rollup build is handed, and what it answers. */
export interface RollupBuildOptions { fs?: unknown; [key: string]: unknown }
export interface RollupBundle {
  generate?: (...args: unknown[]) => Promise<unknown>;
  write?: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __substrateCarried: (<T>(callback: T) => T) | undefined;
  // eslint-disable-next-line no-var
  var __browserRuntimeHeldWork: { count: number } | undefined;
  // eslint-disable-next-line no-var
  var __browserRuntimeRollupUrl: string | undefined;
  // eslint-disable-next-line no-var
  var __browserRuntimeRollupFs: unknown;
  // eslint-disable-next-line no-var
  var __browserRuntimeNativeSetTimeout: typeof setTimeout | undefined;
}

// Rollup instance loaded from CDN
let rollupInstance: unknown = null;
let loadPromise: Promise<unknown> | null = null;

/**
 * Load Rollup from CDN
 */
async function loadRollup(): Promise<unknown> {
  if (rollupInstance) return rollupInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      // Load @rollup/browser from CDN
      // The browser build comes from the page's own origin when the page says
      // where, the CDN otherwise: a guest's egress refuses the CDN.
      const rollup = await import(
        /* @vite-ignore */
        typeof globalThis.__browserRuntimeRollupUrl === 'string' ? globalThis.__browserRuntimeRollupUrl : ROLLUP_BROWSER_CDN
      );
      rollupInstance = rollup;
      console.log('[rollup] Browser version loaded');
      return rollup;
    } catch (error) {
      console.error('[rollup] Failed to load browser version:', error);
      loadPromise = null;
      throw error;
    }
  })();

  return loadPromise;
}

// For synchronous require(), we need a stub that works before async load
// This will be replaced when loadRollup() is called

export const VERSION = ROLLUP_BROWSER_VERSION;

/**
 * A script is not finished while its build is running. Rollup's work is held
 * so the process loop waits: the graph while `rollup()` builds it, the chunks
 * while `generate` or `write` renders them. A React Router build is Vite's
 * build, which is rollup's, and printed nothing for the half second the engine
 * waited, so the Dockerfile stage moved on with no `build/`.
 */
export async function rollup(options: RollupBuildOptions): Promise<RollupBundle> {
  const __held = heldWork();
  __held.count += 1;
  let bundle;
  try {
    const r = await loadRollup() as { rollup: (options: unknown) => Promise<RollupBundle> };
    // The guest's tree, for what no plugin resolved or loaded.
    const __fs = globalThis.__browserRuntimeRollupFs;
    bundle = await r.rollup(__fs && !options.fs ? { ...options, fs: __fs } : options);
  } finally {
    __held.count -= 1;
  }
  for (const name of ['generate', 'write'] as const) {
    if (typeof bundle[name] !== 'function') continue;
    const original = bundle[name].bind(bundle);
    bundle[name] = async (...args: unknown[]) => {
      __held.count += 1;
      try { return await original(...args); } finally { __held.count -= 1; }
    };
  }
  return bundle;
}

export async function watch(options: unknown): Promise<unknown> {
  const r = await loadRollup() as { watch: (options: unknown) => unknown };
  return r.watch(options);
}

// Export a function to pre-load rollup
export { loadRollup };

// Define plugin context types that Vite expects
export interface Plugin {
  name: string;
  [key: string]: unknown;
}

export interface PluginContext {
  meta: { rollupVersion: string };
  parse: (code: string) => unknown;
  [key: string]: unknown;
}

// parseAst/parseAstAsync — used by Vite's module system for ESM analysis
// Uses acorn as the parser (ESTree-compatible, like Rollup's native parser)
export function parseAst(input: string, options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean }): unknown {
  return acorn.parse(input, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: options?.allowReturnOutsideFunction ?? false,
    locations: true,
  });
}

export async function parseAstAsync(input: string, options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean; signal?: AbortSignal }): Promise<unknown> {
  return parseAst(input, options);
}

// Stub for native module detection - this prevents the "unsupported platform" error
export function getPackageBase(): string {
  return '';
}

// Export default that matches Rollup's API
export default {
  VERSION,
  rollup,
  watch,
  loadRollup,
  parseAst,
  parseAstAsync,
};
