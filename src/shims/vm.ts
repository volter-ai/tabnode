/**
 * vm shim - Basic VM functionality using eval
 *
 * `vm.runInNewContext(code, sandbox)` runs the code with the sandbox as its
 * global: what the code writes on `globalThis` lands on the sandbox. This passed the sandbox's
 * keys as parameters, so `globalThis.x = ...` wrote to the real global and the
 * caller read nothing back. Next's server evaluates each client-reference
 * manifest exactly that way and read an empty object. A name the sandbox lacks
 * is V8's own global where it is one, else undefined (`contextHolds`).
 */

import { prepareVmScript, vmScriptPhase, vmScriptRun } from '../vm-script-state';
import { isLanguageGlobal } from '../guest-scope';

/**
 * What a fresh context's global holds besides its sandbox: V8's own globals (ECMAScript's, `WebAssembly`, `console`),
 * which the engine answers with the realm's (ADR-0015 §3). Node's names and the realm's others are no context's: a
 * fresh context in Node has no `Buffer`, no `setTimeout` and no `window`, and `typeof` of each is "undefined".
 */
const contextHolds = (name: string | symbol): boolean =>
  typeof name === 'string' && (isLanguageGlobal(name) || name === 'Promise' || name === 'WebAssembly' || name === 'console');
const realmValue = (name: string | symbol): unknown =>
  contextHolds(name) ? (globalThis as unknown as Record<string | symbol, unknown>)[name] : undefined;

// One host evaluator per realm. Each call still has its own activation,
// direct eval and sandbox scope; no guest code or globals are closed over.
// A guest function can reach its caller. Freeze the reused helper and its
// prototype so that reach cannot store properties for another sandbox run.
const evaluateSandbox = Object.freeze(new Function('__substrateScope', '__substrateCode', '__substrateDeclared', 'with (__substrateScope) { const __substrateResult = eval(__substrateCode); for (const name of __substrateDeclared) { try { __substrateScope[name] = eval(name); } catch {} } return __substrateResult; }'));
Object.freeze(evaluateSandbox.prototype);
const copyDeclarations = Function.prototype.call.bind(Array.prototype.slice) as (names: readonly string[]) => string[];
const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty) as (target: object, name: PropertyKey) => boolean;

export class Script {
  private code: string;

  constructor(code: string, _options?: object) {
    this.code = code;
  }

  runInThisContext(_options?: object): unknown {
    return eval(this.code);
  }

  runInNewContext(contextObject?: object, _options?: object): unknown {
    const source = this.code;
    vmScriptRun(this, 'context', source);
    // A script's top-level `var` and function declarations are properties of
    // its context's global, as they are of Node's; they are read off the
    // script and copied onto the sandbox once it has run.
    const prepared = vmScriptPhase(this, 'parse', () => prepareVmScript(this, source));
    const { declared } = prepared;
    const { scope, declaredForRun } = vmScriptPhase(this, 'setup', () => {
      const sandbox: Record<string | symbol, unknown> = contextObject && typeof contextObject === 'object' ? contextObject as Record<string | symbol, unknown> : {};
      // A `var` over a property the context's global already has declares
      // nothing in Node: the script reads and writes that property. Such a
      // name stays the sandbox's for this run (resolved through it, not
      // copied back over it); a function declaration still replaces it. The
      // cached preparation is per source, so the exclusion is this run's
      // alone. The evaluator's original parameter is script-visible by its
      // helper name: it gets a fresh array, never the cached metadata.
      const kept = (name: string): boolean => hasOwn(sandbox, name) && !prepared.functions.has(name);
      let own = prepared.own, declaredForRun: string[];
      if (declared.some(kept)) {
        declaredForRun = declared.filter(name => !kept(name));
        own = new Set([...prepared.own].filter(name => !declared.includes(name) || !kept(name)));
      } else declaredForRun = copyDeclarations(declared);
      // The context's global as the script sees it through `globalThis`: the
      // sandbox's own properties answer `in`, a read of a name it lacks is
      // V8's own global of that name or undefined, a write lands on the sandbox.
      const globalView: Record<string | symbol, unknown> = new Proxy(sandbox, {
        has: (target, name) => name in target,
        get: (target, name) => {
          if (name === 'globalThis' || name === 'global' || name === 'self') return name in target ? target[name] : globalView;
          return name in target ? target[name] : realmValue(name);
        },
        set: (target, name, value) => { target[name] = value; return true; },
        deleteProperty: (target, name) => { delete target[name]; return true; },
      });
      // The scope every bare name resolves through: the sandbox first, V8's
      // own globals after, any other name undefined (Node: a ReferenceError,
      // which a `with` object cannot give without breaking `typeof`), and the
      // evaluator's own names and the script's declarations left to the
      // function that holds them.
      const scope = new Proxy(sandbox, {
        has: (_target, name) => !own.has(name as string),
        get: (target, name) => {
          if (name === Symbol.unscopables) return void 0;
          if (name === 'globalThis' || name === 'global' || name === 'self') return name in target ? target[name] : globalView;
          if (name in target) return target[name];
          return realmValue(name);
        },
        set: (target, name, value) => { target[name] = value; return true; },
        deleteProperty: (target, name) => { delete target[name]; return true; },
      });
      return { scope, declaredForRun };
    });
    return vmScriptPhase(this, 'eval', () => evaluateSandbox(scope, source, declaredForRun));
  }

  runInContext(_context: object, _options?: object): unknown {
    return this.runInNewContext(_context, _options);
  }

  createCachedData(): Buffer {
    return Buffer.from('');
  }
}

export function createContext(contextObject?: object, _options?: object): object {
  return contextObject || {};
}

export function isContext(_sandbox: object): boolean {
  return true;
}

export function runInThisContext(code: string, _options?: object): unknown {
  return eval(code);
}

export function runInNewContext(code: string, contextObject?: object, _options?: object): unknown {
  const script = new Script(code);
  return script.runInNewContext(contextObject);
}

export function runInContext(code: string, context: object, _options?: object): unknown {
  return runInNewContext(code, context);
}

export function compileFunction(code: string, params?: string[], _options?: object): Function {
  return new Function(...(params || []), code);
}

export class Module {
  constructor(_code: string, _options?: object) {}
  link(_linker: unknown): Promise<void> { return Promise.resolve(); }
  evaluate(_options?: object): Promise<unknown> { return Promise.resolve(); }
  get status(): string { return 'unlinked'; }
  get identifier(): string { return ''; }
  get context(): object { return {}; }
  get namespace(): object { return {}; }
}

export class SourceTextModule extends Module {}
export class SyntheticModule extends Module {
  setExport(_name: string, _value: unknown): void {}
}

export default {
  Script,
  createContext,
  isContext,
  runInThisContext,
  runInNewContext,
  runInContext,
  compileFunction,
  Module,
  SourceTextModule,
  SyntheticModule,
};
