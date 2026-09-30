/** Opt-in native completion diagnostics; never records guest bytes or argv. */
import { __runFor, type ProcessToken } from './process-tokens';
import { __ownedHandleCount } from './node-lib/binding/handles';

// Bounded per realm, including realms that run several shell commands. This
// observes the normal loop; it creates no request, timer or ref of its own.
let remaining = 4096;
export function completionTraceEnabled(owner: ProcessToken | null): boolean {
  if (remaining === 0 || owner === null) return false;
  const debug = __runFor(owner)?.process.env.NODE_DEBUG;
  return typeof debug === 'string' && /(?:^|[\s,])tabnode-completion(?:$|[\s,])/i.test(debug);
}

export function traceCompletion(owner: ProcessToken | null, event: string,
  fields: Record<string, number | boolean | null> = {}): void {
  if (!completionTraceEnabled(owner)) return;
  remaining -= 1;
  // A broken diagnostic sink must not turn a child result into another result.
  try {
    console.log('[node-completion]', JSON.stringify({ event, at: Date.now(), owner,
      handles: __ownedHandleCount(owner!), ...fields }));
  } catch { /* observation has no authority over completion */ }
}
