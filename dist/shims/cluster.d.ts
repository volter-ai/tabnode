/**
 * cluster shim - Clustering is not available in browser
 */
import { EventEmitter } from '../node-lib/events-module';
export declare const isMaster = true;
export declare const isPrimary = true;
export declare const isWorker = false;
export declare class Worker extends EventEmitter {
    id: number;
    process: null;
    send(_message: unknown, _callback?: (error: Error | null) => void): boolean;
    kill(_signal?: string): void;
    disconnect(): void;
    isDead(): boolean;
    isConnected(): boolean;
}
export declare const worker: Worker | null;
export declare const workers: Record<number, Worker>;
export declare function fork(_env?: object): Worker;
export declare function disconnect(_callback?: () => void): void;
export declare const settings: {};
export declare const SCHED_NONE = 1;
export declare const SCHED_RR = 2;
export declare let schedulingPolicy: number;
export declare function setupMaster(_settings?: object): void;
export declare function setupPrimary(_settings?: object): void;
export declare const on: (event: string, listener: (...args: any[]) => void) => unknown;
export declare const once: (event: string, listener: (...args: any[]) => void) => unknown;
export declare const emit: (event: string, ...args: unknown[]) => boolean;
export declare const removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
declare const _default: {
    isMaster: boolean;
    isPrimary: boolean;
    isWorker: boolean;
    Worker: typeof Worker;
    worker: null;
    workers: Record<number, Worker>;
    fork: typeof fork;
    disconnect: typeof disconnect;
    settings: {};
    SCHED_NONE: number;
    SCHED_RR: number;
    schedulingPolicy: number;
    setupMaster: typeof setupMaster;
    setupPrimary: typeof setupPrimary;
    on: (event: string, listener: (...args: any[]) => void) => unknown;
    once: (event: string, listener: (...args: any[]) => void) => unknown;
    emit: (event: string, ...args: unknown[]) => boolean;
    removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
};
export default _default;
//# sourceMappingURL=cluster.d.ts.map