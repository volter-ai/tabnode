import { hostRealtimeMilliseconds } from './host-time';

const NativeDate = Date;
/** A Node process owns Date and its mutable statics; none of them change the embedding realm's clock. */
export function guestDate(now: () => number = hostRealtimeMilliseconds): DateConstructor {
  const ProcessDate = function Date(this: unknown, ...args: unknown[]): unknown {
    if (new.target === undefined) return new NativeDate(now()).toString();
    return Reflect.construct(NativeDate, args.length ? args : [now()], new.target);
  };
  // Date.prototype is itself an invalid Date, with Object.prototype above it. Copy its descriptors onto
  // another invalid Date so guest prototype changes cannot reach the embedding realm's Date.prototype.
  const prototype = new NativeDate(NaN);
  Object.setPrototypeOf(prototype, Object.getPrototypeOf(NativeDate.prototype));
  Object.defineProperties(prototype, Object.getOwnPropertyDescriptors(NativeDate.prototype));
  Object.defineProperty(prototype, 'constructor', { value: ProcessDate, writable: true, configurable: true });
  Object.defineProperty(ProcessDate, 'prototype', { value: prototype, writable: false });
  Object.defineProperties(ProcessDate, {
    length: { value: NativeDate.length, configurable: true },
    now: { value: now, writable: true, configurable: true },
    parse: { value: NativeDate.parse, writable: true, configurable: true },
    UTC: { value: NativeDate.UTC, writable: true, configurable: true },
    [Symbol.hasInstance]: { value: (value: unknown) => value instanceof NativeDate, configurable: true },
  });
  return ProcessDate as unknown as DateConstructor;
}
