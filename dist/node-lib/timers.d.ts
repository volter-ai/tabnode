/**
 * Node's `Timeout`, over whatever the realm's timers answer.
 *
 * Node's timers answer an object -- `ref`, `unref`, `hasRef`, `refresh`, and a
 * primitive conversion to the id -- and Node's own files rely on it:
 * `lib/_http_server.js` writes `setInterval(...).unref()` the moment a server
 * listens. A browser realm answers a number, so the object has to be built
 * here. Two readers need the same one: a guest's global timers, counted
 * against the run's loop in `src/runtime.ts`, and the `timers` module a
 * vendored file requires, in `src/node-lib/public-modules.ts`. They must agree
 * on the shape, because a timer made through one is cleared through the other.
 *
 * This file imports nothing, so both can read it.
 */
/** Node's `Timeout` over a browser's numeric id; anything else is already a handle. */
export declare function nodeTimeout(id: unknown): unknown;
/** The realm's own id inside a {@link nodeTimeout}, for the clear that takes one. */
export declare function timerHandleOf(id: unknown): unknown;
//# sourceMappingURL=timers.d.ts.map