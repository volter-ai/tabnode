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
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
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
  // eslint-disable-next-line no-var
  var __browserRuntimeLockfileManifests: Map<string, LockfileVersionDoc> | undefined;
  /**
   * An `@scope`, or a whole unscoped name, to the registry that answers for
   * it. The engine builds its package manager itself, with no options of
   * ours, so a page's scopes arrive the way the lockfile's records do.
   */
  // eslint-disable-next-line no-var
  var __browserRuntimeRegistryScopes: Record<string, string> | undefined;
}

/** One version's record in a lockfile, as the page hands it over. */
export interface LockfileVersionDoc {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export class Registry {
  // Read by the resolver when it forms a tarball URL for a nested version.
  registryUrl: string;
  registryScopes?: Record<string, string>;
  private cache: Map<string, PackageManifest>;

  constructor(options: RegistryOptions = {}) {
    this.registryUrl = options.registry || DEFAULT_REGISTRY;
    this.registryScopes = options.registryScopes;
    this.cache = options.cache || new Map();
  }

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
  registryFor(packageName: string): string {
    const scopes = this.registryScopes ?? globalThis.__browserRuntimeRegistryScopes;
    if (scopes && typeof packageName === "string") {
      const scope = packageName.startsWith("@") && packageName.includes("/") ? packageName.slice(0, packageName.indexOf("/")) : packageName;
      const url = scopes[scope] ?? scopes[packageName];
      if (typeof url === "string" && url !== "") return url.endsWith("/") ? url.slice(0, -1) : url;
    }
    return this.registryUrl;
  }

  /**
   * Fetch package manifest (all versions metadata)
   */
  async getPackageManifest(packageName: string): Promise<PackageManifest> {
    // Check cache first
    if (this.cache.has(packageName)) {
      return this.cache.get(packageName)!;
    }

    // With a lockfile in hand the resolver already knows every version, so the
    // whole packument, every version a package ever published, is the wrong
    // request: it is the largest download of an install and the slowest part
    // of a cold one. A pinned name asks for that one version instead, and the
    // answer is shaped like a one-version packument so the rest of the
    // resolver is unchanged.
    const __docs = globalThis.__browserRuntimeLockfileManifests;
    const __doc = __docs instanceof Map ? __docs.get(packageName) : void 0;
    if (__doc) {
      // The lockfile's record of the version stands in for the registry's
      // document: the tarball is where a registry keeps one, and what the
      // version depends on is what the lockfile wrote down.
      const __tarball = `${this.registryFor(packageName)}/${encodePackageName(packageName)}/-/${packageName.slice(packageName.lastIndexOf("/") + 1)}-${__doc.version}.tgz`;
      const __manifest = { "dist-tags": { latest: __doc.version }, versions: { [__doc.version]: { name: packageName, version: __doc.version, dist: { tarball: __tarball }, dependencies: __doc.dependencies, ...(__doc.peerDependencies ? { peerDependencies: __doc.peerDependencies, peerDependenciesMeta: __doc.peerDependenciesMeta || {} } : {}), ...(__doc.optionalDependencies ? { optionalDependencies: __doc.optionalDependencies } : {}) } } } as unknown as PackageManifest;
      this.cache.set(packageName, __manifest);
      return __manifest;
    }
    const __pins = globalThis.__browserRuntimeLockfilePins;
    const __pin = __pins instanceof Map ? __pins.get(packageName) : void 0;
    if (typeof __pin === "string") {
      const pinnedUrl = `${this.registryFor(packageName)}/${encodePackageName(packageName)}/${__pin}`;
      const pinnedResponse = await fetch(pinnedUrl, { headers: { Accept: "application/json" } });
      if (pinnedResponse.ok) {
        const versionData = await pinnedResponse.json() as PackageVersion;
        if (versionData && versionData.dist && versionData.dist.tarball) {
          const pinnedManifest = { "dist-tags": { latest: __pin }, versions: { [__pin]: versionData } } as unknown as PackageManifest;
          this.cache.set(packageName, pinnedManifest);
          return pinnedManifest;
        }
      }
    }

    const url = `${this.registryFor(packageName)}/${encodePackageName(packageName)}`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Package not found: ${packageName}`);
      }
      throw new Error(`Failed to fetch package ${packageName}: ${response.status}`);
    }

    const manifest = (await response.json()) as PackageManifest;

    // Cache the result
    this.cache.set(packageName, manifest);

    return manifest;
  }

  /**
   * Get specific version metadata
   */
  async getPackageVersion(
    packageName: string,
    version: string
  ): Promise<PackageVersion> {
    const manifest = await this.getPackageManifest(packageName);

    // Handle dist-tags (like "latest", "next", etc.)
    if (manifest['dist-tags'][version]) {
      version = manifest['dist-tags'][version];
    }

    const versionData = manifest.versions[version];
    if (!versionData) {
      throw new Error(`Version ${version} not found for package ${packageName}`);
    }

    return versionData;
  }

  /**
   * Get latest version number
   */
  async getLatestVersion(packageName: string): Promise<string> {
    const manifest = await this.getPackageManifest(packageName);
    return manifest['dist-tags'].latest;
  }

  /**
   * Get all available versions
   */
  async getVersions(packageName: string): Promise<string[]> {
    const manifest = await this.getPackageManifest(packageName);
    return Object.keys(manifest.versions);
  }

  /**
   * Download tarball as ArrayBuffer
   */
  async downloadTarball(tarballUrl: string): Promise<ArrayBuffer> {
    const response = await fetch(tarballUrl);

    if (!response.ok) {
      throw new Error(`Failed to download tarball: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Encode scoped package names for URL
 * @scoped/package -> @scoped%2fpackage
 */
export function encodePackageName(name: string): string {
  return name.replace('/', '%2f');
}

// Default registry instance
export const registry = new Registry();

export default Registry;
