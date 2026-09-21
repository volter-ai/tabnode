/**
 * Tarball Extractor
 * Downloads and extracts npm package tarballs into the virtual file system
 */
import { VirtualFS } from '../virtual-fs';
export interface ExtractOptions {
    stripComponents?: number;
    filter?: (path: string) => boolean;
    onProgress?: (message: string) => void;
}
/**
 * Decompress gzipped data
 */
export declare function decompress(data: ArrayBuffer | Uint8Array): Uint8Array;
/**
 * Extract a tarball to the virtual file system
 */
export declare function extractTarball(tarballData: ArrayBuffer | Uint8Array, vfs: VirtualFS, destPath: string, options?: ExtractOptions): string[];
/** Run `work` over `items` with `size` of them in flight, each lane taking the next. */
export declare function __browserRuntimeInstallPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void>;
export declare function downloadAndExtract(url: string, vfs: VirtualFS, destPath: string, options?: ExtractOptions): Promise<string[]>;
declare const _default: {
    decompress: typeof decompress;
    extractTarball: typeof extractTarball;
    downloadAndExtract: typeof downloadAndExtract;
};
export default _default;
//# sourceMappingURL=tarball.d.ts.map