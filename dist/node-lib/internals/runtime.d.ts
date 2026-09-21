/**
 * The internals Node's `net` names that are neither vendored nor a binding:
 * async ids, timers, stream defaults, the option table, and the three
 * one-line answers (`assert`, `hasObserver`, `isBuildingSnapshot`).
 *
 * Each object holds exactly the names the vendored files destructure.
 */
export declare const internalAsyncHooks: {
    symbols: {
        async_id_symbol: symbol;
        trigger_async_id_symbol: symbol;
        owner_symbol: symbol;
        init_symbol: symbol;
        destroy_symbol: symbol;
        async_id_fields: symbol;
    };
    newAsyncId: () => number;
    /**
     * Node's `getOrSetAsyncId`: the id an object already carries, or a new one
     * put on it. `_http_server.js` asks it of every socket it accepts, to name
     * the scope the connection listener runs in.
     */
    getOrSetAsyncId: (object: Record<symbol, unknown>) => number;
    getDefaultTriggerAsyncId: () => number;
    defaultTriggerAsyncIdScope: <A extends unknown[], R>(_triggerAsyncId: number, block: (...args: A) => R, ...args: A) => R;
    initHooksExist: () => boolean;
    afterHooksExist: () => boolean;
    destroyHooksExist: () => boolean;
    emitInit: () => void;
    emitBefore: () => void;
    emitAfter: () => void;
    emitDestroy: () => void;
    hasAsyncIdStack: () => boolean;
    registerDestroyHook: () => void;
};
export declare class AsyncResource {
    #private;
    constructor(_type: string, options?: {
        triggerAsyncId?: number;
        requireManualDestroy?: boolean;
    });
    runInAsyncScope<T>(fn: (...args: never[]) => T, thisArg?: unknown, ...args: never[]): T;
    emitDestroy(): this;
    asyncId(): number;
    triggerAsyncId(): number;
    static bind<T extends (...args: never[]) => unknown>(fn: T, _type?: string): T;
}
/**
 * What `setUnrefTimeout` answers: a timer that can be refreshed in place, as
 * Node's `Timeout` can, and that `timers.clearTimeout` here knows how to stop.
 */
export declare class UnrefTimeout {
    private id;
    private readonly onTimeout;
    private readonly msecs;
    constructor(onTimeout: () => void, msecs: number);
    refresh(): this;
    stop(): void;
    ref(): this;
    unref(): this;
    hasRef(): boolean;
}
export declare const TIMEOUT_MAX: number;
export declare const internalTimers: {
    kTimeout: symbol;
    TIMEOUT_MAX: number;
    setUnrefTimeout: (fn: () => void, msecs: number) => UnrefTimeout;
    /** Node's `getTimerDuration`: a number in range, and 1 for anything under it. */
    getTimerDuration(msecs: unknown, name: string): number;
};
/** `internal/streams/state`: Node's default high-water marks. */
export declare const internalStreamsState: {
    getDefaultHighWaterMark: (objectMode?: boolean) => number;
    setDefaultHighWaterMark: () => void;
};
/** `internal/process/task_queues`: the realm's own microtask queue. */
export declare const internalTaskQueues: {
    queueMicrotask: (fn: () => void) => void;
    setHasTickScheduled: () => void;
    runNextTicks: () => void;
};
export declare const internalEventTarget: {
    kResistStopPropagation: symbol;
    /** `internal/streams/operators.js` marks its abort listener weak with this. */
    kWeakHandler: symbol;
    /**
     * Whether a thing is an `EventTarget`. `events.js` asks before it treats a
     * value as one -- `once`, `on`, `getEventListeners` and `setMaxListeners`
     * all take either an emitter or a target. Node's own `EventTarget` is a
     * class in `internal/event_target.js`; the engine's is the realm's, which
     * is where that class comes from in the first place.
     */
    isEventTarget: (value: unknown) => boolean;
    /**
     * The map Node keeps its own EventTarget's listeners in.
     *
     * THE LOSS, named: the realm's `EventTarget` keeps its listeners where no
     * JavaScript can reach them. The DOM has no way to ask what is listening --
     * `addEventListener` is a door in, and there is no door out -- so
     * `events.getEventListeners(target)` cannot answer for one. It reads this
     * map unguarded, so every target answers with an empty one: the call
     * reports no listeners rather than throwing at a program that asked a fair
     * question. An `EventEmitter` is unaffected; it answers from its own
     * `listeners()`, which is the branch above this one in `events.js`.
     */
    kEvents: symbol;
    kNewListener: symbol;
    kRemoveListener: symbol;
};
export declare const internalOptions: {
    getOptionValue: (name: string) => unknown;
    getEmbedderOptions: () => {
        shouldNotRegisterESMLoader: boolean;
        noGlobalSearchPaths: boolean;
        noBrowserGlobals: boolean;
    };
};
/** `internal/perf/observe`: nothing observes `net` in the engine. */
export declare const internalPerfObserve: {
    hasObserver: () => boolean;
    startPerf: () => void;
    stopPerf: () => void;
};
/** `internal/assert`: Node's internal assertion, which no program should ever see. */
export declare function internalAssert(value: unknown, message?: string): asserts value;
export declare namespace internalAssert {
    var fail: (message?: string) => never;
    var ok: typeof internalAssert;
}
/** `internal/v8/startup_snapshot`: the engine never builds one. */
export declare const internalStartupSnapshot: {
    namespace: {
        isBuildingSnapshot: () => boolean;
        addSerializeCallback: () => void;
        addDeserializeCallback: () => void;
        setDeserializeMainFunction: () => void;
    };
    runDeserializeCallbacks: () => void;
};
/**
 * `internal/process/permission`: the engine runs no permission model, so
 * nothing is denied and there are no flags for `child_process.js` to copy
 * into a child's `NODE_OPTIONS`.
 */
export declare const internalPermission: {
    isEnabled: () => boolean;
    has: () => boolean;
    availableFlags: () => string[];
};
//# sourceMappingURL=runtime.d.ts.map