/**
 * Dependency Resolver
 * Resolves full dependency tree with semver version constraints
 */

import { Registry, PackageVersion, encodePackageName } from './registry';

declare global {
  /**
   * The lockfile the page read for the project being installed, name to the
   * version it pinned. The engine builds its package manager itself, with no
   * options of ours, so the page hands the records over through globals.
   */
  // eslint-disable-next-line no-var
  var __browserRuntimeLockfilePins: Map<string, string> | undefined;
  /** Every version the lockfile recorded, by package name and then version. */
  // eslint-disable-next-line no-var
  var __browserRuntimeLockfileRecords: Map<string, Map<string, LockfileRecord>> | undefined;
}

/** One version as a lockfile wrote it down. */
export interface LockfileRecord {
  resolved?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
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

interface ResolveContext {
  registry: Registry;
  resolved: ResolvedTree;
  resolving: Set<string>;
  options: ResolveOptions;
  /** A dependent's own `node_modules`, by placement; see `__browserRuntimeNest`. */
  nested?: Map<string, ResolvedPackage>;
  /** The dependencies of each root package chosen in the first pass, descended in the second. */
  rootDeps?: Map<string, Record<string, string>>;
}

/**
 * Parse a semver version string into components
 */
function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
} | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  };
}

/**
 * Compare two semver versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  if (!parsedA || !parsedB) {
    return a.localeCompare(b);
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch - parsedB.patch;
  }

  // Prerelease versions are lower than release versions
  if (parsedA.prerelease && !parsedB.prerelease) return -1;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  if (parsedA.prerelease && parsedB.prerelease) {
    return parsedA.prerelease.localeCompare(parsedB.prerelease);
  }

  return 0;
}

/**
 * Check if a version satisfies a semver range
 */
function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  // Skip prerelease versions unless explicitly requested
  if (parsed.prerelease && !range.includes('-')) {
    return false;
  }

  range = range.trim();
  // A lone `=` or `v` before a whole version means that version: SvelteKit's tree
  // pins `@oxc-project/types@=0.148.0`, which fell through every branch below.
  range = range.replace(/^=\s*/, "").replace(/^v(?=\d)/, "");
  range = range.replace(/(>=|<=|>|<|=)\s*(\d+)(\.\d+)?(?![.\d])/g, (__m: string, __op: string, __major: string, __minor: string | undefined) => __op + " " + __major + (__minor === void 0 ? ".0.0" : __minor + ".0"));
  // Real packages also write partial caret/tilde ranges (`^1`, `~1.2`), which
  // the whole-version branches below never matched.
  const __browserRuntimePartialRange = range.match(/^([~^])(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (__browserRuntimePartialRange) {
    const operator = __browserRuntimePartialRange[1];
    const major = Number(__browserRuntimePartialRange[2]);
    const hasMinor = __browserRuntimePartialRange[3] !== void 0;
    const hasPatch = __browserRuntimePartialRange[4] !== void 0;
    const minor = Number(__browserRuntimePartialRange[3] ?? 0);
    const patch = Number(__browserRuntimePartialRange[4] ?? 0);
    const lower = major + "." + minor + "." + patch;
    let upper: string;
    if (operator === "~") {
      upper = hasMinor ? major + "." + (minor + 1) + ".0" : major + 1 + ".0.0";
    } else if (major > 0 || !hasMinor) {
      upper = major + 1 + ".0.0";
    } else if (minor > 0 || !hasPatch) {
      upper = "0." + (minor + 1) + ".0";
    } else {
      upper = "0.0." + (patch + 1);
    }
    return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0;
  }

  // Exact version
  if (/^\d+\.\d+\.\d+/.test(range) && !range.includes(' ')) {
    const rangeMatch = range.match(/^(\d+\.\d+\.\d+(?:-[^\s]+)?)/);
    if (rangeMatch) {
      return compareVersions(version, rangeMatch[1]) === 0;
    }
  }

  // Latest or * - any version
  if (range === '*' || range === 'latest' || range === '') {
    return true;
  }

  // Multiple ranges with ||
  if (range.includes('||')) {
    return range.split('||').some((r) => satisfies(version, r.trim()));
  }

  // Range with hyphen: 1.0.0 - 2.0.0
  if (range.includes(' - ')) {
    const [min, max] = range.split(' - ').map((s) => s.trim());
    return compareVersions(version, min) >= 0 && compareVersions(version, max) <= 0;
  }

  // Compound ranges with operators: >= 2.1.2 < 3.0.0
  // Parse all operators and versions from the range
  const operatorMatches = range.match(/(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[^\s]*)?)/g);
  if (operatorMatches && operatorMatches.length > 1) {
    return operatorMatches.every((match) => {
      const m = match.match(/^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[^\s]*)?)$/);
      if (!m) return true;
      const op = m[1] || '=';
      const ver = m[2];
      switch (op) {
        case '>=': return compareVersions(version, ver) >= 0;
        case '<=': return compareVersions(version, ver) <= 0;
        case '>': return compareVersions(version, ver) > 0;
        case '<': return compareVersions(version, ver) < 0;
        case '=': return compareVersions(version, ver) === 0;
        default: return compareVersions(version, ver) === 0;
      }
    });
  }

  // Caret range: ^1.2.3 means >=1.2.3 <2.0.0 (or <1.3.0 if major is 0)
  if (range.startsWith('^')) {
    const base = range.slice(1);
    const baseParsed = parseVersion(base);
    if (!baseParsed) return false;

    if (parsed.major !== baseParsed.major) {
      return false;
    }

    if (baseParsed.major === 0) {
      // ^0.x.y is more restrictive
      if (baseParsed.minor !== 0 && parsed.minor !== baseParsed.minor) {
        return false;
      }
      if (baseParsed.minor === 0 && parsed.minor !== 0) {
        return false;
      }
    }

    return compareVersions(version, base) >= 0;
  }

  // Tilde range: ~1.2.3 means >=1.2.3 <1.3.0
  if (range.startsWith('~')) {
    const base = range.slice(1);
    const baseParsed = parseVersion(base);
    if (!baseParsed) return false;

    if (parsed.major !== baseParsed.major || parsed.minor !== baseParsed.minor) {
      return false;
    }

    return compareVersions(version, base) >= 0;
  }

  // Greater than or equal: >=1.2.3
  if (range.startsWith('>=')) {
    const base = range.slice(2).trim();
    return compareVersions(version, base) >= 0;
  }

  // Greater than: >1.2.3
  if (range.startsWith('>')) {
    const base = range.slice(1).trim();
    return compareVersions(version, base) > 0;
  }

  // Less than or equal: <=1.2.3
  if (range.startsWith('<=')) {
    const base = range.slice(2).trim();
    return compareVersions(version, base) <= 0;
  }

  // Less than: <1.2.3
  if (range.startsWith('<')) {
    const base = range.slice(1).trim();
    return compareVersions(version, base) < 0;
  }

  // X-ranges: 1.x, 1.2.x, 1, 1.2
  if (range.includes('x') || range.includes('X') || /^\d+$/.test(range) || /^\d+\.\d+$/.test(range)) {
    const parts = range.replace(/[xX]/g, '').split('.').filter(Boolean);

    if (parts.length === 1) {
      return parsed.major === parseInt(parts[0], 10);
    }
    if (parts.length === 2) {
      return (
        parsed.major === parseInt(parts[0], 10) &&
        parsed.minor === parseInt(parts[1], 10)
      );
    }
  }

  // Multiple conditions with space (AND) - handle simple cases
  if (range.includes(' ')) {
    const conditions = range.split(/\s+/).filter(Boolean);
    return conditions.every((r) => satisfies(version, r));
  }

  // Fallback: try exact match
  return compareVersions(version, range) === 0;
}

/**
 * Find the best matching version from available versions
 */
function findBestVersion(versions: string[], range: string): string | null {
  // Sort versions in descending order
  const sorted = [...versions].sort((a, b) => compareVersions(b, a));

  // Find the first version that satisfies the range
  for (const version of sorted) {
    if (satisfies(version, range)) {
      return version;
    }
  }

  return null;
}

/**
 * Resolve all dependencies for a package
 */
export async function resolveDependencies(
  packageName: string,
  versionRange: string = 'latest',
  options: ResolveOptions = {}
): Promise<Map<string, ResolvedPackage>> {
  const registry = options.registry || new Registry();
  const context: ResolveContext = {
    registry,
    resolved: new Map(),
    resolving: new Set(),
    options,
  };

  await resolvePackage(packageName, versionRange, context);

  context.resolved.__nested = context.nested;
  return context.resolved;
}

/**
 * Resolve dependencies from a package.json
 */
export async function resolveFromPackageJson(
  packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
  options: ResolveOptions = {}
): Promise<Map<string, ResolvedPackage>> {
  const registry = options.registry || new Registry();
  const context: ResolveContext = {
    registry,
    resolved: new Map(),
    resolving: new Set(),
    options,
  };

  const deps = { ...packageJson.dependencies };

  if (options.includeDev && packageJson.devDependencies) {
    Object.assign(deps, packageJson.devDependencies);
  }

  // A lockfile names every version up front, so every manifest the walk will
  // ask for is known before it starts. Asked for one at a time, each a
  // registry round trip, a 700-package tree spent a hundred seconds on
  // metadata before a single tarball arrived. With pins in hand they are
  // fetched together, thirty-two at a time, into the registry client's cache;
  // the walk then finds each one already there. A pin whose manifest cannot
  // be fetched is left to the walk, which reports it.
  const __pins = globalThis.__browserRuntimeLockfilePins;
  if (__pins instanceof Map && __pins.size > 0) {
    const __names = [...__pins.keys()];
    for (let __index = 0; __index < __names.length; __index += 32) {
      await Promise.all(__names.slice(__index, __index + 32).map((name3) => registry.getPackageManifest(name3).catch(() => void 0)));
    }
  }
  // The root's own dependencies are chosen first, each at the best version
  // its own range allows, and only then are their dependencies walked. Walked
  // in one pass, a dependency's narrower range for a name the root also
  // names was met first and the root's range accepted what it had chosen:
  // one package asked `>=19 <19.3` of react and the root's `^19.2.4` took
  // 19.2.8 while react-dom went to 19.3.0, which React refuses to run. npm
  // gives the root its version and nests the dependent's.
  context.rootDeps = new Map();
  for (const [name, range] of Object.entries(deps)) {
    await resolvePackage(name, range, context, undefined, "choose");
  }
  for (const [name, range] of Object.entries(deps)) {
    await resolvePackage(name, range, context, undefined, "descend");
  }

  context.resolved.__nested = context.nested;
  return context.resolved;
}

/**
 * Two versions of one package in one tree. The engine installs one version
 * per name, flat, and a dependent whose range the top of the tree does not
 * satisfy got the wrong one: React Router's build found semver 6 where
 * normalize-package-data wanted 7. A lockfile records every version; a range
 * the top does not satisfy takes the highest recorded version that does,
 * installed under the dependent's own `node_modules`, where Node's walk up
 * finds it first, and its own dependencies resolve from there.
 */
async function __browserRuntimeNest(packageName: string, versionRange: string, context: ResolveContext, parentKey: string | undefined, registryName: string = packageName): Promise<void> {
  const records = globalThis.__browserRuntimeLockfileRecords;
  const versions = records instanceof Map ? records.get(packageName) : void 0;
  if (!versions) return;
  const candidates = [...versions.keys()].filter((version2) => satisfies(version2, versionRange)).sort((a, b) => compareVersions(b, a));
  const version = candidates[0];
  if (!version) return;
  const nestedKey = parentKey ? `${parentKey}/node_modules/${packageName}` : packageName;
  context.nested ??= new Map();
  if (context.nested.has(nestedKey) || context.resolving.has(nestedKey)) return;
  context.resolving.add(nestedKey);
  try {
    const doc = versions.get(version)!;
    // The lockfile's own tarball where it recorded one; else the registry's place for the name the registry knows, which an alias differs from.
    const tarballUrl = doc.resolved || `${context.registry.registryFor(registryName)}/${encodePackageName(registryName)}/-/${registryName.slice(registryName.lastIndexOf("/") + 1)}-${version}.tgz`;
    context.nested.set(nestedKey, { name: packageName, version, tarballUrl, dependencies: doc.dependencies || {} });
    const deps: Record<string, string> = {};
    if (doc.peerDependencies) {
      const meta = doc.peerDependenciesMeta || {};
      for (const [name2, range] of Object.entries(doc.peerDependencies)) {
        if (!(meta[name2] && meta[name2].optional)) deps[name2] = range;
      }
    }
    Object.assign(deps, doc.dependencies);
    if (context.options.includeOptional && doc.optionalDependencies) Object.assign(deps, doc.optionalDependencies);
    for (const [depName, depRange] of Object.entries(deps)) {
      await resolvePackage(depName, depRange, context, nestedKey);
    }
  } finally {
    context.resolving.delete(nestedKey);
  }
}

/**
 * Recursively resolve a single package and its dependencies
 */
async function resolvePackage(
  packageName: string,
  versionRange: string,
  context: ResolveContext,
  __parent?: string,
  phase?: "choose" | "descend"
): Promise<void> {
  // The second pass over a root dependency: its dependencies, chosen in the first.
  if (phase === "descend") {
    const chosen = context.rootDeps?.get(packageName);
    if (!chosen) return;
    context.rootDeps!.delete(packageName);
    await descendInto(packageName, chosen, context);
    return;
  }
  // `"wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"` installs wrap-ansi under the name
  // wrap-ansi-cjs; dependency trees lean on this shape, and the range was read
  // as a whole version range. The registry is asked for the package the alias
  // names, its version chosen by the range after the `@`, and the result
  // recorded under the alias, which is where the code that imports it looks.
  let __registryName = packageName;
  if (typeof versionRange === "string" && versionRange.startsWith("npm:")) {
    const __spec = versionRange.slice(4);
    const __at = __spec.lastIndexOf("@");
    __registryName = __at > 0 ? __spec.slice(0, __at) : __spec;
    versionRange = __at > 0 ? __spec.slice(__at + 1) : "latest";
  }
  const { registry, resolved, resolving, options } = context;

  // Create a key for this package request
  const key = `${packageName}@${versionRange}`;

  // Check if we're already resolving this (circular dependency)
  if (resolving.has(key)) {
    return;
  }

  // Check if we've already resolved a compatible version
  if (resolved.has(packageName)) {
    const existing = resolved.get(packageName)!;
    if (satisfies(existing.version, versionRange)) {
      return;
    }
    await __browserRuntimeNest(packageName, versionRange, context, __parent, typeof __registryName === "string" ? __registryName : packageName);
    return;
  }

  resolving.add(key);

  try {
    options.onProgress?.(`Resolving ${packageName}@${versionRange}`);

    // Fetch package manifest
    const manifest = await registry.getPackageManifest(__registryName);

    // Find best matching version
    const versions = Object.keys(manifest.versions);
    let targetVersion: string;

    // A lockfile pins this walk. Where the page has read a lockfile for the
    // project being installed, the version it recorded is taken instead of
    // the best match for the range, so an install is the install the project
    // recorded, whichever manager wrote it. A name the lockfile does not
    // carry resolves by range, below, as before.
    const __pinned = globalThis.__browserRuntimeLockfilePins;
    const __pin = __pinned instanceof Map ? __pinned.get(__registryName) : void 0;
    if (typeof __pin === "string" && manifest.versions[__pin]) {
      const versionData2 = manifest.versions[__pin];
      const resolvedPackage2: ResolvedPackage = {
        name: packageName,
        version: __pin,
        tarballUrl: versionData2.dist.tarball,
        dependencies: versionData2.dependencies || {}
      };
      resolved.set(packageName, resolvedPackage2);
      const deps2: Record<string, string> = {};
      if (versionData2.peerDependencies) {
        const meta2 = versionData2.peerDependenciesMeta || {};
        for (const [name3, range2] of Object.entries(versionData2.peerDependencies)) {
          if (!(meta2[name3] == null ? void 0 : meta2[name3].optional)) deps2[name3] = range2;
        }
      }
      Object.assign(deps2, versionData2.dependencies);
      if (options.includeOptional && versionData2.optionalDependencies) {
        Object.assign(deps2, versionData2.optionalDependencies);
      }
      if (phase === "choose") context.rootDeps!.set(packageName, deps2);
      else await descendInto(packageName, deps2, context);
      // The top of the tree is the lockfile's pin; a dependent whose range
      // it does not satisfy gets the version the lockfile recorded for it, nested.
      if (!satisfies(__pin, versionRange)) await __browserRuntimeNest(packageName, versionRange, context, __parent, __registryName);
      return;
    }

    if (versionRange === 'latest' || versionRange === '*') {
      targetVersion = manifest['dist-tags'].latest;
    } else if (manifest['dist-tags'][versionRange]) {
      targetVersion = manifest['dist-tags'][versionRange];
    } else {
      const best = findBestVersion(versions, versionRange);
      if (!best) {
        throw new Error(
          `No matching version found for ${packageName}@${versionRange}`
        );
      }
      targetVersion = best;
    }

    // Get version metadata
    const versionData = manifest.versions[targetVersion];

    // Store resolved package
    const resolvedPackage: ResolvedPackage = {
      name: packageName,
      version: targetVersion,
      tarballUrl: versionData.dist.tarball,
      dependencies: versionData.dependencies || {},
    };

    resolved.set(packageName, resolvedPackage);

    // Resolve dependencies in parallel
    // Include non-optional peerDependencies (npm v7+ behavior).
    // Peer deps marked optional in peerDependenciesMeta are skipped.
    const deps: Record<string, string> = {};

    if (versionData.peerDependencies) {
      const meta = versionData.peerDependenciesMeta || {};
      for (const [name, range] of Object.entries(versionData.peerDependencies)) {
        if (!meta[name]?.optional) {
          deps[name] = range;
        }
      }
    }

    // Regular dependencies override peer deps
    Object.assign(deps, versionData.dependencies);

    if (options.includeOptional && versionData.optionalDependencies) {
      Object.assign(deps, versionData.optionalDependencies);
    }

    if (phase === "choose") context.rootDeps!.set(packageName, deps);
    else await descendInto(packageName, deps, context);
  } finally {
    resolving.delete(key);
  }
}

/** Resolves a package's dependencies, a few at a time. */
async function descendInto(packageName: string, deps: Record<string, string>, context: ResolveContext): Promise<void> {
  const depEntries = Object.entries(deps);
  if (depEntries.length === 0) return;
  const CONCURRENCY = 8;
  for (let i = 0; i < depEntries.length; i += CONCURRENCY) {
    const batch = depEntries.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(([depName, depRange]) => resolvePackage(depName, depRange, context, packageName))
    );
  }
}

// Export utilities for testing
export { parseVersion, compareVersions, satisfies, findBestVersion };
