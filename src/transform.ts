/**
 * ESM to CJS Transformer using esbuild-wasm
 *
 * Transforms ES modules to CommonJS format during npm install,
 * so require() can work synchronously.
 */

import { VirtualFS } from './virtual-fs';
import { ESBUILD_WASM_ESM_CDN, ESBUILD_WASM_BINARY_CDN } from './config/cdn';
// The dev servers and this transformer took a realm without a window for no
// browser at all and served a file untransformed. A realm with an esbuild
// host installed, the engine's worker among them, transforms through it
// wherever it is.
import { getEsbuildInstance } from './shims/esbuild';

// Check if we're in a browser environment
const isBrowser = typeof window !== 'undefined';

// Window.__esbuild type is declared in src/types/external.d.ts

/**
 * Node's builtin specifiers, for the dynamic imports the transformer lowers.
 *
 * A CommonJS module's `import("fs/promises")` reaches the browser's own import
 * and fails on the bare specifier, so the subpath builtins are on this list
 * too. `stream/web` is the web streams the worker already has as globals,
 * which file-type, on Dub's middleware path, could not find; and `constants`
 * is Node's old flat table of fs, os and signal numbers, which graceful-fs
 * still requires on its way into every React Router build.
 *
 * There was one of these lists per lowering path and they drifted: the path
 * for a package that is already CommonJS carried only the twenty-nine
 * top-level names, so a pre-bundled package's `import("fs/promises")`,
 * `import("stream/web")` or `import("constants")` went to the browser
 * untouched and the import rejected. One list serves both.
 */
const NODE_DYNAMIC_IMPORT_BUILTINS = [
  'stream/web', 'fs/promises', 'stream/promises', 'stream/consumers',
  'timers/promises', 'dns/promises', 'readline/promises', 'path/posix',
  'path/win32', 'util/types', 'assert/strict',
  'assert', 'buffer', 'constants', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks',
  'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'async_hooks', 'inspector', 'module',
];

/** `import("node:x")` and `import("x")` for a builtin, lowered to `require`. */
function lowerDynamicBuiltinImports(code: string): string {
  // The browser fetches `node:http` as a URL, so the prefixed form goes first.
  let lowered = code.replace(
    /\bimport\s*\(\s*["']node:([^"']+)["']\s*\)/g,
    'Promise.resolve(require("node:$1"))'
  );
  for (const builtin of NODE_DYNAMIC_IMPORT_BUILTINS) {
    // Match import("fs") or import('fs') but not import("fs-extra") etc
    const pattern = new RegExp(`\\bimport\\s*\\(\\s*["']${builtin}["']\\s*\\)`, 'g');
    lowered = lowered.replace(pattern, `Promise.resolve(require("${builtin}"))`);
  }
  return lowered;
}

/**
 * Initialize esbuild-wasm (reuses existing instance if already initialized)
 */
export async function initTransformer(): Promise<void> {
  if (getEsbuildInstance()) return;
  // Skip in non-browser environments (tests)
  if (!isBrowser) {
    console.log('[transform] Skipping esbuild init (not in browser)');
    return;
  }

  // Reuse existing esbuild instance from window (may have been initialized by next-dev-server)
  if (window.__esbuild) {
    console.log('[transform] Reusing existing esbuild instance');
    return;
  }

  // If another init is in progress, wait for it
  if (window.__esbuildInitPromise) {
    return window.__esbuildInitPromise;
  }

  window.__esbuildInitPromise = (async () => {
    try {
      console.log('[transform] Loading esbuild-wasm...');

      // Load esbuild-wasm from CDN
      const mod = await import(
        /* @vite-ignore */
        ESBUILD_WASM_ESM_CDN
      );

      // esm.sh wraps the module - get the actual esbuild object
      const esbuildMod = mod.default || mod;

      try {
        await esbuildMod.initialize({
          wasmURL: ESBUILD_WASM_BINARY_CDN,
        });
        console.log('[transform] esbuild-wasm initialized');
      } catch (initError) {
        // Handle "already initialized" error gracefully
        if (initError instanceof Error && initError.message.includes('Cannot call "initialize" more than once')) {
          console.log('[transform] esbuild-wasm already initialized, reusing');
        } else {
          throw initError;
        }
      }

      window.__esbuild = esbuildMod;
    } catch (error) {
      console.error('[transform] Failed to initialize esbuild:', error);
      window.__esbuildInitPromise = undefined;
      throw error;
    }
  })();

  return window.__esbuildInitPromise;
}

/**
 * Check if transformer is ready
 */
export function isTransformerReady(): boolean {
  if (getEsbuildInstance()) return true;
  // In non-browser, we skip transformation
  if (!isBrowser) return true;
  return window.__esbuild !== undefined;
}

/**
 * Transform a single file from ESM to CJS
 */
export async function transformFile(
  code: string,
  filename: string
): Promise<string> {
  // Skip in non-browser environments
  if (!getEsbuildInstance() && !isBrowser) {
    return code;
  }

  if (!getEsbuildInstance() && !window.__esbuild) {
    await initTransformer();
  }

  const esbuild = getEsbuildInstance() ?? window.__esbuild;
  if (!esbuild) {
    throw new Error('esbuild not initialized');
  }

  // Determine loader based on file extension
  let loader: 'js' | 'jsx' | 'ts' | 'tsx' = 'js';
  if (filename.endsWith('.jsx')) loader = 'jsx';
  else if (filename.endsWith('.ts')) loader = 'ts';
  else if (filename.endsWith('.tsx')) loader = 'tsx';
  else if (filename.endsWith('.mjs')) loader = 'js';

  try {
    const result = await esbuild.transform(code, {
      loader,
      format: 'cjs',
      target: 'esnext',
      platform: 'neutral',
      // Replace import.meta with our runtime-provided variable
      // This is the proper esbuild way to handle import.meta in CJS
      define: {
        'import.meta.url': 'import_meta.url',
        'import.meta.dirname': 'import_meta.dirname',
        'import.meta.filename': 'import_meta.filename',
        'import.meta': 'import_meta',
      },
    });

    // Dynamic imports of Node's builtins are lowered to `require`, the
    // prefixed and bare forms alike; the list and the rewrite are shared with
    // the already-CommonJS path below.
    const transformed = lowerDynamicBuiltinImports(result.code);

    return transformed;
  } catch (error: unknown) {
    // Check if it's a top-level await error - these files are usually CLI entry points
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('Top-level await')) {
      console.log(`[transform] Skipping ${filename} (has top-level await, likely CLI entry point)`);
      // Return original code - it won't be require()'d directly anyway
      return code;
    }

    console.warn(`[transform] Failed to transform ${filename}:`, error);
    // Return original code if transform fails
    return code;
  }
}

/**
 * Check if a file needs ESM to CJS transformation
 */
function needsTransform(filename: string, code: string): boolean {
  // .mjs files are always ESM
  if (filename.endsWith('.mjs')) {
    return true;
  }

  // .cjs files are always CJS
  if (filename.endsWith('.cjs')) {
    return false;
  }

  // Check for ESM syntax
  const hasImport = /\bimport\s+[\w{*'"]/m.test(code);
  const hasExport = /\bexport\s+(?:default|const|let|var|function|class|{|\*)/m.test(code);
  const hasImportMeta = /\bimport\.meta\b/.test(code);

  return hasImport || hasExport || hasImportMeta;
}

/**
 * Check if a file has dynamic imports that need patching
 */
function hasDynamicNodeImports(code: string): boolean {
  // Check for import("node:...") or import('node:...')
  if (/\bimport\s*\(\s*["']node:/.test(code)) {
    return true;
  }
  // Any builtin the lowering knows, not the eleven names this test used to
  // carry: a package whose only dynamic builtin import was `child_process` or
  // `fs/promises` was never offered to the lowering at all.
  const names = NODE_DYNAMIC_IMPORT_BUILTINS.map((name) => name.replace('/', '\\/')).join('|');
  return new RegExp(`\\bimport\\s*\\(\\s*["'](?:${names})["']\\s*\\)`).test(code);
}

/**
 * Patch dynamic imports in already-CJS code (e.g., pre-bundled packages)
 */
function patchDynamicImports(code: string): string {
  return lowerDynamicBuiltinImports(code);
}

/**
 * Transform all ESM files in a package directory to CJS
 */
export async function transformPackage(
  vfs: VirtualFS,
  pkgPath: string,
  onProgress?: (msg: string) => void
): Promise<number> {
  let transformedCount = 0;

  // Find all JS files in the package
  const jsFiles = findJsFiles(vfs, pkgPath);

  onProgress?.(`  Transforming ${jsFiles.length} files in ${pkgPath}...`);

  // Transform files in batches
  const BATCH_SIZE = 10;
  for (let i = 0; i < jsFiles.length; i += BATCH_SIZE) {
    const batch = jsFiles.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (filePath) => {
        try {
          const code = vfs.readFileSync(filePath, 'utf8');

          if (needsTransform(filePath, code)) {
            // Full ESM to CJS transformation
            const transformed = await transformFile(code, filePath);
            vfs.writeFileSync(filePath, transformed);
            transformedCount++;
          } else if (hasDynamicNodeImports(code)) {
            // Just patch dynamic imports in already-CJS code
            const patched = patchDynamicImports(code);
            vfs.writeFileSync(filePath, patched);
            transformedCount++;
          }
        } catch (error) {
          // Skip files that can't be read/transformed
          console.warn(`[transform] Skipping ${filePath}:`, error);
        }
      })
    );
  }

  return transformedCount;
}

/**
 * Find all JavaScript files in a directory recursively
 */
function findJsFiles(vfs: VirtualFS, dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = vfs.readdirSync(dir);

    for (const entry of entries) {
      const fullPath = dir + '/' + entry;

      try {
        const stat = vfs.statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules inside packages (nested deps)
          if (entry !== 'node_modules') {
            files.push(...findJsFiles(vfs, fullPath));
          }
        } else if (
          entry.endsWith('.js') ||
          entry.endsWith('.mjs') ||
          entry.endsWith('.jsx')
        ) {
          files.push(fullPath);
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files;
}
