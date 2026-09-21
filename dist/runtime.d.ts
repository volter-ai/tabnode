/**
 * Runtime - Execute user code with shimmed Node.js globals
 *
 * ESM to CJS transformation is now handled during npm install by transform.ts
 * using esbuild-wasm. This runtime just executes the pre-transformed CJS code.
 */
import { VirtualFS } from './virtual-fs';
import type { IExecuteResult } from './runtime-interface';
import { Process } from './shims/process';
export declare function pendingGuestTimers(process: Process): number;
/**
 * Clear every timer a guest still holds, as ending a Node process clears the
 * ones its loop was waiting on. The ids were made by the host's own
 * `setTimeout`/`setInterval` through the guest's global view, so the host's
 * own clears end them; a `Timeout` is cleared by either in Node, and either
 * refusing an id of the other kind is not an error here.
 */
export declare function stopGuestTimers(process: Process): void;
export declare function __substratePendingOf(value: unknown): Promise<void> | undefined;
export interface Module {
    id: string;
    filename: string;
    exports: unknown;
    loaded: boolean;
    children: Module[];
    paths: string[];
    /** The module that first required this one; null for the entry, as Node's is. */
    parent?: Module | null;
}
export interface RuntimeOptions {
    cwd?: string;
    env?: Record<string, string>;
    onConsole?: (method: string, args: unknown[]) => void;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    /** What is on the guest's fd 0, the way a shell puts the left of a pipe there. */
    stdin?: string;
    /** The runner can still write to fd 0, so standard input has not ended. */
    stdinHeld?: boolean;
    /** The run was given a TTY; a pipe child is not one. */
    tty?: boolean;
    /** This run's process number and its parent's; minted where neither is given. */
    pid?: number;
    ppid?: number;
}
export interface RequireFunction {
    (id: string): unknown;
    resolve: (id: string) => string;
    cache: Record<string, Module>;
}
/**
 * Runtime class for executing code in virtual environment
 * Note: This class has sync methods for backward compatibility.
 * Use createRuntime() factory for IRuntime interface compliance.
 */
export declare class Runtime {
    private vfs;
    private fsShim;
    private process;
    private moduleCache;
    private options;
    /** Cache for pre-processed code (after ESM transform) before eval */
    private processedCodeCache;
    constructor(vfs: VirtualFS, options?: RuntimeOptions);
    /**
     * Execute code as a module (synchronous - backward compatible)
     */
    execute(code: string, filename?: string): {
        exports: unknown;
        module: Module;
    };
    /**
     * Execute code as a module (async version for IRuntime interface)
     * Alias: executeSync() is the same as execute() for backward compatibility
     */
    executeSync: (code: string, filename?: string) => {
        exports: unknown;
        module: Module;
    };
    /**
     * Execute code as a module (async - for IRuntime interface)
     */
    executeAsync(code: string, filename?: string): Promise<IExecuteResult>;
    /**
     * Run a file from the virtual file system (synchronous - backward compatible)
     */
    runFile(filename: string): {
        exports: unknown;
        module: Module;
    };
    /**
     * Alias for runFile (backward compatibility)
     */
    runFileSync: (filename: string) => {
        exports: unknown;
        module: Module;
    };
    /**
     * Run a file from the virtual file system (async - for IRuntime interface)
     */
    runFileAsync(filename: string): Promise<IExecuteResult>;
    /**
     * Clear the module cache
     */
    clearCache(): void;
    /**
     * Get the virtual file system
     */
    getVFS(): VirtualFS;
    /**
     * Get the process object
     */
    getProcess(): Process;
    /**
     * Create a REPL context that evaluates expressions and persists state.
     *
     * Returns an object with an `eval` method that:
     * - Returns the value of the last expression (unlike `execute` which returns module.exports)
     * - Persists variables between calls (`var x = 1` then `x` works)
     * - Has access to `require`, `console`, `process`, `Buffer` (same as execute)
     *
     * Security: The eval runs inside a Generator's local scope via direct eval,
     * NOT in the global scope. Only the runtime's own require/console/process are
     * exposed — the same sandbox boundary as execute(). Variables created in the
     * REPL are confined to the generator's closure and cannot leak to the page.
     *
     * Note: `const`/`let` are transformed to `var` so they persist across calls
     * (var hoists to the generator's function scope, const/let are block-scoped
     * to each eval call and would be lost).
     */
    createREPL(): {
        eval: (code: string) => unknown;
    };
}
/**
 * Create and execute code in a new runtime (synchronous - backward compatible)
 */
export declare function execute(code: string, vfs: VirtualFS, options?: RuntimeOptions): {
    exports: unknown;
    module: Module;
};
export type { IRuntime, IExecuteResult, IRuntimeOptions } from './runtime-interface';
export default Runtime;
//# sourceMappingURL=runtime.d.ts.map