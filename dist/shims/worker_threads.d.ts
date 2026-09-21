/**
 * worker_threads shim - Worker threads API
 * Stub implementation for browser environment
 */
import { EventEmitter } from '../node-lib/events-module';
export declare const isMainThread = true;
export declare const parentPort: null;
export declare const workerData: null;
export declare const threadId = 0;
export declare class Worker extends EventEmitter {
    threadId: number;
    resourceLimits: {};
    constructor(filename: string, options?: {
        workerData?: unknown;
    });
    postMessage(value: unknown, transferList?: unknown[]): void;
    terminate(): Promise<number>;
    ref(): void;
    unref(): void;
    getHeapSnapshot(): Promise<unknown>;
}
export declare class MessageChannel {
    port1: MessagePort;
    port2: MessagePort;
}
export declare class MessagePort extends EventEmitter {
    postMessage(value: unknown, transferList?: unknown[]): void;
    start(): void;
    close(): void;
    ref(): void;
    unref(): void;
}
export declare class BroadcastChannel extends EventEmitter {
    name: string;
    constructor(name: string);
    postMessage(message: unknown): void;
    close(): void;
    ref(): void;
    unref(): void;
}
export declare function moveMessagePortToContext(port: MessagePort, contextifiedSandbox: unknown): MessagePort;
export declare function receiveMessageOnPort(port: MessagePort): {
    message: unknown;
} | undefined;
export declare const SHARE_ENV: unique symbol;
export declare function markAsUntransferable(object: unknown): void;
export declare function getEnvironmentData(key: unknown): unknown;
export declare function setEnvironmentData(key: unknown, value: unknown): void;
declare const _default: {
    isMainThread: boolean;
    parentPort: null;
    workerData: null;
    threadId: number;
    Worker: typeof Worker;
    MessageChannel: typeof MessageChannel;
    MessagePort: typeof MessagePort;
    BroadcastChannel: typeof BroadcastChannel;
    moveMessagePortToContext: typeof moveMessagePortToContext;
    receiveMessageOnPort: typeof receiveMessageOnPort;
    SHARE_ENV: symbol;
    markAsUntransferable: typeof markAsUntransferable;
    getEnvironmentData: typeof getEnvironmentData;
    setEnvironmentData: typeof setEnvironmentData;
};
export default _default;
//# sourceMappingURL=worker_threads.d.ts.map