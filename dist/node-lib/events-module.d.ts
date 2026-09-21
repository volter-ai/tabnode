/** A listener, as the engine's own shims type one. */
export type EventListener = (...args: any[]) => void;
/** Node's `EventEmitter`, as every part of the engine reads one. */
export interface EventEmitter {
    addListener(event: string | symbol, listener: EventListener): this;
    on(event: string | symbol, listener: EventListener): this;
    once(event: string | symbol, listener: EventListener): this;
    removeListener(event: string | symbol, listener: EventListener): this;
    off(event: string | symbol, listener: EventListener): this;
    removeAllListeners(event?: string | symbol): this;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
    listeners(event: string | symbol): Array<EventListener>;
    rawListeners(event: string | symbol): Array<EventListener>;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    listenerCount(event: string | symbol, listener?: EventListener): number;
    prependListener(event: string | symbol, listener: EventListener): this;
    prependOnceListener(event: string | symbol, listener: EventListener): this;
    eventNames(): Array<string | symbol>;
}
/** The whole of Node's `events` module object. */
export interface EventsModule {
    EventEmitter: new (options?: {
        captureRejections?: boolean;
    }) => EventEmitter;
    EventEmitterAsyncResource: unknown;
    once(emitter: unknown, name: string | symbol, options?: unknown): Promise<unknown[]>;
    on(emitter: unknown, name: string | symbol, options?: unknown): AsyncIterableIterator<unknown[]>;
    getEventListeners(emitter: unknown, name: string | symbol): Array<EventListener>;
    getMaxListeners(emitter: unknown): number;
    setMaxListeners(n?: number, ...emitters: unknown[]): void;
    addAbortListener(signal: AbortSignal, listener: EventListener): Disposable;
    listenerCount(emitter: unknown, type: string | symbol): number;
    init: unknown;
    captureRejectionSymbol: symbol;
    errorMonitor: symbol;
    usingDomains: boolean;
    defaultMaxListeners: number;
}
/**
 * The class itself, named before the loader can build it: the engine's own
 * files construct and subclass it, and `./lazy.ts` says why a name here
 * stands for the thing rather than being it.
 */
export declare const EventEmitter: new (options?: {
    captureRejections?: boolean;
}) => EventEmitter;
/**
 * The module, which in Node IS the class: `events.js` ends with
 * `module.exports = EventEmitter` and hangs `once`, `on`, `getEventListeners`
 * and the rest off it, so `require("events") === require("events")
 * .EventEmitter` and `new (require("events"))()` is an emitter. One object
 * here too, for the same reason -- a guest that constructs the module got
 * "not a constructor" when this was a separate object standing beside it.
 */
export declare const eventsModule: EventsModule;
export default eventsModule;
//# sourceMappingURL=events-module.d.ts.map