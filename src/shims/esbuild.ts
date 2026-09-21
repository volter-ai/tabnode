/**
 * esbuild shim - Uses esbuild-wasm for transforms in the browser
 * Provides VFS integration for file access
 */

import { heldWork } from '../host-globals';
import type { VirtualFS } from '../virtual-fs';
import { ESBUILD_WASM_BINARY_CDN, ESBUILD_WASM_BROWSER_CDN } from '../config/cdn';
import { __nodeResolverFor } from '../node-resolver';

/**
 * Node.js built-in module names. Used by the VFS plugin to provide empty stubs
 * for builtins that leak as transitive deps (e.g., `path` from `@vercel/oidc`).
 */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks',
  'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'async_hooks',
  'inspector', 'module', 'process', 'console', 'constants', 'domain',
  'punycode', 'sys', 'tty',
]);

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a package.json exports map entry.
 * Can be a direct path string or a conditional exports object with nested conditions.
 *
 * @example Direct string entry:
 * ```json
 * { "exports": "./dist/index.js" }
 * ```
 *
 * @example Conditional exports:
 * ```json
 * {
 *   "exports": {
 *     ".": {
 *       "import": "./dist/esm/index.js",
 *       "require": "./dist/cjs/index.js"
 *     }
 *   }
 * }
 * ```
 *
 * @example Nested conditions (e.g., convex package):
 * ```json
 * {
 *   "exports": {
 *     "./server": {
 *       "convex": {
 *         "import": "./dist/server.js"
 *       },
 *       "default": "./dist/server.js"
 *     }
 *   }
 * }
 * ```
 */
type ExportEntry = string | ExportConditions;

/**
 * Conditional exports object mapping condition names to export entries.
 * Conditions can be nested to support complex resolution scenarios.
 */
interface ExportConditions {
  [condition: string]: ExportEntry;
}

/**
 * Result of resolving a node module import.
 */
interface NodeModuleResolution {
  /** The resolved absolute path to the module file */
  path: string;
  /** Plugin data to pass to the onLoad handler */
  pluginData: { fromVFS: boolean };
}

// esbuild-wasm types
export interface TransformOptions {
  loader?: 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css';
  format?: 'iife' | 'cjs' | 'esm';
  target?: string | string[];
  minify?: boolean;
  sourcemap?: boolean | 'inline' | 'external';
  jsx?: 'transform' | 'preserve';
  jsxFactory?: string;
  jsxFragment?: string;
}

/** A message esbuild returned, as much of it as the formatter reads. */
export interface EsbuildMessage {
  text?: string;
  location?: { file: string; line: number; column: number } | null;
  notes?: Array<{ text: string }>;
}

/** A build's metafile, as much of it as the summary reads. */
export interface EsbuildMetafile {
  outputs?: Record<string, { bytes?: number }>;
}

export interface TransformResult {
  code: string;
  map: string;
  warnings: unknown[];
}

export interface BuildOptions {
  /**
   * esbuild's two entry forms: a list of files, and the named form
   * `{ out: "in.ts" }` that gives each output its own name. Only the list is
   * made absolute against the working directory; the named form is passed on
   * as it was written.
   */
  entryPoints?: string[] | Record<string, string>;
  stdin?: { contents: string; resolveDir?: string; loader?: 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css' };
  bundle?: boolean;
  outdir?: string;
  outfile?: string;
  format?: 'iife' | 'cjs' | 'esm';
  platform?: 'browser' | 'node' | 'neutral';
  target?: string | string[];
  minify?: boolean;
  sourcemap?: boolean | 'inline' | 'external';
  external?: string[];
  write?: boolean;
  plugins?: unknown[];
  absWorkingDir?: string;
  /** Path of a tsconfig, read from the engine's filesystem and handed to esbuild as `tsconfigRaw`. */
  tsconfig?: string;
  tsconfigRaw?: string | TsconfigJson;
  /** Where a workspace member's sources are, as tsconfig paths with absolute targets. */
  workspacePaths?: Record<string, string[]>;
  /**
   * The packages this build is not of: an import of one is left to whoever
   * builds it, external under the specifier it was written with, rather than
   * bundled in. `self` are the specifiers this build IS of, which stay inside
   * it however they are imported. The ones an import actually reached come
   * back as `neighbors` on the result.
   */
  neighbors?: { names: string[]; self?: string[] };
}

export interface BuildResult {
  errors: unknown[];
  warnings: unknown[];
  /** The specifiers `neighbors` left external, sorted; absent when a build named none. */
  neighbors?: string[];
  outputFiles?: Array<{ path: string; contents: Uint8Array; text: string }>;
  metafile?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
}

// Window.__esbuild type is declared in src/types/external.d.ts

// ============================================================================
// Export Condition Resolution
// ============================================================================

/**
 * The priority order for export conditions when resolving package exports.
 *
 * Order rationale:
 * 1. "module" - ESM entry point (preferred for modern bundlers)
 * 2. "import" - ESM import condition (standard Node.js condition)
 * 3. "require" - CJS require condition (fallback for CommonJS)
 * 4. "default" - Fallback condition (lowest priority)
 *
 * Packages with custom conditions (e.g. "convex", "react-native") will
 * fall through to one of these standard conditions.
 */
const EXPORT_CONDITION_PRIORITY = ['module', 'import', 'require', 'default'] as const;

/**
 * Resolves a package.json exports entry to a file path by evaluating export conditions.
 *
 * This function handles the Node.js package exports map resolution algorithm,
 * supporting both simple string exports and conditional exports with nested structures.
 *
 * @param entry - The exports map entry to resolve. Can be:
 *   - A string path (e.g., "./dist/index.js")
 *   - A conditional exports object with condition keys
 *   - Nested conditional objects for complex packages
 *
 * @returns The resolved file path relative to the package root, or undefined if
 *          no matching condition is found.
 *
 * @example Simple string entry:
 * ```ts
 * resolveExportConditions("./dist/index.js")
 * // Returns: "./dist/index.js"
 * ```
 *
 * @example Conditional exports:
 * ```ts
 * resolveExportConditions({
 *   import: "./dist/esm/index.js",
 *   require: "./dist/cjs/index.js",
 *   default: "./dist/index.js"
 * })
 * // Returns: "./dist/esm/index.js" (import has higher priority)
 * ```
 *
 * @example Nested conditions (convex package style):
 * ```ts
 * resolveExportConditions({
 *   convex: { import: "./dist/convex.js" },
 *   default: "./dist/default.js"
 * })
 * // Returns: "./dist/convex.js" (convex condition with nested import)
 * ```
 */
function resolveExportConditions(entry: ExportEntry): string | undefined {
  // Direct string path - return as-is
  if (typeof entry === 'string') {
    return entry;
  }

  // Conditional exports object - evaluate conditions in priority order
  if (typeof entry === 'object' && entry !== null) {
    for (const condition of EXPORT_CONDITION_PRIORITY) {
      const conditionValue = entry[condition];
      if (conditionValue !== undefined) {
        // Recursively resolve nested conditions
        const result = resolveExportConditions(conditionValue);
        if (result) {
          return result;
        }
      }
    }
  }

  return undefined;
}

// ============================================================================
// Node Modules Resolution
// ============================================================================

/**
 * Resolves a bare import (e.g. "convex/server", "react") to an absolute file
 * path in the VFS, so the browser build bundles the dependency a snapshot of
 * node_modules holds rather than leaving it external with no runtime to load it.
 *
 * The plugin used to carry its own subset of Node's algorithm, as the runtime's
 * require and the simple loader each carried theirs; the three disagreed with
 * each other and with Node, and every app found a new gap. They all ask the
 * shared resolver now (`node-resolution.ts` behind `node-resolver.ts`), this
 * one with the bundler's profile: module and import entries first, TypeScript
 * sources, and the extensions the build was given. The importer's directory is
 * where the walk starts, so a package in a workspace finds its own copy in the
 * node_modules tree nearest the importing file rather than the root's.
 */
function resolveNodeModuleImport(
  vfs: VirtualFS,
  importPath: string,
  extensions: string[],
  importer: string = ''
): NodeModuleResolution | null {
  const __importerDir = importer.startsWith('/') ? (importer.slice(0, importer.lastIndexOf('/')) || '/') : '/';
  const __resolved = __nodeResolverFor(vfs, 'bundler', extensions).resolve(importPath, __importerDir);
  return __resolved ? { path: __resolved, pluginData: { fromVFS: true } } : null;
}

/**
 * Resolves a subpath import (e.g., "convex/server" -> "./server" subpath).
 *
 * Resolution order:
 * 1. Check exports map for "./{subpath}" key with condition resolution
 * 2. Fall back to direct file path resolution with extensions
 */
function resolveSubpathImport(
  vfs: VirtualFS,
  packageJson: { exports?: Record<string, ExportEntry> | ExportEntry },
  nodeModulesBase: string,
  subPath: string,
  extensions: string[]
): string | null {
  // Try exports map first
  if (packageJson.exports && typeof packageJson.exports === 'object') {
    const exportKey = './' + subPath;
    const exportsMap = packageJson.exports as Record<string, ExportEntry>;
    const exportEntry = exportsMap[exportKey];

    if (exportEntry) {
      const exportPath = resolveExportConditions(exportEntry);
      if (exportPath) {
        const resolvedPath = nodeModulesBase + '/' + exportPath.replace(/^\.\//, '');
        const foundPath = findVFSFile(vfs, resolvedPath, ['', '.js', '.ts', '.mjs']);
        if (foundPath) {
          return foundPath;
        }
      }
    }
  }

  // Fall back to direct path resolution
  const directPath = nodeModulesBase + '/' + subPath;
  return findVFSFile(vfs, directPath, extensions);
}

/**
 * Resolves the main entry point of a package (e.g., "convex" without subpath).
 *
 * Resolution order:
 * 1. Check exports map "." key with condition resolution
 * 2. Fall back to "module" field (ESM entry)
 * 3. Fall back to "main" field (CJS entry)
 * 4. Default to "index.js"
 */
function resolveMainImport(
  vfs: VirtualFS,
  packageJson: {
    exports?: Record<string, ExportEntry> | ExportEntry;
    module?: string;
    main?: string;
  },
  nodeModulesBase: string,
  extensions: string[]
): string | null {
  // Try exports map first
  if (packageJson.exports) {
    // The main export can be at "." key or be the exports value itself
    const mainExport = typeof packageJson.exports === 'object' && !Array.isArray(packageJson.exports)
      ? (packageJson.exports['.'] || packageJson.exports)
      : packageJson.exports;

    const exportPath = resolveExportConditions(mainExport as ExportEntry);
    if (exportPath) {
      const resolvedPath = nodeModulesBase + '/' + exportPath.replace(/^\.\//, '');
      const foundPath = findVFSFile(vfs, resolvedPath, ['', '.js', '.ts', '.mjs']);
      if (foundPath) {
        return foundPath;
      }
    }
  }

  // Fall back to module/main fields
  // Prefer "module" (ESM) over "main" (CJS) for better tree-shaking
  const mainField = packageJson.module || packageJson.main || 'index.js';
  const resolvedPath = nodeModulesBase + '/' + mainField.replace(/^\.\//, '');
  return findVFSFile(vfs, resolvedPath, extensions);
}

// ============================================================================
// Module State
// ============================================================================

// State
/**
 * The esbuild this realm builds and transforms through: the wasm module
 * loaded here, or a host installed with `useHost`. A realm with a host has
 * one wherever it is, window or no window.
 */
let esbuildInstance: typeof import('esbuild-wasm') | null = null;

/**
 * The instance, for the lanes outside this module that need it: the module
 * transformer and the dev servers. Exporting the `let` itself put a live
 * binding in the shim's namespace, which is the surface a guest's
 * `require("esbuild")` reads; an accessor keeps that surface a stable
 * function rather than a value that changes under the guest.
 */
export function getEsbuildInstance(): typeof import('esbuild-wasm') | null {
  return esbuildInstance;
}
let initPromise: Promise<void> | null = null;
let wasmURL = ESBUILD_WASM_BINARY_CDN;
let globalVFS: VirtualFS | null = null;

/**
 * Where esbuild-wasm is loaded from, so the page can serve it from its own
 * origin instead of a CDN.
 */
let esbuildModuleURL = ESBUILD_WASM_BROWSER_CDN;
export function setModuleURL(url: string): void {
  esbuildModuleURL = url;
}

/** An esbuild that runs elsewhere: a host a realm sends its builds to. */
export interface EsbuildHost {
  build: (options: BuildOptions) => Promise<BuildResult>;
  transform: (code: string, options?: TransformOptions) => Promise<TransformResult>;
  /** A host that can answer a transform before returning, native esbuild under a Node host, answers `transformSync`. */
  transformSync?: (code: string, options?: TransformOptions) => TransformResult;
  prebundle?: (options: BuildOptions) => Promise<BuildResult>;
  /**
   * The host answers the `neighbors` option itself: a build carrying it
   * crosses with the option in place and no plugin, since a plugin is a
   * function in this realm and cannot cross. A host that does not say so is
   * given the shim's plugin, as esbuild itself would be.
   */
  neighbors?: boolean;
}
let currentHost: EsbuildHost | null = null;

let inlineEsbuild: Promise<typeof import('esbuild-wasm')> | null = null;
function ownEsbuild(): Promise<typeof import('esbuild-wasm')> {
  // A build that brings plugins of its own, a bundler such as tsup does,
  // cannot cross to the host: a plugin is a function in this realm. It
  // runs on esbuild here, loaded once and kept; the host stays for the
  // builds that carry only the filesystem plugin.
  inlineEsbuild ??= import(
    /* @vite-ignore */
    esbuildModuleURL
  ).then(async (esbuild) => {
    await esbuild.initialize({ wasmURL });
    return esbuild;
  }).catch((cause) => {
    // A load that failed, a page whose server was away for a moment, is not kept: the next build tries again.
    inlineEsbuild = null;
    throw cause;
  });
  return inlineEsbuild;
}
// After a build, a bundler formats the messages esbuild returned and may
// summarize the metafile; the shim had neither, and tsup fell over the first
// warning. Both are answered here, in the shape esbuild's own answers take.
export async function formatMessages(messages: EsbuildMessage[], options?: { kind?: string }): Promise<string[]> {
  const kind = options && options.kind === "error" ? "ERROR" : "WARNING";
  return (messages || []).map((message) => {
    const where = message && message.location ? `${message.location.file}:${message.location.line}:${message.location.column}: ` : "";
    const notes = message && Array.isArray(message.notes) ? message.notes.map((note) => `\n  ${note.text}`).join("") : "";
    return `${where}${kind}: ${message && message.text || ""}${notes}\n`;
  });
}
export async function analyzeMetafile(metafile: string | EsbuildMetafile, options?: unknown): Promise<string> {
  const parsed = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
  const outputs = parsed && parsed.outputs ? Object.entries(parsed.outputs) : [];
  return outputs.map(([name, output]) => `  ${name}  ${output && typeof (output as { bytes?: number }).bytes === "number" ? (output as { bytes: number }).bytes : 0} bytes`).join("\n");
}
/**
 * Send this realm's builds and transforms to a host that runs them
 * elsewhere and ends that elsewhere when it is idle. A host receives the
 * shim's own build options, plugins included; the host drops them, and the
 * realm that runs the build adds the filesystem plugin again over its own
 * filesystem.
 */
/**
 * The plugins the shim itself puts on a build: the filesystem it reads through,
 * and the externaliser the `neighbors` option becomes. They are the shim's own
 * answer to its own options, and a host receives them the way it receives every
 * other option the shim translated; only a plugin the CALLER wrote is a
 * function of this realm that cannot cross.
 */
const SHIM_PLUGINS = new Set(["vfs-loader", "neighbors"]);

export function useHost(host: EsbuildHost | null): void {
  currentHost = host;
  // The thread for synchronous calls starts now, while this realm's loop
  // still runs: a realm that installs a host is one guests run in, and a
  // worker created inside a blocked call never starts (its start is the
  // creator's loop's work), which held the execution worker for minutes.
  // A realm without a Worker or shared memory is left as it is; the call
  // says what is missing when it comes.
  if (host && !(typeof host.transformSync === 'function')) { try { __syncServiceStart(); } catch { /* reported at the call */ } }
  if (!host && syncService) __syncServiceDrop(syncService);
  esbuildInstance = (host ? {
    build: (options: BuildOptions) => typeof host.prebundle === "function" && (options.plugins || []).some((plugin) => plugin && (plugin as { name?: string }).name === "vite:dep-pre-bundle")
      ? host.prebundle(options)
      : (options.plugins || []).some((plugin) => plugin && !SHIM_PLUGINS.has((plugin as { name?: string }).name ?? ""))
        // Own esbuild takes no `neighbors`; a build that cannot cross for its
        // own plugins loses the option here, which no pack build carries.
        ? ownEsbuild().then((esbuild) => { const { neighbors: __n, ...own } = options as BuildOptions & { neighbors?: unknown }; void __n; return esbuild.build(own); })
        : host.build(options),
    transform: (code: string, options?: TransformOptions) => host.transform(code, options)
  } : null) as typeof esbuildInstance;
  if (typeof window !== "undefined") {
    window.__esbuild = esbuildInstance ?? void 0;
    window.__esbuildInitPromise = esbuildInstance ? Promise.resolve() : void 0;
  }
}

/**
 * Set the VirtualFS instance for file access
 */
export function setVFS(vfs: VirtualFS): void {
  globalVFS = vfs;
}

/**
 * Set the URL for the esbuild WASM file
 */
export function setWasmURL(url: string): void {
  wasmURL = url;
}

/**
 * Initialize esbuild-wasm
 * Must be called before using transform or build
 */
export async function initialize(options?: { wasmURL?: string }): Promise<void> {
  if (esbuildInstance) {
    return; // Already initialized
  }

  // Check for shared esbuild instance from transform.ts
  if (typeof window !== 'undefined' && window.__esbuild) {
    esbuildInstance = window.__esbuild;
    return;
  }

  // Wait for any in-progress initialization from transform.ts
  if (typeof window !== 'undefined' && window.__esbuildInitPromise) {
    await window.__esbuildInitPromise;
    if (window.__esbuild) {
      esbuildInstance = window.__esbuild;
      return;
    }
  }

  if (initPromise) {
    return initPromise; // Our initialization in progress
  }

  initPromise = (async () => {
    try {
      // Dynamically import esbuild-wasm from CDN
      const esbuild = await import(
        /* @vite-ignore */
        esbuildModuleURL
      );

      await esbuild.initialize({
        wasmURL: options?.wasmURL || wasmURL,
      });

      esbuildInstance = esbuild;
    } catch (error) {
      initPromise = null;
      throw new Error(`Failed to initialize esbuild-wasm: ${error}`);
    }
  })();

  return initPromise;
}

/**
 * Check if esbuild is initialized
 */
export function isInitialized(): boolean {
  return esbuildInstance !== null;
}

// ============================================================================
// Transform API
// ============================================================================

/**
 * Transform code using esbuild
 */
// A script is not finished while its build is running. The engine ends a
// `node` run once its output has been quiet for half a second, which is when
// tsup is in the middle of an esbuild build that prints nothing until it is
// done: the shell moved on, the next Dockerfile stage copied a `dist` that was
// still being written, and the runner had no `index.js`. In-flight esbuild work
// is counted here, and the run loop holds a run for as long as any is pending.
// The count is shared through `host-globals`, which puts it on the realm only
// once a guest exists; importing the engine adds no name to a host's global.
// It is read at each call, never captured at load, so the name a runtime puts
// up is the one this counts on.
export async function transform(
  code: string,
  options?: TransformOptions
): Promise<TransformResult> {
  const __heldWork = heldWork();
  __heldWork.count += 1;
  try { return await __transformHeld(code, options); } finally { __heldWork.count -= 1; }
}
async function __transformHeld(
  code: string,
  options?: TransformOptions
): Promise<TransformResult> {
  if (!esbuildInstance) {
    await initialize();
  }

  if (!esbuildInstance) {
    throw new Error('esbuild not initialized');
  }

  return esbuildInstance.transform(code, options);
}

// ============================================================================
// Synchronous transform
// ============================================================================

/**
 * `transformSync`, as esbuild answers it in Node: the code transformed
 * before the call returns. import-from-string, under bundle-import and
 * vite-plugin-fake-server, transforms the bundle it is about to import that
 * way, and vue-pure-admin's mock API died on the shim's refusal ("transformSync
 * is not available in browser"). esbuild-wasm has no synchronous API in a
 * browser realm, and Node's own esbuild-wasm answers the call the way it is
 * answered here: esbuild runs on another thread, the request crosses to it,
 * and the caller blocks on shared memory (`Atomics.wait`) until the answer
 * has been written there. A host that answers synchronously itself, native
 * esbuild under a Node host, is asked first. A realm that cannot block, a
 * page's main thread, cannot restore this and says so.
 */
interface SyncService {
  /** [0] the answer's state: 0 waiting, 1 final chunk written, 2 a chunk written with more to come; [1] the chunk's length; [2] 1 once the thread runs. */
  control: Int32Array;
  data: Uint8Array;
  worker: { postMessage(message: unknown): void; terminate(): unknown; unref?: () => void; on?: (event: string, listener: (value: unknown) => void) => unknown; onerror?: unknown };
  /** esbuild loaded on the thread, after the first call. */
  initialized: boolean;
  /** What the thread reported through its error event, where the realm's loop ran to deliver it. */
  failure?: string;
}
let syncService: SyncService | null = null;
const SYNC_STATE = 0;
const SYNC_LENGTH = 1;
const SYNC_STARTED = 2;
/** The shared window an answer crosses through; a longer answer crosses in chunks. */
const SYNC_DATA_BYTES = 1 << 20;
/**
 * How long a call waits for the thread to be running at all. A worker this
 * realm starts is started by this realm's own loop: one created and then
 * waited on in the same synchronous call never starts, and the wait would
 * be a deadlock. The thread is started when a host is installed, while the
 * loop still runs; a call that finds it not yet running waits this long and
 * then says so, rather than holding the realm.
 */
const SYNC_START_WAIT_MS = 5_000;
/** Loading esbuild on the thread, once; the thread reports a failed load at once. */
const SYNC_INIT_WAIT_MS = 60_000;
const SYNC_WAIT_MS = 120_000;

/**
 * The thread esbuild runs on for synchronous calls: a module worker that
 * loads esbuild from the shim's module URL, takes each request by message
 * and writes its answer into the shared window, chunk by chunk, notifying
 * the caller and waiting for the caller to take each chunk but the last.
 * `control[0]` is the state: 0 waiting, 1 final chunk written, 2 a chunk
 * written with more to come; `control[1]` is the chunk's length.
 */
function __syncWorkerSource(): string {
  return `
const port = typeof self !== 'undefined' && typeof self.postMessage === 'function' ? self : (await import('node:worker_threads')).parentPort;
const encoder = new TextEncoder();
let esbuild, control, data;
function deliver(text) {
  const bytes = encoder.encode(text);
  let offset = 0;
  do {
    const length = Math.min(bytes.length - offset, data.length);
    data.set(bytes.subarray(offset, offset + length));
    offset += length;
    control[1] = length;
    const more = offset < bytes.length;
    Atomics.store(control, 0, more ? 2 : 1);
    Atomics.notify(control, 0);
    if (more) Atomics.wait(control, 0, 2);
  } while (offset < bytes.length);
}
function answer(work) {
  work.then(
    (result) => deliver(JSON.stringify({ ok: true, result })),
    (error) => deliver(JSON.stringify({ ok: false, error: { message: String(error && error.message || error), errors: error && error.errors || [], warnings: error && error.warnings || [] } })),
  );
}
function receive(message) {
  if (message.type === 'attach') {
    control = new Int32Array(message.control);
    data = new Uint8Array(message.data);
    Atomics.store(control, 2, 1);
    Atomics.notify(control, 2);
  } else if (message.type === 'init') {
    answer(import(message.moduleURL).then(async (module) => { esbuild = module; await esbuild.initialize({ wasmURL: message.wasmURL }); return true; }));
  } else if (message.type === 'transform') {
    answer(esbuild.transform(message.code, message.options));
  }
}
if (typeof self !== 'undefined' && port === self) self.onmessage = (event) => receive(event.data);
else port.on('message', receive);
`;
}

/**
 * Starts the thread, without waiting on it: the worker is created and the
 * shared window posted to it; the thread marks itself started when it runs.
 * Called when a host is installed, so the thread starts while the realm's
 * loop runs, and by a synchronous call that finds none.
 */
function __syncServiceStart(): SyncService {
  if (syncService) return syncService;
  if (typeof SharedArrayBuffer !== 'function' || typeof Atomics === 'undefined') {
    throw new Error('transformSync needs shared memory to wait on esbuild, which this realm has none of (SharedArrayBuffer is absent).');
  }
  const WorkerClass = (globalThis as unknown as { Worker?: new (url: unknown, options?: unknown) => SyncService['worker'] }).Worker;
  if (typeof WorkerClass !== 'function') {
    throw new Error('transformSync needs a thread to run esbuild on, which this realm cannot start (Worker is absent).');
  }
  const control = new Int32Array(new SharedArrayBuffer(16));
  const data = new Uint8Array(new SharedArrayBuffer(SYNC_DATA_BYTES));
  const source = __syncWorkerSource();
  // A browser realm starts the worker from a blob of its own origin; Node
  // takes the module as a data: URL.
  const inBrowser = typeof (globalThis as Record<string, unknown>).WorkerGlobalScope !== 'undefined' || typeof (globalThis as Record<string, unknown>).document !== 'undefined';
  const url = inBrowser && typeof Blob === 'function' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    : new URL(`data:text/javascript,${encodeURIComponent(source)}`);
  const worker = new WorkerClass(url, { type: 'module' });
  const service: SyncService = { control, data, worker, initialized: false };
  const failed = (event: unknown) => { service.failure = String((event as { message?: unknown } | null)?.message ?? event); };
  if (typeof worker.on === 'function') worker.on('error', failed);
  else worker.onerror = failed;
  // A Node host is not held open by the thread.
  if (typeof worker.unref === 'function') worker.unref();
  worker.postMessage({ type: 'attach', control: control.buffer, data: data.buffer });
  syncService = service;
  return service;
}

/** Ends the thread and forgets it, so the next call starts afresh. */
function __syncServiceDrop(service: SyncService): void {
  try { service.worker.terminate(); } catch { /* already gone */ }
  if (syncService === service) syncService = null;
}

/** Blocks until the thread is running, or throws after the start bound with what is known. */
function __syncAwaitStarted(service: SyncService): void {
  const { control } = service;
  if (Atomics.load(control, SYNC_STARTED) === 1) return;
  Atomics.wait(control, SYNC_STARTED, 0, SYNC_START_WAIT_MS);
  if (Atomics.load(control, SYNC_STARTED) === 1) return;
  __syncServiceDrop(service);
  throw new Error(`esbuild's thread for synchronous calls did not start within ${SYNC_START_WAIT_MS / 1000} s${service.failure ? ` (${service.failure})` : ''}. A worker this realm starts runs only once this realm's loop has turned since; it is started when esbuild's host is installed, and this call found it not yet running.`);
}

/** Blocks until the thread's answer is in the shared window and returns it, or throws what esbuild threw, or throws at the bound. */
function __syncAnswer(service: SyncService, waitMs: number, stage: string): unknown {
  const { control, data } = service;
  const chunks: Uint8Array[] = [];
  for (;;) {
    Atomics.wait(control, SYNC_STATE, 0, waitMs);
    const state = Atomics.load(control, SYNC_STATE);
    if (state === 0) {
      __syncServiceDrop(service);
      throw new Error(`esbuild did not answer ${stage} within ${waitMs / 1000} s${service.failure ? ` (${service.failure})` : ''}.`);
    }
    chunks.push(data.slice(0, control[SYNC_LENGTH]!));
    if (state !== 2) break;
    Atomics.store(control, SYNC_STATE, 0);
    Atomics.notify(control, SYNC_STATE);
  }
  Atomics.store(control, SYNC_STATE, 0);
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  const answer = JSON.parse(new TextDecoder().decode(joined)) as { ok: true; result: unknown } | { ok: false; error: { message: string; errors: unknown[]; warnings: unknown[] } };
  if (!answer.ok) throw Object.assign(new Error(answer.error.message), { errors: answer.error.errors, warnings: answer.error.warnings });
  return answer.result;
}

/**
 * `esbuild.stop()`, as Node's esbuild has it: the thread held for
 * synchronous calls is ended; nothing else is held here.
 */
export async function stop(): Promise<void> {
  const service = syncService;
  if (service) { __syncServiceDrop(service); }
}

/**
 * Transform code synchronously, as `esbuild.transformSync` does in Node.
 */
export function transformSync(
  code: string,
  options?: TransformOptions
): TransformResult {
  if (currentHost && typeof currentHost.transformSync === 'function') return currentHost.transformSync(code, options);
  const service = syncService ?? __syncServiceStart();
  __syncAwaitStarted(service);
  if (!service.initialized) {
    Atomics.store(service.control, SYNC_STATE, 0);
    service.worker.postMessage({ type: 'init', moduleURL: esbuildModuleURL, wasmURL });
    __syncAnswer(service, SYNC_INIT_WAIT_MS, 'loading esbuild');
    service.initialized = true;
  }
  Atomics.store(service.control, SYNC_STATE, 0);
  service.worker.postMessage({ type: 'transform', code, options });
  return __syncAnswer(service, SYNC_WAIT_MS, 'a transform') as TransformResult;
}

/**
 * Transform ESM to CJS
 */
export async function transformToCommonJS(
  code: string,
  options?: { loader?: TransformOptions['loader'] }
): Promise<string> {
  const result = await transform(code, {
    loader: options?.loader || 'js',
    format: 'cjs',
    target: 'es2020',
  });

  return result.code;
}

// ============================================================================
// VFS Path Resolution Helpers
// ============================================================================

/**
 * Apply path remapping for VFS.
 * Currently a passthrough — no remapping needed.
 */
function remapVFSPath(path: string): string {
  return path;
}

/**
 * Check if file exists at path or remapped path
 * Returns the original path if found (to preserve output naming)
 */
function findVFSFile(vfs: VirtualFS, originalPath: string, extensions: string[]): string | null {
  for (const ext of extensions) {
    const pathWithExt = originalPath + ext;
    // First check original path — must be a file, not a directory
    if (vfs.existsSync(pathWithExt)) {
      try {
        if (!vfs.statSync(pathWithExt).isDirectory()) {
          return pathWithExt;
        }
      } catch {
        return pathWithExt;
      }
    }
    // Then try remapped path
    const remapped = remapVFSPath(pathWithExt);
    if (remapped !== pathWithExt && vfs.existsSync(remapped)) {
      try {
        if (!vfs.statSync(remapped).isDirectory()) {
          return pathWithExt;
        }
      } catch {
        return pathWithExt;
      }
    }
  }
  return null;
}

// ============================================================================
// VFS Plugin for esbuild
// ============================================================================

/**
 * Create a VFS plugin for esbuild to read files from VirtualFS.
 *
 * This plugin enables esbuild to resolve and load files from the virtual file system,
 * which is essential for browser-based bundling where we don't have access to the
 * real file system.
 *
 * The plugin handles three types of imports:
 * 1. Absolute paths (/project/src/file.ts)
 * 2. Relative paths (./file.ts, ../file.ts)
 * 3. Bare imports (convex/server, react)
 */
let __vfsPlatformNode = false;
/** A `paths` entry of a tsconfig, its targets made absolute. */
interface PathAlias {
  exact?: string;
  prefix?: string;
  suffix?: string;
  targets: string[];
}

/** As much of a tsconfig as the resolver reads. */
interface TsconfigJson {
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * esbuild reads a `tsconfig` it is pointed at with its own filesystem, which
 * in the browser is none: "not implemented on js". A build that names one, as
 * `tsup` does for every TypeScript project, has the file read from the
 * engine's filesystem and handed over as `tsconfigRaw`, which esbuild takes
 * as text. The `paths` that file declares, `@/*` for `./src/*`, are how a
 * project imports its own modules; esbuild applies them with its own
 * resolver, which the filesystem plugin stands in front of, so the plugin
 * applies them: an import that matches a pattern is looked for at each of its
 * targets, from the file's `baseUrl` or its own directory.
 */
let __vfsPathAliases: PathAlias[] | null = null;
function __stripJsonComments(text: string): string {
  let out = "";
  let quote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      out += character;
      if (character === "\\") { out += text[index + 1] ?? ""; index += 1; }
      else if (character === "\"") quote = false;
      continue;
    }
    if (character === "\"") { quote = true; out += character; continue; }
    if (character === "/" && text[index + 1] === "/") { while (index < text.length && text[index] !== "\n") index += 1; out += "\n"; continue; }
    if (character === "/" && text[index + 1] === "*") { const close = text.indexOf("*/", index + 2); index = close < 0 ? text.length : close + 1; continue; }
    out += character;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function __resolveTsconfigParent(directory: string, base: string): string | null {
  const join = (root: string, relative: string): string => {
    const parts = [];
    for (const part of (relative.startsWith("/") ? relative : root + "/" + relative).split("/")) {
      if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part);
    }
    return "/" + parts.join("/");
  };
  const file = (candidate: string): string | null => {
    const isFile = (p: string) => { try { return globalVFS!.existsSync(p) && !globalVFS!.statSync(p).isDirectory(); } catch { return false; } };
    if (isFile(candidate)) return candidate;
    if (!candidate.endsWith(".json") && isFile(candidate + ".json")) return candidate + ".json";
    // A package directory names its config in package.json, or carries tsconfig.json.
    try {
      const manifest = JSON.parse(globalVFS!.readFileSync(candidate + "/package.json", "utf8"));
      if (typeof manifest.tsconfig === "string" && isFile(join(candidate, manifest.tsconfig))) return join(candidate, manifest.tsconfig);
    } catch {}
    if (isFile(candidate + "/tsconfig.json")) return candidate + "/tsconfig.json";
    return null;
  };
  if (base.startsWith(".") || base.startsWith("/")) return file(join(directory, base));
  let current = directory.replace(/\/$/, "") || "/";
  for (;;) {
    const found = file((current === "/" ? "" : current) + "/node_modules/" + base);
    if (found) return found;
    if (current === "/") return null;
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
}
export function __flattenTsconfig(raw: string | TsconfigJson, directory: string, seen: Set<string> = new Set()): TsconfigJson {
  const parsed = typeof raw === "string" ? JSON.parse(__stripJsonComments(raw)) : raw;
  if (!parsed || typeof parsed !== "object") return parsed;
  const resolve = (base: string, relative: string): string => {
    const parts = [];
    for (const part of (relative.startsWith("/") ? relative : base + "/" + relative).split("/")) {
      if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part);
    }
    return "/" + parts.join("/");
  };
  let inherited: TsconfigJson = {};
  // TypeScript takes one base or a list of them, applied in order; each is a
  // relative or absolute path, or a package path found in node_modules on
  // the way up from the config, as a monorepo's shared `tsconfig` package is.
  const bases = Array.isArray(parsed.extends) ? parsed.extends : parsed.extends ? [parsed.extends] : [];
  for (const base of bases) {
    if (typeof base !== "string") throw new Error("Unsupported TypeScript config inheritance at " + directory + ": " + JSON.stringify(base));
    const parent = __resolveTsconfigParent(directory, base);
    // esbuild warns and builds on without a base it cannot find ("Cannot find
    // base config file"), where TypeScript itself errors. A config that names
    // a file a generator has yet to write is ordinary: SvelteKit's
    // `tsconfig.json` extends `./.svelte-kit/tsconfig.json`, which
    // `svelte-kit sync` writes when the dev server starts, so every fresh
    // SvelteKit checkout has a missing base for as long as it takes Vite to
    // load its own config. Throwing here killed `vite dev` before the plugin
    // that writes the file could run.
    if (parent === null) continue;
    if (seen.has(parent) || seen.size >= 20) throw new Error("TypeScript config inheritance cycle at " + parent);
    seen.add(parent);
    const next = __flattenTsconfig(globalVFS!.readFileSync(parent, "utf8"), parent.slice(0,parent.lastIndexOf("/")) || "/", seen);
    inherited = { ...inherited, ...next, compilerOptions: { ...inherited.compilerOptions, ...next.compilerOptions } };
  }
  const { extends: _extends, ...own } = parsed;
  const compiler = own.compilerOptions || {};
  const baseUrl = typeof compiler.baseUrl === "string" ? resolve(directory, compiler.baseUrl) : inherited.compilerOptions && inherited.compilerOptions.baseUrl;
  return { ...inherited, ...own, compilerOptions: { ...inherited.compilerOptions, ...compiler, ...(baseUrl ? { baseUrl } : {}) } };
}
function __discoveredPathAliases(cwd: string): PathAlias[] | null {
  if (!globalVFS) return null;
  let directory = cwd.replace(/\/$/, "") || "/";
  for (;;) {
    const candidate = (directory === "/" ? "" : directory) + "/tsconfig.json";
    try {
      if (globalVFS.existsSync(candidate)) {
        const text = globalVFS.readFileSync(candidate, "utf8");
        const aliases = __pathAliasesOf(typeof text === "string" ? text : new TextDecoder().decode(text), directory === "" ? "/" : directory);
        if (aliases) return aliases;
        // A file that extends another may take its paths from there.
        const parsed = JSON.parse(__stripJsonComments(String(text)));
        for (const base of Array.isArray(parsed?.extends) ? parsed.extends : typeof parsed?.extends === "string" ? [parsed.extends] : []) {
          const basePath = __resolveTsconfigParent(directory === "" ? "/" : directory, base);
          if (basePath === null) continue;
          const baseText = globalVFS.readFileSync(basePath, "utf8");
          const inherited = __pathAliasesOf(typeof baseText === "string" ? baseText : new TextDecoder().decode(baseText), basePath.slice(0, basePath.lastIndexOf("/")) || "/");
          if (inherited) return inherited;
        }
        return null;
      }
    } catch (error) {
      return null;
    }
    if (directory === "/" || directory === "") return null;
    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
  }
}
function __pathAliasesOf(tsconfigRaw: string | TsconfigJson | undefined, directory: string): PathAlias[] | null {
  if (!tsconfigRaw) return null;
  let parsed: TsconfigJson;
  try {
    parsed = typeof tsconfigRaw === "string"
      ? JSON.parse(__stripJsonComments(tsconfigRaw))
      : tsconfigRaw;
  } catch {
    return null;
  }
  const compilerOptions = parsed && parsed.compilerOptions;
  if (!compilerOptions || !compilerOptions.paths || typeof compilerOptions.paths !== "object") return null;
  const join = (base: string, relative: string): string => {
    const parts = [];
    for (const part of (relative.startsWith("/") ? relative : base + "/" + relative).split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  };
  const baseUrl = typeof compilerOptions.baseUrl === "string" ? join(directory, compilerOptions.baseUrl) : directory;
  const aliases: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf("*");
    const resolved = targets.filter((target) => typeof target === "string").map((target) => join(baseUrl, target));
    if (resolved.length === 0) continue;
    if (star < 0) aliases.push({ exact: pattern, targets: resolved });
    else aliases.push({ prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), targets: resolved });
  }
  return aliases.length > 0 ? aliases : null;
}
/** A `sideEffects` glob as a regular expression, the way a bundler reads one. */
function __browserRuntimeGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/^\.\//, "").replace(/[.+^$()|[\]\\{}]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(pattern.includes("/") ? `^${escaped}$` : `(?:^|/)${escaped}$`);
}

/** The package a specifier names: `@scope/name` or `name`, without a subpath. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * The `neighbors` option: the packages being built beside this one. An import
 * of one is left external under the specifier it was written with, so whoever
 * asked for the build serves it its own way, and every specifier an import
 * reached is recorded for the result. A specifier in `self` is what this build
 * is of and stays inside it; so do `node:` builtins and anything already
 * carrying a namespace, which are not bare package names at all.
 */
function createNeighborsPlugin(neighbors: { names: string[]; self?: string[] }, seen: Set<string>): unknown {
  const names = new Set(neighbors.names);
  const self = new Set(neighbors.self ?? []);
  return {
    name: "neighbors",
    setup(build: unknown) {
      const b = build as {
        onResolve: (options: { filter: RegExp; namespace?: string }, callback: (args: { path: string; kind?: string; namespace?: string }) => unknown) => void;
      };
      // esbuild compiles a filter with Go's regexp engine, which has no
      // unicode flag: a `/u` here reaches it as `(?u)` and the whole build
      // dies with "filter is not a valid Go regular expression". The filter
      // is ASCII anyway -- a specifier that is neither relative nor absolute.
      b.onResolve({ filter: /^[^./]/ }, (args: { path: string; kind?: string; namespace?: string }) => {
        if (args.kind === "entry-point" || args.path.startsWith("node:") || args.path.includes(":")) return undefined;
        if (!names.has(packageNameOf(args.path)) || self.has(args.path)) return undefined;
        seen.add(args.path);
        return { path: args.path, external: true };
      });
    },
  };
}

function createVFSPlugin(externals?: string[]): unknown {
  // The bundler's resolver said nothing about side effects, so a module it
  // resolved could never be dropped: a barrel that re-exports thousands of
  // modules bundled all of them however few were imported.
  //
  // What a package's manifest says of its files' side effects: false when it
  // declares none, undefined when it declares them or says nothing. A file
  // is the package's whose root is the longest known prefix of its path
  // with no node_modules between; the walk to a manifest happens once per
  // package, since every filesystem call here is a round trip to the store.
  const packageRoots: string[] = [];
  const sideEffectVerdicts = new Map<string, boolean | string[] | undefined>();
  function packageRootOf(filePath: string): string | null {
    for (const root of packageRoots) {
      if (filePath.startsWith(root + "/") && !filePath.slice(root.length + 1).includes("/node_modules/")) return root;
    }
    let directory = filePath.slice(0, filePath.lastIndexOf("/"));
    while (directory) {
      try {
        const manifestPath = directory + "/package.json";
        if (vfs.existsSync(manifestPath)) {
          // The bundler's filesystem answers in bytes; the engine's in text.
          const read = vfs.readFileSync(manifestPath, "utf8");
          const manifest = JSON.parse(typeof read === "string" ? read : new TextDecoder().decode(read));
          sideEffectVerdicts.set(directory, manifest.sideEffects);
          packageRoots.push(directory);
          packageRoots.sort((a, b) => b.length - a.length);
          return directory;
        }
      } catch {
        return null;
      }
      directory = directory.slice(0, directory.lastIndexOf("/"));
    }
    return null;
  }
  function sideEffectsOf(vfs3: VirtualFS, filePath: string): false | undefined {
    const root = packageRootOf(filePath);
    if (!root) return void 0;
    const sideEffects = sideEffectVerdicts.get(root);
    if (sideEffects === false) return false;
    if (Array.isArray(sideEffects)) {
      const relative = filePath.slice(root.length + 1);
      return sideEffects.some((entry) => typeof entry === "string" && __browserRuntimeGlobToRegExp(entry).test(relative)) ? void 0 : false;
    }
    return void 0;
  }
  function withSideEffects<T>(vfs3: VirtualFS, filePath: string, result: T): T {
    return sideEffectsOf(vfs3, filePath) === false ? { ...result, sideEffects: false } : result;
  }
  const __pathAliases = __vfsPathAliases;
  // Resolver callbacks outlive setup and may overlap another build.
  const __platformNode = __vfsPlatformNode;
  if (!globalVFS) {
    return null;
  }

  const vfs = globalVFS;

  return {
    name: 'vfs-loader',
    setup(build: unknown) {
      const b = build as {
        onResolve: (options: { filter: RegExp; namespace?: string }, callback: (args: { path: string; importer: string; kind: string }) => unknown) => void;
        onLoad: (options: { filter: RegExp; namespace?: string }, callback: (args: { path: string }) => unknown) => void;
      };

      // A resolved path is the file's own. The shim once answered `.mjs` and
      // `.cjs` files under a `.js` name, so esbuild would infer the format of
      // a package the installer had rewritten from ESM to CJS; the installer
      // no longer rewrites, and a plugin of the build that reads the path
      // itself, Vite's config loader among them, found no such file.
      function vfsResolved(foundPath: string) {
        return withSideEffects(vfs, foundPath, { path: foundPath, pluginData: { fromVFS: true } });
      }

      // Resolve file paths - handles both imports and entry points
      b.onResolve({ filter: /.*/ }, (args: { path: string; importer: string; kind?: string; resolveDir?: string }) => {
        const { path: importPath, importer } = args;

        // Skip external modules (node_modules, bare imports)
        if (importPath.startsWith('node_modules/')) {
          return { external: true };
        }

        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

        // An entry point that is not absolute is a path from the build's
        // working directory; the resolver read `src/index.ts` as a bare
        // package and marked it external, which an entry point cannot be.
        if (args.kind === "entry-point" && !importPath.startsWith("/") && !importPath.startsWith(".")) {
          const base = (args.resolveDir || "/").replace(/\/$/, "");
          const entryPath = findVFSFile(vfs, base + "/" + importPath, extensions);
          if (entryPath) return vfsResolved(entryPath);
        }

        // Absolute paths - check if file exists in VFS (or remapped location)
        if (importPath.startsWith('/')) {
          const foundPath = findVFSFile(vfs, importPath, extensions);
          if (foundPath) {
            return vfsResolved(foundPath);
          }
          // File not found
          return { external: true };
        }

        // Relative paths
        if (importPath.startsWith('.')) {
          let resolved = importPath;
          if (importer) {
            // Use realPath from pluginData if the importer was remapped from .mjs/.cjs
            const importerDir = importer.substring(0, importer.lastIndexOf('/'));
            resolved = importerDir + '/' + importPath;
          }
          // Normalize path
          const parts = resolved.split('/').filter(Boolean);
          const normalized: string[] = [];
          for (const part of parts) {
            if (part === '..') {
              normalized.pop();
            } else if (part !== '.') {
              normalized.push(part);
            }
          }
          resolved = '/' + normalized.join('/');

          // Try to find the file with various extensions
          const foundPath = findVFSFile(vfs, resolved, extensions);
          if (foundPath) {
            return vfsResolved(foundPath);
          }

          // Try index files
          for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
            const indexPath = resolved + '/index' + ext;
            const foundIndex = findVFSFile(vfs, indexPath, ['']);
            if (foundIndex) {
              return vfsResolved(foundIndex);
            }
          }
        }

        // Bare imports (no ./ or ../ or /) - resolve from node_modules in VFS
        // See resolveNodeModuleImport() JSDoc for why we resolve from VFS instead of
        // marking as external (browser bundling, VFS isolation, consistent builds)

        // A package's private `#` imports, resolved where its other imports
        // are. `#compiler/builders` is not a package, it is an entry in the
        // importing package's own `imports` map, and leaving it external left
        // every bundle of such a package with an import no browser can
        // resolve. The nearest manifest above the importer with an `imports`
        // map names the file, under the conditions a browser bundle takes.
        if (importPath.startsWith("#")) {
          const __conditions = (value: unknown): string | undefined => {
            if (typeof value === "string") return value;
            if (!value || typeof value !== "object") return void 0;
            for (const key of ["browser", "import", "module", "default"]) {
              if (key in value) {
                const found = __conditions((value as Record<string, unknown>)[key]);
                if (found) return found;
              }
            }
            return void 0;
          };
          let __directory = importer.slice(0, importer.lastIndexOf("/"));
          let __resolvedPrivate: ReturnType<typeof vfsResolved> | undefined;
          while (__directory && __resolvedPrivate === void 0) {
            const __manifestPath = __directory + "/package.json";
            if (vfs.existsSync(__manifestPath)) {
              let __imports: Record<string, unknown> | undefined;
              try {
                __imports = JSON.parse(vfs.readFileSync(__manifestPath, "utf8")).imports;
              } catch (error) {
                __imports = void 0;
              }
              if (__imports && typeof __imports === "object") {
                let __target = __conditions(__imports[importPath]);
                if (!__target) {
                  for (const [pattern, value] of Object.entries(__imports)) {
                    const star = pattern.indexOf("*");
                    if (star < 0) continue;
                    const prefix = pattern.slice(0, star);
                    const suffix = pattern.slice(star + 1);
                    if (!importPath.startsWith(prefix) || !importPath.endsWith(suffix)) continue;
                    const found = __conditions(value);
                    if (found) {
                      __target = found.replace("*", importPath.slice(prefix.length, importPath.length - suffix.length));
                      break;
                    }
                  }
                }
                if (__target && __target.startsWith("./")) {
                  const __base = __directory + "/" + __target.slice(2);
                  for (const extension of extensions) {
                    const candidate = __base + extension;
                    if (vfs.existsSync(candidate) && !vfs.statSync(candidate).isDirectory()) {
                      __resolvedPrivate = vfsResolved(candidate);
                      break;
                    }
                  }
                }
              }
            }
            __directory = __directory.slice(0, __directory.lastIndexOf("/"));
          }
          if (__resolvedPrivate) return __resolvedPrivate;
        }
        if (__pathAliases) {
          for (const alias of __pathAliases) {
            const rest = alias.prefix !== void 0
              ? (importPath.startsWith(alias.prefix) && importPath.endsWith(alias.suffix!) && importPath.length >= alias.prefix.length + alias.suffix!.length ? importPath.slice(alias.prefix.length, importPath.length - alias.suffix!.length) : void 0)
              : (importPath === alias.exact ? "" : void 0);
            if (rest === void 0) continue;
            for (const target of alias.targets) {
              const candidate = target.includes("*") ? target.replace("*", rest) : target;
              const found = findVFSFile(vfs, candidate, extensions);
              if (found) return vfsResolved(found);
              for (const ext2 of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
                const index = findVFSFile(vfs, candidate + "/index" + ext2, [""]);
                if (index) return vfsResolved(index);
              }
            }
          }
        }
        // Check externals list first — packages like react must stay as ESM imports
        if (externals && externals.some(ext => importPath === ext || importPath.startsWith(ext + '/'))) {
          return { external: true };
        }

        const resolution = resolveNodeModuleImport(vfs, importPath, extensions, importer);
        if (resolution) {
          return resolution.path ? withSideEffects(vfs, resolution.path, resolution) : resolution;
        }

        // Node.js builtins that aren't in VFS node_modules should be
        // stubbed as empty modules rather than externalized. When externalized,
        // patchExternalRequires() converts them to bare ESM imports that the
        // browser can't resolve. An empty stub is safe because these builtins
        // are typically only used in server-only code paths (e.g., @vercel/oidc).
        const bareModule = importPath.replace(/^node:/, '');
        // A name the host stands in for resolves to the host's file here as
        // it does for require, so a config the bundler inlines gets the
        // stand-in. The table is the host's (`globalThis.__browserRuntimeStandInPaths`,
        // package name -> file); the engine names no package.
        const __standInPaths = (globalThis as Record<string, unknown>).__browserRuntimeStandInPaths as Record<string, string> | undefined;
        if (__standInPaths && Object.prototype.hasOwnProperty.call(__standInPaths, bareModule) && vfs.existsSync(__standInPaths[bareModule])) {
          return vfsResolved(__standInPaths[bareModule]);
        }
        if (NODE_BUILTINS.has(bareModule)) {
          // tsup's server bundle carried `path` as `{}` and fell over its
          // first `path.resolve`: a build for Node keeps its builtins
          // external, to be required where it runs.
          if (__platformNode) return { external: true };
          return { path: `/__node_stub__/${bareModule}`, namespace: 'node-stub' };
        }

        // A name the tree does not answer is put to the module stand-ins before
        // it is external: a registered stand-in may answer with a module it
        // computes from the project, what a generator would have written. The
        // registry is globalThis.__browserRuntimeModuleStandIns, installed by
        // the toolchain; the runtime's two resolvers ask it the same way.
        const __standIns = (globalThis as Record<string, unknown>).__browserRuntimeModuleStandIns as { resolve: (id: string, from: string) => string | null } | undefined;
        const __answered = __standIns && importer
          ? __standIns.resolve(importPath, importer.slice(0, importer.lastIndexOf('/')) || '/') : null;
        if (__answered) return vfsResolved(__answered);
        // Could not resolve from node_modules, treat as external
        return { external: true };
      });

      // Load empty stubs for Node.js builtins not available in VFS
      b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => {
        return { contents: 'module.exports = {};', loader: 'js' as const };
      });

      // Load file contents from VFS
      // Apply path remapping when reading to find the actual file
      // A preceding plugin can resolve a real file without this resolver's
      // private pluginData; Vite's dependency optimizer does exactly that.
      // The fallback loader must read those files too: esbuild-wasm has no OS disk.
      b.onLoad({ filter: /^\/.*/, namespace: 'file' }, (args: { path: string; pluginData?: { fromVFS?: boolean; realPath?: string } }) => {
        if (!args.pluginData?.fromVFS && !vfs.existsSync(args.path)) return null;
        try {
          // Use realPath if available (set when .mjs/.cjs was normalized to .js)
          const vfsPath = args.pluginData?.realPath || args.path;
          let contents: string;
          const remappedPath = remapVFSPath(vfsPath);

          if (vfs.existsSync(vfsPath)) {
            contents = vfs.readFileSync(vfsPath, 'utf8');
          } else if (remappedPath !== vfsPath && vfs.existsSync(remappedPath)) {
            contents = vfs.readFileSync(remappedPath, 'utf8');
          } else {
            throw new Error(`File not found: ${vfsPath} (tried ${remappedPath})`);
          }

          const ext = args.path.substring(args.path.lastIndexOf('.'));
          let loader: 'ts' | 'tsx' | 'js' | 'jsx' | 'json' | 'css' = 'ts';
          if (ext === '.tsx') loader = 'tsx';
          else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') loader = 'js';
          else if (ext === '.jsx') loader = 'jsx';
          else if (ext === '.json') loader = 'json';
          // A file that is not a module, imported as one: a stylesheet reaching
          // the bundler as TypeScript failed the whole module graph.
          else if (ext === '.css') loader = 'css';

          return { contents, loader };
        } catch (err) {
          return { errors: [{ text: `Failed to load ${args.path}: ${err}` }] };
        }
      });
    },
  };
}

// ============================================================================
// Build API
// ============================================================================

/**
 * Build/bundle code (limited support in browser)
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  // The shim stands in for whatever esbuild a project pinned, and answers in
  // the option vocabulary of the esbuild it runs. tsup 6 speaks esbuild
  // 0.14's: `incremental` and `watch` on a build, which esbuild 0.17 removed
  // and 0.20 refuses as invalid options, so `tsup` died on the first library
  // it built. Both name a build held for rebuilding, which the shim does not
  // hold; a single build is what they get, as a context's `rebuild` is.
  if (options && ("incremental" in options || "watch" in options)) {
    const { incremental: _incremental, watch: _watch, ...accepted } = options as BuildOptions & { incremental?: unknown; watch?: unknown };
    options = accepted;
  }
  const __heldWork = heldWork();
  __heldWork.count += 1;
  try { return await __buildHeld(options); } finally { __heldWork.count -= 1; }
}
async function __buildHeld(options: BuildOptions): Promise<BuildResult> {
  if (!esbuildInstance) {
    await initialize();
  }

  if (!esbuildInstance) {
    throw new Error('esbuild not initialized');
  }

  // Add VFS plugin if VFS is available
  __vfsPlatformNode = options.platform === "node";
  const __cwd = options.absWorkingDir || (typeof globalThis !== "undefined" && globalThis.process && typeof globalThis.process.cwd === "function" ? globalThis.process.cwd() : "/");
  let __tsconfigDirectory = __cwd;
  if (typeof options.tsconfig === "string" && globalVFS && options.tsconfigRaw === void 0) {
    const tsconfigPath = options.tsconfig.startsWith("/") ? options.tsconfig : (__cwd.endsWith("/") ? __cwd : __cwd + "/") + options.tsconfig;
    try {
      const { tsconfig: _tsconfig, ...withoutPath } = options;
      options = { ...withoutPath, tsconfigRaw: globalVFS.readFileSync(tsconfigPath, "utf8") };
      __tsconfigDirectory = tsconfigPath.slice(0, tsconfigPath.lastIndexOf("/")) || "/";
    } catch {
    }
  }
  if (options.tsconfigRaw !== void 0) options = { ...options, tsconfigRaw: __flattenTsconfig(options.tsconfigRaw, __tsconfigDirectory) };
  // A build names where a workspace member's sources are, `workspacePaths`,
  // as tsconfig paths with absolute targets; they join the config's own
  // paths and travel with the build wherever its resolver runs, since
  // the bundler worker sees neither the engine's links nor its globals.
  if (options.workspacePaths && typeof options.workspacePaths === "object") {
    const { workspacePaths: __workspacePaths, ...__rest } = options;
    const __raw = __rest.tsconfigRaw === void 0 ? {} : typeof __rest.tsconfigRaw === "string" ? JSON.parse(__stripJsonComments(__rest.tsconfigRaw)) : __rest.tsconfigRaw;
    const __compiler = { ...(__raw && __raw.compilerOptions) };
    __compiler.paths = { ...(__compiler.paths || {}), ...__workspacePaths };
    if (typeof __compiler.baseUrl !== "string") __compiler.baseUrl = __tsconfigDirectory;
    options = { ...__rest, tsconfigRaw: { ...__raw, compilerOptions: __compiler } };
  }
  // A bundler that read the tsconfig itself hands over what it kept of it,
  // often without the paths; esbuild would then find the file on disk on
  // its own, which the browser has none of, so the file is found here.
  __vfsPathAliases = __pathAliasesOf(options.tsconfigRaw, __tsconfigDirectory) || __discoveredPathAliases(__cwd);
  const plugins = [...(options.plugins || [])];
  // A build of one package among many says which of the others are being
  // built beside it. esbuild has no such option and refused the whole build
  // when it was handed one -- "Invalid option in build() call" -- so a
  // substrate realm that ran its package builds here, rather than at a host
  // that consumed the option first, could not build a package at all. The
  // option is the shim's, like `workspacePaths`: it is taken off before
  // esbuild sees the options and answered here, so a build means the same
  // thing whether it runs in this realm or at a host.
  let neighborsSeen: Set<string> | undefined;
  if (options.neighbors && typeof options.neighbors === "object" && !currentHost?.neighbors) {
    const { neighbors: __neighbors, ...__rest } = options;
    options = __rest;
    neighborsSeen = new Set<string>();
    plugins.push(createNeighborsPlugin(__neighbors, neighborsSeen));
  }
  const vfsPlugin = createVFSPlugin(options.external);
  if (vfsPlugin) {
    plugins.push(vfsPlugin);
  }

  // Resolve entry points to absolute paths.
  // Path remapping (if any) happens in the VFS plugin's onLoad handler instead,
  // preserving the original paths for esbuild's output file naming.
  let entryPoints = options.entryPoints;
  // Only the array form is rewritten here: esbuild also takes the named
  // multi-entry form, `{ out: "in.ts" }`, which a browser build uses and
  // which this mapping would otherwise destroy.
  if (Array.isArray(entryPoints) && globalVFS) {
    const absWorkingDir = options.absWorkingDir || (typeof globalThis !== 'undefined' && globalThis.process && typeof globalThis.process.cwd === 'function' ? globalThis.process.cwd() : '/');
    entryPoints = entryPoints.map(ep => {
      // Handle paths that came from previous builds with vfs: namespace prefix
      if (ep.includes('vfs:')) {
        const vfsIndex = ep.indexOf('vfs:');
        ep = ep.substring(vfsIndex + 4);
      }

      // If already absolute, use as-is
      if (ep.startsWith('/')) {
        return ep;
      }

      // A build names its entry the way a project does, `src/index.ts`,
      // relative to the working directory with no `./`. esbuild reads an
      // entry as a file path and makes it absolute before any plugin sees
      // it; a build's own plugin, tsup's for what is external, would
      // otherwise take `src/index.ts` for a package. A bare entry that is no
      // file of the project — a package name Vite's optimizer hands its own
      // plugin to resolve — stays bare.
      if (!ep.startsWith(".")) {
        const base = absWorkingDir.endsWith("/") ? absWorkingDir.slice(0, -1) : absWorkingDir;
        const candidate = base + "/" + ep;
        let found = false;
        try { found = globalVFS!.existsSync(candidate); } catch {}
        if (found) return candidate;
      }

      if (ep.startsWith('./')) {
        // Join with absWorkingDir but DO NOT remap paths
        const base = absWorkingDir.endsWith('/') ? absWorkingDir.slice(0, -1) : absWorkingDir;
        const relative = ep.slice(2);
        const resolved = base + '/' + relative;
        return resolved;
      }
      if (ep.startsWith('../')) {
        const base = absWorkingDir.endsWith('/') ? absWorkingDir.slice(0, -1) : absWorkingDir;
        const parts = base.split('/').filter(Boolean);
        parts.pop();
        const relative = ep.slice(3);
        const resolved = '/' + parts.join('/') + '/' + relative;
        return resolved;
      }
      return ep;
    });
  }

  // In browser, we need write: false to get outputFiles
  // Pass absWorkingDir so metafile paths are relative to the correct directory
  const resolvedAbsWorkingDir = options.absWorkingDir || (typeof globalThis !== 'undefined' && globalThis.process && typeof globalThis.process.cwd === 'function' ? globalThis.process.cwd() : '/');
  const __outputFilesystem = globalVFS;
  const result = await esbuildInstance.build({
    ...options,
    entryPoints,
    plugins,
    write: false,
    absWorkingDir: resolvedAbsWorkingDir,
  }) as BuildResult;

  if (neighborsSeen) result.neighbors = [...neighborsSeen].sort();
  // Strip 'vfs:' namespace prefix from all output paths.
  // esbuild-wasm may prefix paths with the plugin namespace; strip it everywhere.
  if (result.outputFiles) {
    for (const file of result.outputFiles) {
      if (file.path.includes('vfs:')) {
        file.path = file.path.replace(/vfs:/g, '');
      }
    }
  }
  // esbuild-wasm cannot write to an OS disk. Honor the Node API's output
  // files here, including its default write=true when an output is named.
  if (options.write !== false && (options.outdir || options.outfile)) {
    if (!__outputFilesystem) throw new Error("esbuild has no filesystem for its output.");
    for (const file of result.outputFiles || []) {
      const parent = file.path.slice(0, file.path.lastIndexOf("/")) || "/";
      __outputFilesystem.mkdirSync(parent, { recursive: true });
      __outputFilesystem.writeFileSync(file.path, file.contents ?? file.text);
    }
  }
  if (result.metafile) {
    const meta = result.metafile as { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
    for (const key of ['inputs', 'outputs'] as const) {
      const obj = meta[key];
      if (obj) {
        for (const k of Object.keys(obj)) {
          if (k.includes('vfs:')) {
            obj[k.replace(/vfs:/g, '')] = obj[k];
            delete obj[k];
          }
        }
      }
    }
  }

  return result;
}

/**
 * Build synchronously (not supported in browser, throws error)
 */
export function buildSync(_options: BuildOptions): BuildResult {
  throw new Error('buildSync is not available in browser. Use build() instead.');
}

/**
 * Get the esbuild version
 */
export function version(): string {
  return '0.20.0'; // Version of esbuild-wasm we're using
}

// A build that named an output wrote nothing and Vite's own build, which
// reads what esbuild wrote, saw an empty directory; `tsup --watch` asked for
// a context and the dev server answered 500. A context is a build held for
// rebuilding: each `rebuild` runs the shim's build with the context's
// options, `watch` and `serve` are nothing to hold in the browser, and
// `dispose` releases it.
export async function context(options: BuildOptions): Promise<unknown> {
  let disposed = false;
  return {
    rebuild: () => {
      if (disposed) return Promise.reject(new Error("The esbuild context was disposed."));
      return build(options);
    },
    watch: async () => {},
    serve: async () => ({ host: "127.0.0.1", port: 0, hosts: ["127.0.0.1"] }),
    cancel: async () => {},
    dispose: async () => { disposed = true; },
  };
}

// Default export matching esbuild's API
export default {
  initialize,
  isInitialized,
  transform,
  transformSync,
  transformToCommonJS,
  build,
  buildSync,
  context,
  stop,
  version,
  setWasmURL,
  setVFS,
  setModuleURL,
  useHost,
  formatMessages,
  analyzeMetafile,
};
