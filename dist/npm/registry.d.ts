/**
 * npm Registry Client
 * Fetches package metadata from npm registry
 */
export interface PackageVersion {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, {
        optional?: boolean;
    }>;
    optionalDependencies?: Record<string, string>;
    dist: {
        tarball: string;
        shasum: string;
        integrity?: string;
    };
    main?: string;
    module?: string;
    exports?: Record<string, unknown>;
    bin?: Record<string, string> | string;
}
export interface PackageManifest {
    name: string;
    'dist-tags': {
        latest: string;
        [tag: string]: string;
    };
    versions: Record<string, PackageVersion>;
    time?: Record<string, string>;
}
export interface RegistryOptions {
    registry?: string;
    /** An `@scope`, or a whole unscoped name, to the registry that answers for it. */
    registryScopes?: Record<string, string>;
    cache?: Map<string, PackageManifest>;
}
declare global {
    /**
     * The version a lockfile recorded for a name, as the page read it: enough
     * to stand in for the registry's document without fetching the packument.
     */
    var __browserRuntimeLockfileManifests: Map<string, LockfileVersionDoc> | undefined;
    /**
     * An `@scope`, or a whole unscoped name, to the registry that answers for
     * it. The engine builds its package manager itself, with no options of
     * ours, so a page's scopes arrive the way the lockfile's records do.
     */
    var __browserRuntimeRegistryScopes: Record<string, string> | undefined;
}
/** One version's record in a lockfile, as the page hands it over. */
export interface LockfileVersionDoc {
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, {
        optional?: boolean;
    }>;
    optionalDependencies?: Record<string, string>;
}
export declare class Registry {
    registryUrl: string;
    registryScopes?: Record<string, string>;
    private cache;
    constructor(options?: RegistryOptions);
    /**
     * Which registry answers for a name: the one its scope is served from,
     * or the one its whole name is, and otherwise the default.
     *
     * A project may carry packages of its own that no public registry has: a
     * private SDK, a twin, a package built in the same workspace but never
     * published. Asking one registry for every name meant npm answered 404 for
     * the scope and the install failed with nothing the project could do short
     * of publishing.
     */
    registryFor(packageName: string): string;
    /**
     * Fetch package manifest (all versions metadata)
     */
    getPackageManifest(packageName: string): Promise<PackageManifest>;
    /**
     * Get specific version metadata
     */
    getPackageVersion(packageName: string, version: string): Promise<PackageVersion>;
    /**
     * Get latest version number
     */
    getLatestVersion(packageName: string): Promise<string>;
    /**
     * Get all available versions
     */
    getVersions(packageName: string): Promise<string[]>;
    /**
     * Download tarball as ArrayBuffer
     */
    downloadTarball(tarballUrl: string): Promise<ArrayBuffer>;
    /**
     * Clear the cache
     */
    clearCache(): void;
}
/**
 * Encode scoped package names for URL
 * @scoped/package -> @scoped%2fpackage
 */
export declare function encodePackageName(name: string): string;
export declare const registry: Registry;
export default Registry;
//# sourceMappingURL=registry.d.ts.map