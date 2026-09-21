/**
 * The realm belongs to whoever owns the process.
 *
 * The engine corrects globals so that a guest behaves like Node: a timer that
 * answers `unref`, a `Request` that keeps the headers it was built with, a
 * `Proxy` `util.types.isProxy` can recognise, an AsyncLocalStorage store
 * carried into every continuation. In a tab those corrections are right,
 * because the realm exists to run guests and there is nobody else in it.
 *
 * Imported into a Node process the engine is a library, and the realm is the
 * host's: its `setTimeout` is the one its own code scheduled on, its
 * `Promise.prototype.then` is the one its own promises resolve through, and a
 * channel the engine opened is a handle its loop counts. `node --test` over a
 * file that only imported the engine never exited, because a module-scope
 * `BroadcastChannel` held the loop open; the substrate's gate ran it with
 * `--test-force-exit`.
 *
 * So the rule is: importing the engine changes nothing and opens nothing.
 * A realm correction is registered here at load and installed by a `Runtime`
 * — the act of asking for a guest — and every property it takes is
 * remembered, so `restoreHostGlobals()` gives the realm back exactly as it
 * was found.
 */
/**
 * A correction a guest needs from the realm. It runs when a runtime exists,
 * not when this module is loaded, and it must be idempotent: a later runtime
 * runs it again. Registering after a runtime is already up installs at once,
 * since the guest is already there.
 */
export declare function forGuestRealm(install: () => void): void;
/**
 * Replace a property of the realm for a guest, remembering what the host had
 * under it. A name the host did not have is deleted on restore; one it had is
 * put back with its own descriptor, flags and all.
 */
export declare function takeFromHost(target: object, key: PropertyKey, value: unknown): void;
/**
 * Define a property of the realm for a guest with a descriptor of its own — a
 * getter, or a flag the value form cannot carry — remembering the host's.
 */
export declare function defineOnHost(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void;
/**
 * Install every registered correction. Called by each `Runtime`, because a
 * realm a guest has been running in may have lost one — a guest that assigns
 * to its own `globalThis` assigns to the realm — and every correction is
 * written to notice its own work and do nothing the second time. Nothing here
 * runs when this module is merely loaded.
 */
export declare function installGuestRealm(): void;
/** Whether the realm currently carries the engine's corrections. */
export declare function guestRealmInstalled(): boolean;
/**
 * Give the realm back. Every property the engine took returns to what the
 * host had, newest first. A host that created a runtime inside its own
 * process and is done with it gets its own globals back; a runtime created
 * afterwards installs them again.
 */
export declare function restoreHostGlobals(): void;
export declare function heldWork(): {
    count: number;
};
//# sourceMappingURL=host-globals.d.ts.map