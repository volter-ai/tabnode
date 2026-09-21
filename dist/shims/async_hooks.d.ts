/**
 * async_hooks shim - Async tracking is not available in browser
 */
export declare class AsyncResource {
    constructor(_type: string, _options?: object);
    runInAsyncScope<T>(fn: (...args: any[]) => T, thisArg?: unknown, ...args: any[]): T;
    emitDestroy(): this;
    asyncId(): number;
    triggerAsyncId(): number;
    static bind<T extends (...args: any[]) => any>(fn: T, _type?: string): T;
}
export declare class AsyncLocalStorage<T> {
    private store;
    constructor();
    static snapshot(): (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => unknown;
    static bind(callback: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
    disable(): void;
    getStore(): T | undefined;
    /**
     * A store entered for an async callback used to be left the moment the
     * callback returned its promise, so the first `await` inside a Server Action
     * lost Next's request store and `cookies()` was "outside a request scope". A
     * tab has no async_hooks and no AsyncContext, and an `await` of a native
     * promise bypasses any `then` a patch could install, so the continuations
     * cannot be followed. What can be done honestly is keep the store current
     * until the callback's promise settles: exact for one run at a time, and
     * last-entered-wins where two async runs overlap.
     */
    run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R;
    exit<R>(callback: () => R): R;
    enterWith(store: T): void;
}
export interface AsyncHook {
    enable(): this;
    disable(): this;
}
export declare function createHook(_callbacks: object): AsyncHook;
export declare function executionAsyncId(): number;
export declare function executionAsyncResource(): object;
export declare function triggerAsyncId(): number;
declare const _default: {
    AsyncResource: typeof AsyncResource;
    AsyncLocalStorage: typeof AsyncLocalStorage;
    createHook: typeof createHook;
    executionAsyncId: typeof executionAsyncId;
    executionAsyncResource: typeof executionAsyncResource;
    triggerAsyncId: typeof triggerAsyncId;
};
export default _default;
//# sourceMappingURL=async_hooks.d.ts.map