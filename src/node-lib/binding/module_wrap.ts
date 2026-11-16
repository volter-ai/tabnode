/**
 * `internalBinding('module_wrap')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's
 * src/module_wrap.cc, its v8::Module the engine's (node-lib/v8-host.ts), for Node's own `internal/modules/esm`.
 *
 * A source text module is the engine's ES lowering of its text, compiled when it is made, its module requests, its
 * imported and exported names read off its syntax tree as V8 reads them. `link` takes the modules its requests
 * resolved to, in their order; `instantiate` instantiates the graph and checks each named import against what its
 * module exports (V8's ResolveExport, star exports included); `evaluate` evaluates the graph in V8's order, each module
 * once, after what it imports, a module that awaits at its top level and every module that waits on one asynchronously,
 * and answers a promise; `evaluateSync` the namespace of a graph that does not await. A namespace is a module namespace
 * object: null-prototyped, not extensible, `[Symbol.toStringTag]` 'Module', its names sorted, each export read live.
 * A synthetic module (a builtin's or a CommonJS module's facade) is its export names and evaluation steps.
 *
 * Where this differs from V8: an export is read through a getter where V8's namespace has a data property, and one
 * read before its declaration runs reads undefined where V8's throws (the lowering's binding is not in its temporal
 * dead zone); a cycle's modules evaluate in the depth-first order without V8's strongly connected components for
 * asynchronous ones; `throwIfPromiseRejected` knows only the promises this binding made, a page's engine giving a
 * script no promise's state.
 */
import * as acorn from 'acorn';
import { compileModule, hostImport, hostInitializeImportMeta, magicComment, setImportModuleDynamicallyCallback,
  setInitializeImportMetaObjectCallback, type CompiledModule } from '../v8-host';

/** Module::Status (V8) and ModulePhase (src/module_wrap.h). */
const kUninstantiated = 0, kInstantiating = 1, kInstantiated = 2, kEvaluating = 3, kEvaluated = 4, kErrored = 5;
const kSourcePhase = 1, kEvaluationPhase = 2;

interface ModuleRequest { readonly specifier: string; readonly attributes: object; readonly phase: number }
/** What a source text module's syntax tree says: its requests, and its imports, exports and star exports by request. */
interface ModuleShape {
  requests: ModuleRequest[];
  /** [request index, imported name] of each named import and named re-export ('*' for a namespace import). */
  imports: Array<[number, string]>;
  /** Local and indirect export names. */
  names: string[];
  /** Request indices of `export * from`. */
  stars: number[];
  topLevelAwait: boolean;
}

function attributesOf(node: { attributes?: Array<{ key: { name?: string; value?: unknown }; value: { value: unknown } }> }): object {
  const attributes: Record<string, string> = Object.create(null);
  for (const attribute of node.attributes ?? []) attributes[String(attribute.key.name ?? attribute.key.value)] = String(attribute.value.value);
  return Object.freeze(attributes);
}

const nameOf = (node: { type: string; name?: string; value?: unknown }): string => (node.type === 'Identifier' ? node.name! : String(node.value));

/** Module::GetModuleRequests and the import and export entries V8 keeps, read off the module's syntax tree. */
function shapeOf(source: string): ModuleShape {
  const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) as unknown as { body: any[] };
  const shape: ModuleShape = { requests: [], imports: [], names: [], stars: [], topLevelAwait: false };
  const index = new Map<string, number>();
  const request = (node: any, phase = kEvaluationPhase): number => {
    const specifier = String(node.source.value);
    const attributes = attributesOf(node);
    const key = `${phase}\0${specifier}\0${JSON.stringify(attributes)}`;
    let at = index.get(key);
    if (at === undefined) {
      at = shape.requests.push(Object.freeze({ __proto__: null, specifier, attributes, phase } as unknown as ModuleRequest)) - 1;
      index.set(key, at);
    }
    return at;
  };
  for (const node of tree.body) {
    if (node.type === 'ImportDeclaration') {
      const at = request(node, node.phase === 'source' ? kSourcePhase : kEvaluationPhase);
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportDefaultSpecifier') shape.imports.push([at, 'default']);
        else if (specifier.type === 'ImportSpecifier') shape.imports.push([at, nameOf(specifier.imported)]);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        const at = request(node);
        for (const specifier of node.specifiers) {
          shape.imports.push([at, nameOf(specifier.local)]);
          shape.names.push(nameOf(specifier.exported));
        }
      } else if (node.declaration) {
        const collect = (pattern: any): void => {
          if (!pattern) return;
          if (pattern.type === 'Identifier') shape.names.push(pattern.name);
          else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) collect(property.type === 'RestElement' ? property.argument : property.value);
          else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements) collect(element);
          else if (pattern.type === 'AssignmentPattern') collect(pattern.left);
          else if (pattern.type === 'RestElement') collect(pattern.argument);
        };
        if (node.declaration.type === 'VariableDeclaration') for (const declarator of node.declaration.declarations) collect(declarator.id);
        else if (node.declaration.id) shape.names.push(node.declaration.id.name);
      } else {
        for (const specifier of node.specifiers) shape.names.push(nameOf(specifier.exported));
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      shape.names.push('default');
    } else if (node.type === 'ExportAllDeclaration') {
      const at = request(node);
      if (node.exported) { shape.names.push(nameOf(node.exported)); shape.imports.push([at, '*']); }
      else shape.stars.push(at);
    }
  }
  // Whether the module awaits outside every function of its own (Module::HasTopLevelAwait).
  const stack: any[] = [...tree.body];
  while (stack.length > 0 && !shape.topLevelAwait) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) { shape.topLevelAwait = true; break; }
    if (/Function/u.test(node.type)) continue;
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) stack.push(...child); else if (child && typeof child === 'object') stack.push(child);
    }
  }
  return shape;
}

/** The promises this binding made, settled or not: what `throwIfPromiseRejected` can know. */
const settled = new WeakMap<Promise<unknown>, { rejected: boolean; reason?: unknown }>();
function tracked<T>(promise: Promise<T>): Promise<T> {
  promise.then(() => { settled.set(promise, { rejected: false }); }, (reason) => { settled.set(promise, { rejected: true, reason }); });
  return promise;
}

export function createModuleWrapBinding(symbols: Record<string, symbol>, privateSymbols: Record<string, symbol>,
  rejected: (promise: Promise<unknown>) => void): Record<string, unknown> {
  class ModuleWrap {
    url!: string;
    #synthetic: boolean;
    #status = kUninstantiated;
    #error: unknown;
    #names: string[] = [];
    #exports: Record<string, unknown> = Object.create(null);
    #steps: Function | undefined;
    #shape: ModuleShape | undefined;
    #compiled: CompiledModule | undefined;
    #linked: ModuleWrap[] | undefined;
    #namespace: object | undefined;
    #promise: Promise<unknown> | undefined;
    #async = false;
    #id: symbol | undefined;
    #source: unknown;

    constructor(url: unknown, context: unknown, source: unknown, lineOffset: unknown, columnOffset: unknown, idOrCache?: unknown) {
      if (!new.target) throw new TypeError('ModuleWrap: a construct call');
      if (typeof url !== 'string') throw new TypeError('ModuleWrap: a URL');
      if (context !== undefined) throw new Error('module_wrap: a context of vm\'s is the engine\'s vm module\'s');
      this.#synthetic = Array.isArray(source);
      if (this.#synthetic) {
        if (typeof lineOffset !== 'function') throw new TypeError('ModuleWrap: evaluation steps');
        this.#names = (source as unknown[]).map(String);
        for (const name of this.#names) this.#exports[name] = undefined;
        this.#steps = lineOffset as Function;
        // A synthetic module's fifth argument, its CommonJS module (imported_cjs_symbol).
        if (columnOffset !== null && typeof columnOffset === 'object') (this as Record<symbol, unknown>)[symbols.imported_cjs_symbol!] = columnOffset;
      } else {
        if (typeof source !== 'string') throw new TypeError('ModuleWrap: a source');
        this.#id = typeof idOrCache === 'symbol' ? idOrCache : Symbol(url);
        Object.defineProperty(this, privateSymbols.host_defined_option_symbol!, { value: this.#id });
        this.#shape = shapeOf(source);
        this.#compiled = compileModule(source, url, Number(lineOffset) | 0, Number(columnOffset) | 0);
        this.#names = [...new Set(this.#shape.names)];
        const record = this as Record<string, unknown>;
        record.hasTopLevelAwait = this.#shape.topLevelAwait;
        record.sourceURL = magicComment(source, 'sourceURL');
        record.sourceMapURL = magicComment(source, 'sourceMappingURL');
      }
      (this as Record<string, unknown>).synthetic = this.#synthetic;
      Object.defineProperty(this, 'url', { value: url, writable: true, enumerable: true, configurable: true });
    }

    getModuleRequests(): ModuleRequest[] { return this.#shape ? [...this.#shape.requests] : []; }

    link(modules: unknown): void {
      if (!Array.isArray(modules) || modules.length !== this.getModuleRequests().length) throw new TypeError('ModuleWrap.link: one module a request');
      this.#linked = modules as ModuleWrap[];
    }

    /** Every export name, star exports' included: V8's GetExportedNames, `default` never one of a star's. */
    #exportNames(seen: Set<ModuleWrap>): string[] {
      if (seen.has(this)) return [];
      seen.add(this);
      if (this.#synthetic || !this.#shape) return [...this.#names];
      const names = new Set(this.#names);
      for (const at of this.#shape.stars) {
        const dependency = this.#linked?.[at];
        if (dependency === undefined) continue;
        for (const name of dependency.#exportNames(seen)) if (name !== 'default') names.add(name);
      }
      return [...names];
    }

    instantiate(): void {
      this.#instantiate(new Set());
    }
    #instantiate(seen: Set<ModuleWrap>): void {
      if (seen.has(this) || this.#status >= kInstantiated) return;
      seen.add(this);
      if (this.#shape) {
        if (!this.#linked) throw Object.assign(new Error('module is not linked'), { code: 'ERR_VM_MODULE_LINK_FAILURE' });
        this.#status = kInstantiating;
        try {
          for (const dependency of this.#linked) dependency.#instantiate(seen);
          for (const [at, name] of this.#shape.imports) {
            if (name === '*') continue;
            const dependency = this.#linked[at]!;
            if (!dependency.#exportNames(new Set()).includes(name)) {
              throw new SyntaxError(`The requested module '${this.#shape.requests[at]!.specifier}' does not provide an export named '${name}'`);
            }
          }
        } catch (error) { this.#status = kUninstantiated; throw error; }
      }
      this.#status = kInstantiated;
    }

    /** Whether this module or one it imports awaits at its top level (Module::IsGraphAsync). */
    #graphAsync(seen: Set<ModuleWrap>): boolean {
      if (seen.has(this)) return false;
      seen.add(this);
      if (this.#shape?.topLevelAwait) return true;
      return (this.#linked ?? []).some((dependency) => dependency.#graphAsync(seen));
    }
    get hasAsyncGraph(): boolean {
      if (this.#status < kInstantiated) throw Object.assign(new Error('cannot get namespace, module has not been instantiated'), { code: 'ERR_MODULE_NOT_INSTANTIATED' });
      return this.#graphAsync(new Set());
    }

    /**
     * Module::Evaluate: what it imports first, then its body; synchronously while nothing awaits, else once what it
     * waits on has settled. Answers a promise where it went asynchronous, else undefined; a throw is the graph's.
     */
    #evaluate(): Promise<unknown> | undefined {
      if (this.#status === kErrored) throw this.#error;
      if (this.#status >= kEvaluating) return this.#async ? this.#promise : undefined;
      this.#status = kEvaluating;
      try {
        const waits: Promise<unknown>[] = [];
        for (const dependency of this.#linked ?? []) {
          const wait = dependency.#evaluate();
          if (wait) waits.push(wait);
        }
        const body = (): unknown => this.#run();
        if (waits.length === 0 && !this.#shape?.topLevelAwait) {
          body();
          this.#status = kEvaluated;
          return undefined;
        }
        // Evaluating asynchronously (V8's kEvaluatingAsync, which Module::GetStatus reports as kEvaluated): a module
        // that awaits with nothing to wait for runs its body now, up to its first await (ExecuteAsyncModule); one
        // that waits on a dependency runs once that has settled.
        this.#async = true;
        this.#status = kEvaluated;
        const failed = (error: unknown): never => { this.#status = kErrored; this.#error = error; throw error; };
        const done = (): void => {};
        this.#promise = waits.length === 0
          ? Promise.resolve(body()).then(done, failed)
          : Promise.all(waits).then(body).then(done, failed);
        return this.#promise;
      } catch (error) {
        this.#status = kErrored;
        this.#error = error;
        throw error;
      }
    }
    #run(): unknown {
      if (this.#synthetic) {
        const steps = this.#steps!;
        this.#steps = undefined;
        return steps.call(this);
      }
      const meta = Object.create(null) as object;
      hostInitializeImportMeta(this.#id, meta, this);
      const linked = this.#linked ?? [];
      const requests = this.#shape!.requests;
      const require = (specifier: string): object => {
        const at = requests.findIndex((request) => request.specifier === specifier);
        return linked[at]!.getNamespace();
      };
      return this.#compiled!.run(this.#exports, require, meta, (specifier, options) => hostImport(this.#id, this.url, specifier, options));
    }

    evaluate(_timeout?: unknown, _breakOnSigint?: unknown): Promise<unknown> {
      let answer: Promise<unknown>;
      try { answer = Promise.resolve(this.#evaluate()).then(() => undefined); }
      catch (error) { answer = Promise.reject(error); }
      return tracked(answer);
    }
    evaluateSync(): object {
      const wait = this.#evaluate();
      if (wait) throw new Error('module_wrap.evaluateSync: the graph awaits at its top level');
      return this.getNamespace();
    }

    setExport(name: unknown, value: unknown): void {
      if (!this.#synthetic) throw new TypeError('ModuleWrap.setExport: a synthetic module');
      const key = String(name);
      if (!(key in this.#exports)) throw new ReferenceError(`Export '${key}' is not defined in module`);
      this.#exports[key] = value;
    }
    setModuleSourceObject(source: unknown): void { this.#source = source; }
    getModuleSourceObject(): unknown {
      if (this.#source === undefined) throw Object.assign(new SyntaxError(`Source phase import object is not defined for module '${this.url}'`), { code: 'ERR_SOURCE_PHASE_NOT_DEFINED' });
      return this.#source;
    }

    /** The value of an export of this module, a star's resolved through the module that exports it. */
    #read(name: string): unknown {
      if (name in this.#exports) return this.#exports[name];
      for (const at of this.#shape?.stars ?? []) {
        const dependency = this.#linked?.[at];
        if (dependency && dependency.#exportNames(new Set()).includes(name)) return dependency.#read(name);
      }
      return undefined;
    }
    getNamespace(): object {
      if (this.#status < kInstantiated) throw Object.assign(new Error('cannot get namespace, module has not been instantiated'), { code: 'ERR_MODULE_NOT_INSTANTIATED' });
      return this.#namespace ??= namespaceOf(this.#exportNames(new Set()), (name) => this.#read(name));
    }
    getStatus(): number { return this.#status; }
    getError(): unknown { return this.#error; }
    createCachedData(): Uint8Array { return new Uint8Array(0); }
  }
  return {
    ModuleWrap,
    kUninstantiated, kInstantiating, kInstantiated, kEvaluating, kEvaluated, kErrored, kEvaluationPhase, kSourcePhase,
    setImportModuleDynamicallyCallback(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('setImportModuleDynamicallyCallback: a function');
      setImportModuleDynamicallyCallback(callback as Parameters<typeof setImportModuleDynamicallyCallback>[0]);
    },
    setInitializeImportMetaObjectCallback(callback: unknown): void {
      if (typeof callback !== 'function') throw new TypeError('setInitializeImportMetaObjectCallback: a function');
      setInitializeImportMetaObjectCallback(callback as Parameters<typeof setInitializeImportMetaObjectCallback>[0]);
    },
    // CreateRequiredModuleFacade: the namespace of `export * from 'original'; export { default } from 'original';
    // export const __esModule = true;` linked to the module.
    createRequiredModuleFacade(wrap: { getNamespace(): object }): object {
      const original = wrap.getNamespace() as Record<string, unknown>;
      const names = new Set(Object.keys(original));
      names.add('__esModule');
      return namespaceOf([...names], (name) => (name === '__esModule' ? true : original[name]));
    },
    // ThrowIfPromiseRejected: a rejected promise is told as handled after its rejection, and its reason thrown.
    throwIfPromiseRejected(promise: unknown): void {
      if (!(promise instanceof Promise)) return;
      const state = settled.get(promise);
      if (!state?.rejected) return;
      rejected(promise);
      throw state.reason;
    },
  };
}

/** A module namespace object of `names`, each read live through `read`. */
function namespaceOf(names: readonly string[], read: (name: string) => unknown): object {
  const namespace = Object.create(null) as object;
  for (const name of [...names].sort()) {
    Object.defineProperty(namespace, name, { enumerable: true, configurable: false, get: () => read(name) });
  }
  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' });
  return Object.preventExtensions(namespace);
}
