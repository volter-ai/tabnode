/**
 * `internal/deps/amaro/dist/index`: the type stripper Node carries.
 *
 * Node v22.18.0 runs a `.ts`, `.mts` or `.cts` file by erasing its types with
 * amaro 1.1.0 (swc's stripper, built to WebAssembly), vendored under
 * `deps/amaro`, and its own `lib/internal/modules/typescript.js` (vendored
 * here unmodified) is what calls it. amaro is not native: it is JavaScript and
 * WebAssembly, and this engine takes the same release as a dependency rather
 * than writing a stripper of its own. esbuild, which the engine also carries,
 * is not a substitute: it reprints the program (a stack's line and column move)
 * and it transforms `enum`, `namespace` and parameter properties where Node, in
 * strip-only mode, refuses them.
 *
 * amaro's glue loads its WebAssembly synchronously from bytes inlined in the
 * package and reads `util` and `buffer`, so it is loaded through the host's own
 * `require` where the host is Node. A browser realm has no such door: there the
 * page supplies its stripper as `globalThis.__substrateStripTypes`, which the
 * module loader asks first, and this answers absent.
 */
type AmaroTransform = (source: string, options: Record<string, unknown>) => { code: string; map?: string };
interface Amaro { transformSync: AmaroTransform }

/** The host's `process`, taken before a guest's takes the global name. */
const hostProcess = typeof process !== 'undefined' && process !== null
  ? (process as unknown as { getBuiltinModule?: (name: string) => unknown })
  : null;

let loaded: Amaro | null | undefined;

/** amaro, loaded once from beside this engine, or null where the realm cannot load it. */
export function hostAmaro(): Amaro | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  try {
    const moduleBuiltin = typeof hostProcess?.getBuiltinModule === 'function'
      ? hostProcess.getBuiltinModule('module') as { createRequire?: (from: string) => (id: string) => unknown } | undefined
      : undefined;
    if (moduleBuiltin && typeof moduleBuiltin.createRequire === 'function') {
      const amaro = moduleBuiltin.createRequire(import.meta.url)('amaro') as Amaro;
      if (typeof amaro?.transformSync === 'function') loaded = amaro;
    }
  } catch { /* no host require, or amaro not installed beside the engine */ }
  return loaded;
}

/** The module Node's `typescript.js` requires; absent, the error Node raises when built without amaro. */
export function internalAmaro(): Amaro {
  const amaro = hostAmaro();
  if (amaro) return amaro;
  throw Object.assign(new Error('Node.js is not compiled with TypeScript support'), { code: 'ERR_NO_TYPESCRIPT' });
}
