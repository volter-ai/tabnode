/**
 * Dependency Resolver
 * Resolves full dependency tree with semver version constraints
 */
import { Registry } from './registry';
declare global {
    /**
     * The lockfile the page read for the project being installed, name to the
     * version it pinned. The engine builds its package manager itself, with no
     * options of ours, so the page hands the records over through globals.
     */
    var __browserRuntimeLockfilePins: Map<string, string> | undefined;
    /** Every version the lockfile recorded, by package name and then version. */
    var __browserRuntimeLockfileRecords: Map<string, Map<string, LockfileRecord>> | undefined;
}
/** One version as a lockfile wrote it down. */
export interface LockfileRecord {
    resolved?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, {
        optional?: boolean;
    }>;
    optionalDependencies?: Record<string, string>;
}
export interface ResolvedPackage {
    name: string;
    version: string;
    tarballUrl: string;
    dependencies: Record<string, string>;
}
/**
 * Every package at the top of the tree, plus, under `__nested`, the ones a
 * dependent gets under its own `node_modules`, keyed by their placement.
 */
export interface ResolvedTree extends Map<string, ResolvedPackage> {
    __nested?: Map<string, ResolvedPackage>;
}
export interface ResolveOptions {
    registry?: Registry;
    includeDev?: boolean;
    includeOptional?: boolean;
    onProgress?: (message: string) => void;
}
/**
 * Parse a semver version string into components
 */
declare function parseVersion(version: string): {
    major: number;
    minor: number;
    patch: number;
    prerelease?: string;
} | null;
/**
 * Compare two semver versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
declare function compareVersions(a: string, b: string): number;
/**
 * Check if a version satisfies a semver range
 */
declare function satisfies(version: string, range: string): boolean;
/**
 * Find the best matching version from available versions
 */
declare function findBestVersion(versions: string[], range: string): string | null;
/**
 * Resolve all dependencies for a package
 */
export declare function resolveDependencies(packageName: string, versionRange?: string, options?: ResolveOptions): Promise<Map<string, ResolvedPackage>>;
/**
 * Resolve dependencies from a package.json
 */
export declare function resolveFromPackageJson(packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}, options?: ResolveOptions): Promise<Map<string, ResolvedPackage>>;
export { parseVersion, compareVersions, satisfies, findBestVersion };
//# sourceMappingURL=resolver.d.ts.map