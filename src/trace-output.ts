import { traceValueReplacer } from './trace-values';
const requestedKey = Symbol.for('tabnode.trace-requested');
const readingKey = Symbol.for('browser-substrate.trace-readings');
/** Host-selected diagnostics; retain standalone/file-host behavior unless a host supplied its selection. */
export function traceReadingRequested(): boolean {
  const selected = Reflect.get(globalThis, requestedKey);
  if (typeof selected === 'boolean') return selected;
  const asked = Reflect.get(globalThis, readingKey);
  if (typeof asked === 'boolean') return asked;
  // An older substrate installs this sink without either selection symbol.
  // Independently updated engine/substrate heads retain that host's reading.
  return typeof Reflect.get(globalThis, Symbol.for('tabnode.trace-output')) === 'function'
    || typeof location === 'undefined' || location.href.startsWith('file:');
}
const instrumentLine = /^\[(?:boot-trace|wali-boot|kernel-[^\]]+|reap-trace|load-clock|require-clock|stream-calls|first-answer|realm-reads|socket-connect|socket-waits|socket-write|k5)\](?:\s|$)/u;
/** The legacy source instruments already made a line. Give the host owner
 * that immutable string once, instead of also forwarding it as guest stdout. */
export function captureTraceConsoleLine(args: unknown[], level: 'log' | 'info' | 'warn' | 'error'): boolean {
  if (!traceReadingRequested()) return false;
  if (args.length !== 1 || typeof args[0] !== 'string' || !instrumentLine.test(args[0])) return false;
  const sink = Reflect.get(globalThis, Symbol.for('tabnode.trace-output')) as ((prefix: string, payload: unknown, level: string) => void) | undefined;
  if (!sink) return false;
  sink('', args[0], level);
  return true;
}
/** Host evidence seam only: guest console and Node semantics are unchanged. */
export function traceOutput(prefix: string, payload: unknown, level: 'log' | 'info' | 'warn' = 'log'): void {
  if (!traceReadingRequested() && level !== 'warn') return;
  const sink = Reflect.get(globalThis, Symbol.for('tabnode.trace-output')) as ((prefix: string, payload: unknown, level: string) => void) | undefined;
  if (sink) sink(prefix, payload, level);
  else console[level](`${prefix} ${JSON.stringify(payload, traceValueReplacer)}`);
}
/** Keep expensive diagnostics in their producing realm until its owner captures
 * them after HTTP (or before that realm's terminal evidence handoff). The host
 * never transports the callback or its source inputs across a trace port. */
export function deferredTraceOutput(prefix: string, payload: () => unknown, level: 'log' | 'info' | 'warn' = 'log'): void {
  if (!traceReadingRequested() && level !== 'warn') return;
  const sink = Reflect.get(globalThis, Symbol.for('tabnode.trace-output-deferred')) as ((prefix: string, payload: () => unknown, level: string) => void) | undefined;
  if (sink) sink(prefix, payload, level);
  else traceOutput(prefix, payload(), level);
}
