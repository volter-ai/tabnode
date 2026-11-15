import { guestScopedText } from '../code-transforms';
import { leftToRealm } from '../guest-scope';

/**
 * A file's text as the body of a function whose outer parameters are `globalThis` and the scope objects its free
 * names resolve through (ADR-0015 §2), and whether its names were rewritten onto the read scope (`scoped`) or it runs
 * inside `with` of the global scope object because they are dynamic. Text alone: a pure function of the file and the
 * names, so the library's build makes Node's own files' bodies once (bodies.ts).
 */
export interface ScopedBody { body: string; scoped: boolean }

/**
 * `source` as the body of `function (parameters) {…}` with every free name resolved on the global it is later given:
 * the realm's own names, `globalThis`, `arguments` and the parameters are left as written, every other is rewritten
 * onto `__substrateGuestScope` and `__substrateGuestTypeof`, and a file the rewrite declines runs inside
 * `with (__substrateGuestScope)`, given the global scope object instead. Nothing a process lacks is read from the realm.
 * The function's parameter list and the names left as written are one list.
 */
export function scopedBody(parameters: readonly string[], source: string, sourceURL: string): ScopedBody {
  const bound = new Set([...parameters, 'globalThis', 'arguments']);
  const prefix = `return function (${parameters.join(', ')}) {`;
  const rewritten = guestScopedText(source, (key) => leftToRealm(key) || bound.has(key));
  const body = rewritten === undefined
    ? `with (__substrateGuestScope) { ${prefix}${source}\n} }\n//# sourceURL=${sourceURL}`
    : `${prefix}${rewritten}\n}\n//# sourceURL=${sourceURL}`;
  return { body, scoped: rewritten !== undefined };
}
