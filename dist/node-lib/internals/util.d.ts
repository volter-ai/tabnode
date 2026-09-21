/**
 * `internal/util/types`, bound by hand -- which is also `util.types`, because
 * Node's `util.types` IS this module.
 *
 * Node's own is `internalBinding('types')`, V8 asking a value what it is from
 * the outside. The engine asks the one question a tab can ask: the value's
 * own `Object.prototype.toString` tag, which V8 fills in from the same
 * internal type and which a program cannot forge without saying so. A
 * `Symbol.toStringTag` a program sets IS such a statement, and Node's answer
 * and this one differ only for an object that has lied about itself.
 *
 * Two exceptions, each for a reason a tab cannot get around:
 *
 * A `Proxy` shows the tag of the thing it wraps, by design, so no tag can
 * find one. The engine's realm records every proxy it makes -- `runtime.ts`
 * replaces the realm's `Proxy` for a guest -- and `isProxy` answers from that
 * record. undici's `Headers` guard asks it of every init it converts, and a
 * proxy the host made before the guest's realm existed is not in the record.
 *
 * `isExternal` is always false: nothing in a tab is a native handle.
 *
 * `internal/util` itself is no longer here: it is Node's own file now, and
 * every name the vendored files used to take from a hand-bound object is
 * Node's own code, on the bindings under `../binding/`.
 */
/**
 * Every proxy a guest's realm has made. `runtime.ts` fills it, from the
 * `Proxy` it installs for a guest; this module reads it.
 */
export declare const recordedProxies: WeakSet<object>;
/** `internal/util/types`, which is `util.types`. */
export declare const internalUtilTypes: Record<string, (value: unknown) => boolean>;
//# sourceMappingURL=util.d.ts.map