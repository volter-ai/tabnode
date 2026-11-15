/**
 * The internals Node's `internal/modules/customization_hooks.js` names.
 *
 * Each object holds exactly the names that file destructures from it. Node's
 * real `internal/bootstrap/realm` is the builtin loader of a Node process --
 * a snapshot, a compile cache and every `lib/` file -- and what the hooks file
 * takes from it is two questions about a name: is this something a program can
 * require, and what is its canonical id. The engine answers both from the same
 * list its `module.builtinModules` reports, so a hook that reads `node:fs`
 * reads the name the guest's own `module.isBuiltin` agrees with.
 */
import * as moduleShim from '../../shims/module';

/**
 * `internal/bootstrap/realm`'s `BuiltinModule`, the two class methods the
 * hooks file calls to turn a CommonJS filename into a URL and back.
 */
export const internalBootstrapRealm = {
  BuiltinModule: {
    /**
     * Whether a normalized id (no `node:`) is a builtin a program may require.
     * Node asks this of a filename to decide whether it is `node:<id>` rather
     * than a path; a name the engine does not answer is a path or nothing.
     */
    canBeRequiredByUsers(id: string): boolean {
      return moduleShim.builtinModules.includes(id);
    },
    /**
     * The canonical id of a requirable builtin, `node:` prefix or not, and
     * undefined for anything else -- a `file:` URL, a path, a bare package
     * name. Node returns undefined rather than throwing, and the hooks file
     * tests the result rather than catching.
     */
    normalizeRequirableId(id: string): string | undefined {
      if (typeof id !== 'string') return void 0;
      return moduleShim.normalizeBuiltin(id);
    },
    /**
     * Whether `id` is a compiled builtin, which `internal/util/inspect`
     * asks of every `node:` stack frame when it colorizes an Error. Node's
     * class answers from the realm's module map; the engine answers from
     * the same list `canBeRequiredByUsers` reads, plus `internal/` files
     * inspect also greys. The method was missing, so a pipe child that
     * still had FORCE_COLOR threw `exists is not a function` while printing
     * an assertion and the test exited 1.
     */
    exists(id: string): boolean {
      if (typeof id !== 'string') return false;
      const name = id.startsWith('node:') ? id.slice(5) : id;
      return name.startsWith('internal/') || moduleShim.builtinModules.includes(name);
    },
  },
};

/**
 * `internal/encoding`: the realm's own `TextDecoder`. The hooks file decodes
 * an `ArrayBuffer` or a typed array a load hook returned into the source
 * string the loader compiles.
 */
export const internalEncoding = {
  get TextDecoder() { return (globalThis as unknown as { TextDecoder: unknown }).TextDecoder; },
  get TextEncoder() { return (globalThis as unknown as { TextEncoder: unknown }).TextEncoder; },
};
