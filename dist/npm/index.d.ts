/**
 * npm Package Manager
 * Orchestrates package installation into the virtual file system
 */
import { VirtualFS } from '../virtual-fs';
import { RegistryOptions } from './registry';
import { ResolvedPackage } from './resolver';
/** Turn the install's rewrite pass back on. Nothing in the engine does. */
export declare function setInstallTransformEnabled(enabled: boolean): void;
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
export declare class PackageManager {
    private vfs;
    private registry;
    private cwd;
    constructor(vfs: VirtualFS, options?: {
        cwd?: string;
    } & RegistryOptions);
    /**
     * Install a package and its dependencies
     */
    install(packageSpec: string, options?: InstallOptions): Promise<InstallResult>;
    /**
     * Install all dependencies from package.json
     */
    installFromPackageJson(options?: InstallOptions): Promise<InstallResult>;
    /**
     * Install resolved packages to node_modules
     */
    private installResolved;
    /**
     * Write lockfile with resolved versions
     */
    private writeLockfile;
    /**
     * Update package.json with new dependency
     */
    private updatePackageJson;
    /**
     * List installed packages
     */
    list(): Record<string, string>;
}
/**
 * Parse a package specifier into name and version
 * Examples: "express", "express@4.18.2", "@types/node@18"
 */
declare function parsePackageSpec(spec: string): {
    name: string;
    version?: string;
};
export declare function install(packageSpec: string, vfs: VirtualFS, options?: InstallOptions): Promise<InstallResult>;
export { Registry } from './registry';
export type { RegistryOptions, PackageVersion, PackageManifest } from './registry';
export type { ResolvedPackage, ResolveOptions } from './resolver';
export type { ExtractOptions } from './tarball';
export { parsePackageSpec };
//# sourceMappingURL=index.d.ts.map