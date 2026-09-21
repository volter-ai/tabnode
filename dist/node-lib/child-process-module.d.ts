/** Node's `child_process` module object, as a program receives it. */
export interface ChildProcessModule {
    ChildProcess: new () => unknown;
    spawn: (...args: unknown[]) => unknown;
    spawnSync: (...args: unknown[]) => unknown;
    exec: (...args: unknown[]) => unknown;
    execSync: (...args: unknown[]) => unknown;
    execFile: (...args: unknown[]) => unknown;
    execFileSync: (...args: unknown[]) => unknown;
    fork: (...args: unknown[]) => unknown;
    _forkChild: (fd: number, serializationMode: string) => void;
}
/** The loaded module: Node's own `child_process.js`, evaluated once. */
export declare const childProcessModule: ChildProcessModule;
/**
 * `setupChannel` from Node's `internal/child_process.js`: what wires one end
 * of an IPC channel onto a process object. The parent's end is wired by
 * `ChildProcess.prototype.spawn`; the child's is wired by the engine's `node`
 * command, which is this engine's `lib/internal/process/pre_execution.js`.
 */
export interface ChannelControl {
    refCounted(): void;
    unrefCounted(): void;
}
export declare function setupChannel(target: unknown, channel: unknown, serializationMode: string): ChannelControl;
//# sourceMappingURL=child-process-module.d.ts.map