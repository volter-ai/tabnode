/**
 * `events`, as Node's own `lib/events.js`.
 *
 * What died: the engine's `EventEmitter` was hand-written, 254 lines over a
 * `Map` of arrays. Node's own `test-events-*`: 0 of 9 passed. The gaps were
 * not exotic -- `events.once`, `events.on`, `captureRejections`, the
 * `MaxListenersExceededWarning`, `getEventListeners`, an emitter's
 * `[kCapture]`, the `error` event's special handling -- and each one was a
 * program in the tab finding it. `stream` found one from the inside: Node's
 * `readable.js` assigns `addListener = on`, so an `on` that delegated to
 * `addListener` was an infinite recursion.
 *
 * What this is: Node's `lib/events.js` v22.18.0, vendored unmodified, over
 * `internal/fixed_queue`, `internal/events/symbols` and the engine's own
 * `internal/event_target` binding. `EventEmitter`, `once`, `on`,
 * `setMaxListeners`, `addAbortListener` and the rest are Node's own code.
 *
 * The rule for this file: it binds, it does not implement.
 */
import { lazyExport } from './lazy';

/** A listener, as the engine's own shims type one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  EventEmitter: new (options?: { captureRejections?: boolean }) => EventEmitter;
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
export const EventEmitter = lazyExport<EventsModule['EventEmitter']>('events', 'EventEmitter');

/**
 * The module, which in Node IS the class: `events.js` ends with
 * `module.exports = EventEmitter` and hangs `once`, `on`, `getEventListeners`
 * and the rest off it, so `require("events") === require("events")
 * .EventEmitter` and `new (require("events"))()` is an emitter. One object
 * here too, for the same reason -- a guest that constructs the module got
 * "not a constructor" when this was a separate object standing beside it.
 */
export const eventsModule = EventEmitter as unknown as EventsModule;

export default eventsModule;
