/**
 * ESM to CJS Transformer using esbuild-wasm
 *
 * Transforms ES modules to CommonJS format during npm install,
 * so require() can work synchronously.
 */
import { VirtualFS } from './virtual-fs';
/**
 * Initialize esbuild-wasm (reuses existing instance if already initialized)
 */
export declare function initTransformer(): Promise<void>;
/**
 * Check if transformer is ready
 */
export declare function isTransformerReady(): boolean;
/**
 * Transform a single file from ESM to CJS
 */
export declare function transformFile(code: string, filename: string): Promise<string>;
/**
 * Transform all ESM files in a package directory to CJS
 */
export declare function transformPackage(vfs: VirtualFS, pkgPath: string, onProgress?: (msg: string) => void): Promise<number>;
//# sourceMappingURL=transform.d.ts.map