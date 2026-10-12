/**
 * vm shim - Basic VM functionality using eval
 *
 * `vm.runInNewContext(code, sandbox)` runs the code with the sandbox as its
 * global: what the code writes on `globalThis` lands on the sandbox, and a name
 * the sandbox lacks reads from the host's global. This passed the sandbox's
 * keys as parameters, so `globalThis.x = ...` wrote to the real global and the
 * caller read nothing back. Next's server evaluates each client-reference
 * manifest exactly that way and read an empty object.
 */

import { prepareVmScript, vmScriptPhase, vmScriptRun } from '../vm-script-state';

// One host evaluator per realm. Each call still has its own activation,
// direct eval and sandbox scope; no guest code or globals are closed over.
// A guest function can reach its caller. Freeze the reused helper and its
// prototype so that reach cannot store properties for another sandbox run.
const evaluateSandbox = Object.freeze(new Function('__substrateScope', '__substrateCode', '__substrateDeclared', 'with (__substrateScope) { const __substrateResult = eval(__substrateCode); for (const name of __substrateDeclared) { try { __substrateScope[name] = eval(name); } catch {} } return __substrateResult; }'));
Object.freeze(evaluateSandbox.prototype);
const copyDeclarations = Function.prototype.call.bind(Array.prototype.slice) as (names: readonly string[]) => string[];

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
    const { declared, own } = vmScriptPhase(this, 'parse', () => prepareVmScript(this, source));
    const { scope, declaredForRun } = vmScriptPhase(this, 'setup', () => {
      // The evaluator's original parameter is script-visible by its helper
      // name. Give it a fresh array, never the cached declaration metadata.
      const declaredForRun = copyDeclarations(declared);
      const sandbox: Record<string | symbol, unknown> = contextObject && typeof contextObject === 'object' ? contextObject as Record<string | symbol, unknown> : {};
      // The context's global as the script sees it through `globalThis`: the
      // sandbox's own properties answer `in`, a read of a name it lacks
      // falls back to the host's, a write lands on the sandbox.
      const globalView: Record<string | symbol, unknown> = new Proxy(sandbox, {
        has: (target, name) => name in target,
        get: (target, name) => {
          if (name === 'globalThis' || name === 'global' || name === 'self') return name in target ? target[name] : globalView;
          return name in target ? target[name] : (globalThis as unknown as Record<string | symbol, unknown>)[name];
        },
        set: (target, name, value) => { target[name] = value; return true; },
        deleteProperty: (target, name) => { delete target[name]; return true; },
      });
      // The scope every bare name resolves through: the sandbox first, the
      // host's global after, and the evaluator's own names and the script's
      // declarations left to the function that holds them.
      const scope = new Proxy(sandbox, {
        has: (_target, name) => !own.has(name as string),
        get: (target, name) => {
          if (name === Symbol.unscopables) return void 0;
          if (name === 'globalThis' || name === 'global' || name === 'self') return name in target ? target[name] : globalView;
          if (name in target) return target[name];
          return (globalThis as unknown as Record<string | symbol, unknown>)[name];
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
