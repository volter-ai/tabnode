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

import { parse } from 'acorn';

export class Script {
  private code: string;

  constructor(code: string, _options?: object) {
    this.code = code;
  }

  runInThisContext(_options?: object): unknown {
    return eval(this.code);
  }

  runInNewContext(contextObject?: object, _options?: object): unknown {
    const sandbox: Record<string | symbol, unknown> = contextObject && typeof contextObject === 'object' ? contextObject as Record<string | symbol, unknown> : {};
    // A script's top-level `var` and function declarations are properties of
    // its context's global, as they are of Node's; they are read off the
    // script and copied onto the sandbox once it has run.
    const declared: string[] = [];
    try {
      const ast = parse(this.code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
      for (const node of ast.body) {
        if (node.type === 'FunctionDeclaration' && node.id) declared.push(node.id.name);
        if (node.type === 'VariableDeclaration' && node.kind === 'var') for (const d of node.declarations) if (d.id.type === 'Identifier') declared.push(d.id.name);
      }
    } catch {
      // A script the parser refuses still runs; its declarations stay its own.
    }
    // The scope answers every name but the evaluator's own and the script's declarations.
    const own = new Set(['__substrateScope', '__substrateCode', '__substrateDeclared', ...declared]);
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
    const fn = new Function('__substrateScope', '__substrateCode', '__substrateDeclared', 'with (__substrateScope) { const __substrateResult = eval(__substrateCode); for (const name of __substrateDeclared) { try { __substrateScope[name] = eval(name); } catch {} } return __substrateResult; }');
    return fn(scope, this.code, declared);
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
