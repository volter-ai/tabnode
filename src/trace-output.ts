import { traceValueReplacer } from './trace-values';
import { engineSymbolFor } from './engine-symbol';
const requestedKey = engineSymbolFor('tabnode.trace-requested');
const readingKey = engineSymbolFor('browser-substrate.trace-readings');
// Found once, not at each ask: a traced realm asks at every read and stat, and each ask resolved its names in the
// global symbol registry again (LibreChat run 4: 12 ms of the co-located host's own time, S2 AC-LC1).
const outputKey = engineSymbolFor('tabnode.trace-output');
const costsKey = engineSymbolFor('browser-substrate.trace-costs');
/** Host-selected diagnostics; retain standalone/file-host behavior unless a host supplied its selection. */
export function traceReadingRequested(): boolean {
  const selected = Reflect.get(globalThis, requestedKey);
  if (typeof selected === 'boolean') return selected;
  const asked = Reflect.get(globalThis, readingKey);
  if (typeof asked === 'boolean') return asked;
  // An older substrate installs this sink without either selection symbol.
  // Independently updated engine/substrate heads retain that host's reading.
  return typeof Reflect.get(globalThis, outputKey) === 'function'
    || typeof location === 'undefined' || location.href.startsWith('file:');
}
/**
 * Whether readings also pay their per-read costs (the substrate's `browser-substrate.trace-costs`, its
 * traceCostsRequested): the counted read of each body and the deferred UTF-8 count of its bytes. A host's timed runs set
 * it false; events and the load clock stay with readings.
 */
export function traceCostsRequested(): boolean {
  return traceReadingRequested() && Reflect.get(globalThis, costsKey) !== false;
}
const instrumentLine = /^\[(?:boot-trace|wali-boot|kernel-[^\]]+|reap-trace|load-clock|require-clock|stream-calls|first-answer|realm-reads|socket-connect|socket-waits|socket-write|k5)\](?:\s|$)/u;
/** The legacy source instruments already made a line. Give the host owner
 * that immutable string once, instead of also forwarding it as guest stdout. */
export function captureTraceConsoleLine(args: unknown[], level: 'log' | 'info' | 'warn' | 'error'): boolean {
  if (!traceReadingRequested()) return false;
  if (args.length !== 1 || typeof args[0] !== 'string' || !instrumentLine.test(args[0])) return false;
  const sink = Reflect.get(globalThis, outputKey) as ((prefix: string, payload: unknown, level: string) => void) | undefined;
  if (!sink) return false;
  sink('', args[0], level);
  return true;
}
/** Host evidence seam only: guest console and Node semantics are unchanged. */
export function traceOutput(prefix: string, payload: unknown, level: 'log' | 'info' | 'warn' = 'log'): void {
  if (!traceReadingRequested() && level !== 'warn') return;
  const sink = Reflect.get(globalThis, outputKey) as ((prefix: string, payload: unknown, level: string) => void) | undefined;
  if (sink) sink(prefix, payload, level);
  else console[level](`${prefix} ${JSON.stringify(payload, traceValueReplacer)}`);
}
/** Keep expensive diagnostics in their producing realm until its owner captures
 * them after HTTP (or before that realm's terminal evidence handoff). The host
 * never transports the callback or its source inputs across a trace port. */
export function deferredTraceOutput(prefix: string, payload: () => unknown, level: 'log' | 'info' | 'warn' = 'log', captured?: { retained: unknown; input?: object }): void {
  if (!traceReadingRequested() && level !== 'warn') return;
  const sink = Reflect.get(globalThis, engineSymbolFor('tabnode.trace-output-deferred')) as ((prefix: string, payload: () => unknown, level: string, captured?: { retained: unknown; input?: object }) => void) | undefined;
  if (sink) sink(prefix, payload, level, captured);
  else traceOutput(prefix, payload(), level);
}
/** Local diagnostic input ownership. Old hosts collect as before; no source
 * input, callback or opaque key crosses an evidence MessagePort. */
export function retainTraceInput(key: object, bytes: number, release: () => void): boolean {
  if (!traceReadingRequested()) return false;
  const sink = Reflect.get(globalThis, engineSymbolFor('tabnode.trace-retained-input')) as ((key: object, bytes: number, release: () => void) => boolean) | undefined;
  return sink ? sink(key, bytes, release) : true;
}
export function releaseTraceInput(key: object): void {
  const sink = Reflect.get(globalThis, engineSymbolFor('tabnode.trace-release-input')) as ((key: object) => void) | undefined;
  sink?.(key);
}
