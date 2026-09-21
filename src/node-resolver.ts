// One resolver for every name the engine resolves: the runtime's require, the
// simple loader's, and the bundler's plugin. Each had a hand-rolled subset of
// Node's algorithm; they disagreed with each other and with Node, and every app
// found a new gap. `node-resolution.ts` is that algorithm; this is where the
// lanes take it from, one resolver per filesystem, profile and extension set.
//
// The source adapter injected both into the bundle beside the `resolve.exports`
// import; in the fork they are real modules, so every lane can import them.
import { imports, resolve as resolveExports } from 'resolve.exports';
import { createNodeResolver, type NodeResolver, type ResolutionFs } from './node-resolution';

const __nodeResolvers = new WeakMap<ResolutionFs, Map<string, NodeResolver>>();

/**
 * The runtime resolves as Node's require does; the bundler as a browser bundler
 * does, module and import entries first and TypeScript sources.
 */
export function __nodeResolverFor(fs: ResolutionFs, profile: 'runtime' | 'bundler', extensions?: readonly string[]): NodeResolver {
  let byProfile = __nodeResolvers.get(fs);
  if (!byProfile) { byProfile = new Map(); __nodeResolvers.set(fs, byProfile); }
  const key = profile + ':' + (extensions || []).join(',');
  let resolver = byProfile.get(key);
  if (resolver) return resolver;
  const members = () => (globalThis as Record<string, unknown>).__browserRuntimeWorkspaceMembers as ReadonlySet<string> | undefined;
  const exportsResolver = { resolve: resolveExports, imports };
  resolver = profile === 'bundler'
    ? createNodeResolver({ fs, exports: exportsResolver, conditionSets: [['browser', 'module', 'import', 'default'], ['require', 'default']], extensions: (extensions || ['.js', '.json']).filter((extension) => extension !== ''), mainFields: ['module', 'main'], globalRoots: ['/node_modules', '/project/node_modules'], workspaceMembers: members })
    : createNodeResolver({ fs, exports: exportsResolver, conditionSets: [['require', 'node', 'default'], ['import', 'node', 'default']],
        // Node's require probes `.ts`, `.mts` and `.cts` too once it strips types (22.18), and the loader here does.
        extensions: ['.js', '.json', '.node', '.cjs', '.mjs', '.ts', '.mts', '.cts'], mainFields: ['main', 'module'], globalRoots: ['/node_modules'], workspaceMembers: members, sourceExtensions: ['.js', '.mjs', '.cjs'], skipThrowingCjs: true });
  byProfile.set(key, resolver);
  return resolver;
}
