/**
 * Node's `overrideStackTrace`, as the realm's stack hook reads it.
 *
 * Node's files format a stack their own way by putting a function for one
 * error in `internal/errors`' `overrideStackTrace` and reading `error.stack`:
 * `assert.ok` takes its caller's call site that way. V8 hands that function
 * the call sites because Node's bootstrap registers `prepareStackTraceCallback`
 * with it, and that callback reads the map first. The engine has no such
 * registration; `Error.prepareStackTrace` is the door it has. Every process's
 * `internal/errors` writes here, and the realm's hook reads here, so the
 * override reaches V8 whichever process set it. An entry is consumed by the
 * stack it formats, as Node's is.
 */
export type StackOverride = (error: unknown, sites: unknown[]) => unknown;

export const stackOverrides = new Map<object, StackOverride>();

/** A WeakMap-shaped view of the table, which is what `internal/errors` holds. */
export const stackOverrideMap = {
  set(this: object, error: object, override: StackOverride) { stackOverrides.set(error, override); return this; },
  get: (error: object) => stackOverrides.get(error),
  has: (error: object) => stackOverrides.has(error),
  delete: (error: object) => stackOverrides.delete(error),
};
