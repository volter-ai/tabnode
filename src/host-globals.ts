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

type Undo = () => void;

const installers: Array<() => void> = [];
const undos: Undo[] = [];
let installed = false;

/**
 * A correction a guest needs from the realm. It runs when a runtime exists,
 * not when this module is loaded, and it must be idempotent: a later runtime
 * runs it again. Registering after a runtime is already up installs at once,
 * since the guest is already there.
 */
export function forGuestRealm(install: () => void): void {
  installers.push(install);
  if (installed) install();
}

/**
 * Replace a property of the realm for a guest, remembering what the host had
 * under it. A name the host did not have is deleted on restore; one it had is
 * put back with its own descriptor, flags and all.
 */
export function takeFromHost(target: object, key: PropertyKey, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  undos.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
  Object.defineProperty(target, key, {
    value,
    writable: previous ? previous.writable !== false : true,
    enumerable: previous ? previous.enumerable : false,
    configurable: true,
  });
}

/**
 * Define a property of the realm for a guest with a descriptor of its own — a
 * getter, or a flag the value form cannot carry — remembering the host's.
 */
export function defineOnHost(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  undos.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
  Object.defineProperty(target, key, descriptor);
}

/**
 * Install every registered correction. Called by each `Runtime`, because a
 * realm a guest has been running in may have lost one — a guest that assigns
 * to its own `globalThis` assigns to the realm — and every correction is
 * written to notice its own work and do nothing the second time. Nothing here
 * runs when this module is merely loaded.
 */
export function installGuestRealm(): void {
  installed = true;
  for (const install of installers) install();
}

/** Whether the realm currently carries the engine's corrections. */
export function guestRealmInstalled(): boolean {
  return installed;
}

/**
 * Give the realm back. Every property the engine took returns to what the
 * host had, newest first. A host that created a runtime inside its own
 * process and is done with it gets its own globals back; a runtime created
 * afterwards installs them again.
 */
export function restoreHostGlobals(): void {
  installed = false;
  while (undos.length) {
    const undo = undos.pop();
    try { undo!(); } catch { /* a realm that refuses the restore keeps the patch */ }
  }
}

/**
 * Work the host is doing on a guest's behalf, counted while it is in flight,
 * so the run loop waits for a build that prints nothing. The engine's parts
 * share the count through `globalThis` when more than one bundle is loaded in
 * a realm; until a guest exists the count is this module's own object, so
 * importing the engine adds no name to the host's global.
 */
const ownHeldWork = { count: 0 };

export function heldWork(): { count: number } {
  return (globalThis as { __browserRuntimeHeldWork?: { count: number } }).__browserRuntimeHeldWork ?? ownHeldWork;
}

forGuestRealm(() => {
  const realm = globalThis as { __browserRuntimeHeldWork?: { count: number } };
  if (!realm.__browserRuntimeHeldWork) takeFromHost(globalThis, '__browserRuntimeHeldWork', ownHeldWork);
});

/**
 * WebCrypto's asynchronous calls are held work, for whoever makes them.
 *
 * Node runs a key generation, a signature or a digest on its thread pool, and a request there keeps the process
 * alive until its callback. Here each is a promise of the browser's, which the end-of-program rule cannot see. Two
 * callers reach them: `node:crypto`'s asynchronous functions (src/shims/crypto.ts awaits `crypto.subtle`), and a
 * guest's own `crypto.subtle.digest(...)`, `globalThis.crypto` being the realm's `Crypto`.
 *
 * Both are counted in one place, where both pass: the methods of `SubtleCrypto.prototype`. The guest's `crypto` and
 * `crypto.subtle` stay the realm's own objects, which their methods require as receivers and which a program may
 * compare (`require('crypto').webcrypto === globalThis.crypto`); only the function a method name answers is the
 * engine's, calling the realm's on the same receiver with the same arguments and counting until its promise
 * settles. Every method the prototype has is taken, by walking it: a list here would miss the next one the
 * platform adds.
 */
const heldSubtleMethod = Symbol.for('tabnode.held-subtle-method');
forGuestRealm(() => {
  const prototype = (globalThis as { SubtleCrypto?: { prototype?: object } }).SubtleCrypto?.prototype;
  if (!prototype) return;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const original = Object.getOwnPropertyDescriptor(prototype, name)?.value as ((...args: unknown[]) => unknown) & { [heldSubtleMethod]?: true } | undefined;
    if (name === 'constructor' || typeof original !== 'function' || original[heldSubtleMethod]) continue;
    // A method, so `this` is the caller's receiver and the function has the method's own name.
    const held = { [name](this: unknown, ...args: unknown[]): unknown {
      const work = heldWork();
      work.count += 1;
      let answer: unknown;
      try { answer = Reflect.apply(original, this, args); }
      catch (error) { work.count -= 1; throw error; }
      if (!(answer instanceof Promise)) { work.count -= 1; return answer; }
      return answer.finally(() => { work.count -= 1; });
    } }[name]!;
    Object.defineProperty(held, 'length', { value: original.length, configurable: true });
    Object.defineProperty(held, heldSubtleMethod, { value: true });
    takeFromHost(prototype, name, held);
  }
});
