import { type NodeResolver, type ResolutionFs } from './node-resolution';
/**
 * The runtime resolves as Node's require does; the bundler as a browser bundler
 * does, module and import entries first and TypeScript sources.
 */
export declare function __nodeResolverFor(fs: ResolutionFs, profile: 'runtime' | 'bundler', extensions?: readonly string[]): NodeResolver;
//# sourceMappingURL=node-resolver.d.ts.map