/**
 * Node24.5's TypeScript loader asks the modules binding for its compile cache.
 * A Node process without an enabled cache returns undefined for every entry
 * and compiles normally. This engine enables no native/disk compile cache;
 * return that real disabled path, never an invented stored cache or pointer.
 * Values are src/compile_cache.h's CACHED_CODE_TYPES.
 */
export default {
  cachedCodeTypes: Object.freeze({
    kCommonJS: 0,
    kESM: 1,
    kStrippedTypeScript: 2,
    kTransformedTypeScript: 3,
    kTransformedTypeScriptWithSourceMaps: 4,
  }),
  getCompileCacheEntry(_source: string, _filename: string, _type: number): undefined {
    return undefined;
  },
  saveCompileCacheEntry(_entry: unknown, _transpiled: string): never {
    throw Object.assign(new Error('The native compile cache is not enabled.'), { code: 'ERR_INVALID_STATE' });
  },
};
