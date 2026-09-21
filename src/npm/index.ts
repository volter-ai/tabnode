/**
 * npm Package Manager
 * Orchestrates package installation into the virtual file system
 */

import { VirtualFS } from '../virtual-fs';
import { Registry, RegistryOptions } from './registry';
import {
  resolveDependencies,
  resolveFromPackageJson,
  ResolvedPackage,
  ResolvedTree,
  ResolveOptions,
} from './resolver';
import { downloadAndExtract, extractTarball, __browserRuntimeInstallPool } from './tarball';
import * as path from '../shims/path';
import { initTransformer, transformPackage, isTransformerReady } from '../transform';

/**
 * Whether the install rewrites the ES modules it unpacks into CommonJS.
 *
 * Off, whatever `transform` asked for: the pass was the largest share of the
 * install's time, fourteen thousand files for a 700-package tree, and nothing
 * needs it. The runtime's module loader transforms an ES module the first
 * time it is required, with the result cached, and the browser-side module
 * server bundles a package from its files with esbuild, which takes ES
 * modules as they are. The install leaves the files as published.
 *
 * A live binding rather than a literal, so the transformer the loader itself
 * uses stays part of the build instead of being folded away with the
 * branches below.
 */
let installTransformEnabled = false;

/** Turn the install's rewrite pass back on. Nothing in the engine does. */
export function setInstallTransformEnabled(enabled: boolean): void {
  installTransformEnabled = enabled;
}

/**
 * Normalize a package.json bin field into a consistent Record<string, string>.
 * Handles both string form ("bin": "cli.js") and object form ("bin": {"cmd": "cli.js"}).
 */
function normalizeBin(pkgName: string, bin?: Record<string, string> | string): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === 'string') {
    // String form uses the package name (without scope) as the command name
    const cmdName = pkgName.includes('/') ? pkgName.split('/').pop()! : pkgName;
    return { [cmdName]: bin };
  }
  return bin;
}

export interface InstallOptions {
  registry?: string;
  save?: boolean;
  saveDev?: boolean;
  includeDev?: boolean;
  includeOptional?: boolean;
  onProgress?: (message: string) => void;
  /** Transform ESM packages to CJS after install (default: true) */
  transform?: boolean;
}

export interface InstallResult {
  installed: Map<string, ResolvedPackage>;
  added: string[];
}

/**
 * npm Package Manager for VirtualFS
 */
export class PackageManager {
  private vfs: VirtualFS;
  private registry: Registry;
  private cwd: string;

  constructor(vfs: VirtualFS, options: { cwd?: string } & RegistryOptions = {}) {
    this.vfs = vfs;
    this.registry = new Registry(options);
    this.cwd = options.cwd || '/';
  }

  /**
   * Install a package and its dependencies
   */
  async install(
    packageSpec: string,
    options: InstallOptions = {}
  ): Promise<InstallResult> {
    const { onProgress } = options;

    // Parse package spec (name@version)
    const { name, version } = parsePackageSpec(packageSpec);

    onProgress?.(`Resolving ${name}@${version || 'latest'}...`);

    // Resolve dependencies
    const resolved = await resolveDependencies(name, version || 'latest', {
      registry: this.registry,
      includeDev: options.includeDev,
      includeOptional: options.includeOptional,
      onProgress,
    });

    // Install all resolved packages
    const added = await this.installResolved(resolved, options);

    // Update package.json if save option is set
    if (options.save || options.saveDev) {
      const pkgToAdd = resolved.get(name);
      if (pkgToAdd) {
        await this.updatePackageJson(
          name,
          `^${pkgToAdd.version}`,
          options.saveDev || false
        );
      }
    }

    onProgress?.(`Installed ${resolved.size} packages`);

    return { installed: resolved, added };
  }

  /**
   * Install all dependencies from package.json
   */
  async installFromPackageJson(options: InstallOptions = {}): Promise<InstallResult> {
    const { onProgress } = options;

    const pkgJsonPath = path.join(this.cwd, 'package.json');

    if (!this.vfs.existsSync(pkgJsonPath)) {
      throw new Error('No package.json found');
    }

    // A workspace install runs member by member, and the page hands the
    // engine the manifest each member is to be installed from: a pnpm or npm
    // workspace rewrites a member's dependencies (a `workspace:*` link is not
    // a registry range) and the file on disk is not what should be resolved.
    // Where the page recorded no manifest for this directory, the file is.
    const pkgJson = (this.vfs as unknown as Record<symbol, Map<string, unknown> | undefined>)[Symbol.for('@volter/browser-node/workspace-install-manifests')]?.get(this.cwd)
      ?? JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));

    onProgress?.('Resolving dependencies...');

    // Resolve all dependencies
    const resolved = await resolveFromPackageJson(pkgJson, {
      registry: this.registry,
      includeDev: options.includeDev,
      includeOptional: options.includeOptional,
      onProgress,
    });

    // Install all resolved packages
    const added = await this.installResolved(resolved, options);

    onProgress?.(`Installed ${resolved.size} packages`);

    return { installed: resolved, added };
  }

  /**
   * Install resolved packages to node_modules
   */
  private async installResolved(
    resolved: ResolvedTree,
    options: InstallOptions
  ): Promise<string[]> {
    const { onProgress } = options;
    const added: string[] = [];

    // Ensure node_modules exists
    const nodeModulesPath = path.join(this.cwd, 'node_modules');
    this.vfs.mkdirSync(nodeModulesPath, { recursive: true });

    // Filter packages that need to be installed
    const toInstall: Array<{ name: string; pkg: ResolvedPackage; pkgPath: string }> = [];

    for (const [name, pkg] of resolved) {
      const pkgPath = path.join(nodeModulesPath, name);

      // Skip if already installed with same version
      const existingPkgJson = path.join(pkgPath, 'package.json');
      if (this.vfs.existsSync(existingPkgJson)) {
        try {
          const existing = JSON.parse(
            this.vfs.readFileSync(existingPkgJson, 'utf8')
          );
          if (existing.version === pkg.version) {
            onProgress?.(`Skipping ${name}@${pkg.version} (already installed)`);
            continue;
          }
        } catch {
          // Continue with installation if package.json is invalid
        }
      }

      toInstall.push({ name, pkg, pkgPath });
    }

    // The versions a dependent gets under its own node_modules, from the
    // resolver's nested walk: React Router's build found semver 6 where
    // normalize-package-data wanted 7 while the tree stayed flat.
    for (const [nestedKey, pkg] of resolved.__nested instanceof Map ? resolved.__nested : []) {
      toInstall.push({ name: pkg.name, pkg, pkgPath: path.join(nodeModulesPath, nestedKey) });
    }

    // The install rewrote every ES module it unpacked into CommonJS with
    // esbuild, fourteen thousand files for a 700-package tree, and that pass
    // was the largest share of the install's time. Nothing needs it: the
    // runtime's module loader transforms an ES module the first time it is
    // required, with the result cached, and the browser-side module server
    // bundles a package from its files with esbuild, which takes ES modules
    // as they are. The install leaves the files as published.
    const shouldTransform = installTransformEnabled;
    if (shouldTransform && !isTransformerReady()) {
      onProgress?.('Initializing ESM transformer...');
      await initTransformer();
    }

    // Six packages at a time, each batch waiting for its slowest, left the
    // network idle behind one large tarball. A pool keeps every lane busy:
    // as many downloads in flight as the page allows connections, and the
    // extraction they feed serialized under the store's lock.
    const CONCURRENCY = 16;
    onProgress?.(`Installing ${toInstall.length} packages...`);

    await __browserRuntimeInstallPool(toInstall, CONCURRENCY, async ({ name, pkg, pkgPath }) => {
          onProgress?.(`  Downloading ${name}@${pkg.version}...`);

          // With a shared package store, a package the origin has seen is
          // linked instead of downloaded: the hook the worker installs is
          // asked first, and only a declined package is fetched.
          const __installHook = (globalThis as Record<symbol, ((name: string, pkg: ResolvedPackage, pkgPath: string, vfs: VirtualFS) => Promise<boolean>) | undefined>)[Symbol.for("@volter/browser-runtime/package-install")];
          if (!(__installHook && await __installHook(name, pkg, pkgPath, this.vfs))) {
            await downloadAndExtract(pkg.tarballUrl, this.vfs, pkgPath, {
              stripComponents: 1, // Strip "package/" prefix
            });
          }

          // Transform ESM to CJS
          if (shouldTransform) {
            try {
              const count = await transformPackage(this.vfs, pkgPath, onProgress);
              if (count > 0) {
                onProgress?.(`  Transformed ${count} files in ${name}`);
              }
            } catch (transformError) {
              onProgress?.(`  Warning: Transform failed for ${name}: ${transformError}`);
            }
          }

          // Create bin stubs in /node_modules/.bin/
          try {
            const pkgJsonPath = path.join(pkgPath, 'package.json');
            if (this.vfs.existsSync(pkgJsonPath)) {
              const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
              const binEntries = normalizeBin(name, pkgJson.bin);
              // A nested package's stubs belong to the node_modules it sits in.
              const binDir = path.join(pkgPath.slice(0, pkgPath.lastIndexOf("/node_modules/") + "/node_modules".length), ".bin");
              for (const [cmdName, entryPath] of Object.entries(binEntries)) {
                this.vfs.mkdirSync(binDir, { recursive: true });
                const targetPath = path.join(pkgPath, entryPath);
                this.vfs.writeFileSync(
                  path.join(binDir, cmdName),
                  `node "${targetPath}" "$@"\n`
                );
              }
            }
          } catch {
            // Non-critical — skip if bin stub creation fails
          }

          added.push(name);
    });

    // Create .package-lock.json for tracking
    await this.writeLockfile(resolved);

    return added;
  }

  /**
   * Write lockfile with resolved versions
   */
  private async writeLockfile(
    resolved: Map<string, ResolvedPackage>
  ): Promise<void> {
    const lockfile: Record<string, { version: string; resolved: string }> = {};

    for (const [name, pkg] of resolved) {
      lockfile[name] = {
        version: pkg.version,
        resolved: pkg.tarballUrl,
      };
    }

    const lockfilePath = path.join(this.cwd, 'node_modules', '.package-lock.json');
    this.vfs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));
  }

  /**
   * Update package.json with new dependency
   */
  private async updatePackageJson(
    packageName: string,
    version: string,
    isDev: boolean
  ): Promise<void> {
    const pkgJsonPath = path.join(this.cwd, 'package.json');

    let pkgJson: Record<string, unknown> = {};

    if (this.vfs.existsSync(pkgJsonPath)) {
      pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
    }

    const field = isDev ? 'devDependencies' : 'dependencies';

    if (!pkgJson[field]) {
      pkgJson[field] = {};
    }

    (pkgJson[field] as Record<string, string>)[packageName] = version;

    this.vfs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
  }

  /**
   * List installed packages
   */
  list(): Record<string, string> {
    const nodeModulesPath = path.join(this.cwd, 'node_modules');

    if (!this.vfs.existsSync(nodeModulesPath)) {
      return {};
    }

    const packages: Record<string, string> = {};
    const entries = this.vfs.readdirSync(nodeModulesPath);

    for (const entry of entries) {
      // Skip hidden files and non-package entries
      if (entry.startsWith('.')) continue;

      // Handle scoped packages (@org/pkg)
      if (entry.startsWith('@')) {
        const scopePath = path.join(nodeModulesPath, entry);
        const scopedPkgs = this.vfs.readdirSync(scopePath);

        for (const scopedPkg of scopedPkgs) {
          const pkgJsonPath = path.join(scopePath, scopedPkg, 'package.json');
          if (this.vfs.existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
            packages[`${entry}/${scopedPkg}`] = pkgJson.version;
          }
        }
      } else {
        const pkgJsonPath = path.join(nodeModulesPath, entry, 'package.json');
        if (this.vfs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
          packages[entry] = pkgJson.version;
        }
      }
    }

    return packages;
  }
}

/**
 * Parse a package specifier into name and version
 * Examples: "express", "express@4.18.2", "@types/node@18"
 */
function parsePackageSpec(spec: string): { name: string; version?: string } {
  // Handle scoped packages
  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/');
    if (slashIndex === -1) {
      throw new Error(`Invalid package spec: ${spec}`);
    }

    const afterSlash = spec.slice(slashIndex + 1);
    const atIndex = afterSlash.indexOf('@');

    if (atIndex === -1) {
      return { name: spec };
    }

    return {
      name: spec.slice(0, slashIndex + 1 + atIndex),
      version: afterSlash.slice(atIndex + 1),
    };
  }

  // Regular packages
  const atIndex = spec.indexOf('@');
  if (atIndex === -1) {
    return { name: spec };
  }

  return {
    name: spec.slice(0, atIndex),
    version: spec.slice(atIndex + 1),
  };
}

// Convenience function for quick installs
export async function install(
  packageSpec: string,
  vfs: VirtualFS,
  options?: InstallOptions
): Promise<InstallResult> {
  const pm = new PackageManager(vfs);
  return pm.install(packageSpec, options);
}

// Re-export types and modules
export { Registry } from './registry';
export type { RegistryOptions, PackageVersion, PackageManifest } from './registry';
export type { ResolvedPackage, ResolveOptions } from './resolver';
export type { ExtractOptions } from './tarball';
export { parsePackageSpec };
