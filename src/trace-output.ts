import { traceValueReplacer } from './trace-values';
/** Host evidence seam only: guest console and Node semantics are unchanged. */
export function traceOutput(prefix: string, payload: unknown, level: 'log' | 'info' | 'warn' = 'log'): void {
  const sink = Reflect.get(globalThis, Symbol.for('tabnode.trace-output')) as ((prefix: string, payload: unknown, level: string) => void) | undefined;
  if (sink) sink(prefix, payload, level);
  else console[level](`${prefix} ${JSON.stringify(payload, traceValueReplacer)}`);
}
/** Keep expensive diagnostics in their producing realm until its owner captures
 * them after HTTP (or before that realm's terminal evidence handoff). The host
 * never transports the callback or its source inputs across a trace port. */
export function deferredTraceOutput(prefix: string, payload: () => unknown, level: 'log' | 'info' | 'warn' = 'log'): void {
  const sink = Reflect.get(globalThis, Symbol.for('tabnode.trace-output-deferred')) as ((prefix: string, payload: () => unknown, level: string) => void) | undefined;
  if (sink) sink(prefix, payload, level);
  else traceOutput(prefix, payload(), level);
}
