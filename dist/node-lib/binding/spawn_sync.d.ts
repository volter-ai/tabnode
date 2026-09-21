/** One entry of Node's `options.stdio`, as `getValidStdio(stdio, true)` builds it. */
interface SyncStdioEntry {
    type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap';
    fd?: number;
    input?: Uint8Array;
}
/** What `child_process.js`'s `spawnSync` hands the binding. */
interface SyncSpawnOptions {
    file: string;
    args?: string[];
    cwd?: string;
    envPairs?: string[];
    stdio?: SyncStdioEntry[];
    maxBuffer?: number;
    killSignal?: number;
}
/** What libuv answers for one synchronous child. */
interface SyncSpawnResult {
    pid: number;
    output: Array<Uint8Array | null> | null;
    status: number | null;
    signal: string | null;
    error?: number;
}
declare function spawn(options: SyncSpawnOptions): SyncSpawnResult;
declare const _default: {
    spawn: typeof spawn;
};
export default _default;
//# sourceMappingURL=spawn_sync.d.ts.map