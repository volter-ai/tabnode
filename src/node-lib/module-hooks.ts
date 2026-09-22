/**
 * A run's module-customization hooks: `module.registerHooks` and `module.register`.
 *
 * Node has two of these systems and so does this. The synchronous one is
 * Node's own file, `internal/modules/customization_hooks.js`, vendored and
 * instantiated once per run: it owns the chain, the context merging, the
 * `shortCircuit` rule and every validation message, and the engine's loader
 * calls it exactly where Node's `cjs/loader.js` calls it -- around the resolve
 * of a specifier and around the read of a source. The asynchronous one,
 * `module.register`, is the engine's, because Node's is a second thread: a
 * hooks worker, a `SharedArrayBuffer` and an `Atomics.wait` on the main thread
 * for every resolution. A tab has no thread to block and nothing to block it
 * for, so the registered hooks run in this realm, on this loop, and are
 * awaited rather than waited on. The chain they form is the one
 * `internal/modules/esm/hooks.js` builds -- last registered runs first, each
 * hook gets the `next` below it, the bottom is the default step, a hook that
 * returns without calling next must say `shortCircuit: true` -- transcribed
 * here because that file cannot be vendored without the thread it is about.
 *
 * WHAT THIS COSTS, named rather than hidden:
 *
 * - An asynchronous hook is consulted where the engine can await: a dynamic
 *   `import()`. The engine lowers a static `import` to a synchronous
 *   `require`, so a hook registered with `register()` is not consulted for
 *   one, where Node's is (its main thread blocks on the hooks thread). A
 *   program that needs its hook on every specifier registers it with
 *   `registerHooks`, which is synchronous and is consulted everywhere.
 * - `data` reaches `initialize` by reference and `transferList` transfers
 *   nothing, because there is no second thread to clone or transfer to. A
 *   `MessagePort` in `data` is the same port object the caller holds; its
 *   messages still cross on the loop, which is what a port is for.
 * - `initialize` is awaited before the first resolution the chain serves,
 *   which is where Node's synchronous `register()` has already blocked for it.
 */
import { loadNodeLibFor } from './load';

/** A resolve hook's answer, as `internal/modules/esm/hooks.js` validates one. */
export interface ResolveResult {
  url: string;
  format?: string;
  importAttributes?: Record<string, string>;
  shortCircuit?: boolean;
}

/** A load hook's answer. */
export interface LoadResult {
  format?: string;
  source?: string | ArrayBuffer | ArrayBufferView | null;
  shortCircuit?: boolean;
}

type ResolveContext = { parentURL?: string; importAttributes?: Record<string, string>; conditions?: string[] };
type LoadContext = { format?: string; importAttributes?: Record<string, string>; conditions?: string[] };
type NextResolve = (specifier: string, context?: ResolveContext) => Promise<ResolveResult> | ResolveResult;
type NextLoad = (url: string, context?: LoadContext) => Promise<LoadResult> | LoadResult;
type AsyncResolveHook = (specifier: string, context: ResolveContext, next: NextResolve) => Promise<ResolveResult> | ResolveResult;
type AsyncLoadHook = (url: string, context: LoadContext, next: NextLoad) => Promise<LoadResult> | LoadResult;

/** What the vendored `internal/modules/customization_hooks.js` exports. */
interface CustomizationHooks {
  resolveHooks: unknown[];
  loadHooks: unknown[];
  registerHooks(hooks: { resolve?: unknown; load?: unknown }): { deregister(): void };
  resolveWithHooks(
    specifier: string, parentURL: string | undefined, importAttributes: Record<string, string> | undefined,
    conditions: string[], defaultResolve: (specifier: string, context: ResolveContext) => ResolveResult,
  ): ResolveResult;
  loadWithHooks(
    url: string, format: string | undefined, importAttributes: Record<string, string> | undefined,
    conditions: string[], defaultLoad: (url: string, context: LoadContext) => LoadResult,
  ): LoadResult;
  convertCJSFilenameToURL(filename: string): string;
  convertURLToCJSFilename(url: string): string;
}

/** A link of an asynchronous chain, the shape `hooks.js` pushes. */
interface Link<Hook> { fn: Hook; url: string; next?: Link<Hook> }

/**
 * A hook of either chain, seen by the walk that runs one. The walk hands a
 * hook its context and the link below it and reads back an object; which
 * context and which next belong to the resolve chain or the load chain is
 * what the two typed hooks above state, and the walk is the same either way.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChainHook = (arg0: string, context: any, next: any) => unknown;

/** The conditions a `require` resolves under, as Node's `getCjsConditions()` reports them. */
const CJS_CONDITIONS = ['node', 'require', 'module-sync'];

/**
 * Node's own `import()` conditions. The engine resolves an import the way it
 * resolves a require, so this is what a hook is told, not a second resolver.
 */
const ESM_CONDITIONS = ['node', 'import'];

export class RunModuleHooks {
  /** The vendored file's own instance, this run's alone. */
  readonly sync: CustomizationHooks;
  constructor(process: object) {
    this.sync = loadNodeLibFor(process, 'internal/modules/customization_hooks') as CustomizationHooks;
  }
  #resolveChain: Link<AsyncResolveHook>[] = [];
  #loadChain: Link<AsyncLoadHook>[] = [];
  #initializing: Promise<unknown>[] = [];
  #initializeFailure: unknown;

  /**
   * Which chain has anything in it. The loader asks before it builds
   * anything: a run that registered no hook pays for none, which is the fast
   * path Node keeps in `Module._load` and `loadSource` too.
   */
  get hasSyncResolve(): boolean { return this.sync.resolveHooks.length > 0; }
  get hasSyncLoad(): boolean { return this.sync.loadHooks.length > 0; }
  get hasAsyncResolve(): boolean { return this.#resolveChain.length > 0; }
  get hasAsyncLoad(): boolean { return this.#loadChain.length > 0; }

  /**
   * `module.register(specifier[, parentURL][, options])`.
   *
   * The argument shuffle is Node's own (`internal/modules/esm/loader.js`): a
   * second argument that is an object and not a URL is the options. The hook
   * module is loaded through the engine's own loader, which is what answers a
   * `data:` URL, a `file:` URL and a bare specifier alike.
   */
  register(
    specifier: unknown,
    parentURL: unknown,
    options: { parentURL?: unknown; data?: unknown; transferList?: unknown } | undefined,
    load: (specifier: string, from: string) => unknown,
  ): void {
    if (parentURL != null && typeof parentURL === 'object' && !(parentURL instanceof URL)) {
      options = parentURL as { parentURL?: unknown; data?: unknown };
      parentURL = (options as { parentURL?: unknown }).parentURL;
    }
    const from = parentURL === undefined || parentURL === null ? 'data:' : String(parentURL);
    const url = String(specifier);
    const exports = load(url, from) as Record<string, unknown> | undefined;
    this.addLoader(url, exports, options?.data);
  }

  /**
   * `Hooks.addCustomLoader`: the three names a hook module may export, each
   * onto its chain, and `initialize` called with the data.
   */
  addLoader(url: string, exports: Record<string, unknown> | undefined, data: unknown): void {
    const initialize = exports?.initialize as ((data: unknown) => unknown) | undefined;
    const resolve = exports?.resolve as AsyncResolveHook | undefined;
    const load = exports?.load as AsyncLoadHook | undefined;
    if (typeof resolve === 'function') {
      this.#resolveChain.push({ fn: resolve, url, next: this.#resolveChain[this.#resolveChain.length - 1] });
    }
    if (typeof load === 'function') {
      this.#loadChain.push({ fn: load, url, next: this.#loadChain[this.#loadChain.length - 1] });
    }
    if (typeof initialize === 'function') {
      const settling = initialize(data);
      if (settling && typeof (settling as Promise<unknown>).then === 'function') {
        // Node's `register()` has already blocked on the hooks thread by the
        // time it returns, so an `initialize` that throws throws there. Here
        // the first resolution the chain serves waits for it instead, and a
        // rejection is kept rather than left to reach the process as an
        // unhandled rejection nothing is waiting on: every resolution from
        // then on fails with it, which is the state Node would have refused
        // to register in.
        this.#initializing.push((settling as Promise<unknown>).then(
          () => void 0,
          (error: unknown) => { this.#initializeFailure ??= error; },
        ));
      }
    }
  }

  /** Every `initialize` still settling, awaited before the chain serves anything. */
  async ready(): Promise<void> {
    while (this.#initializing.length > 0) {
      const settling = this.#initializing.slice();
      this.#initializing.length = 0;
      await Promise.all(settling);
    }
    if (this.#initializeFailure !== undefined) throw this.#initializeFailure;
  }

  /**
   * The resolve chain of `module.register`, awaited. `defaultResolve` is the
   * engine's own resolution, the bottom of the chain.
   */
  async resolve(
    specifier: string,
    parentURL: string | undefined,
    importAttributes: Record<string, string> | undefined,
    defaultResolve: (specifier: string, context: ResolveContext) => ResolveResult | Promise<ResolveResult>,
  ): Promise<ResolveResult> {
    await this.ready();
    const context: ResolveContext = { conditions: ESM_CONDITIONS, importAttributes, parentURL };
    const result = await this.#run(this.#resolveChain, 'resolve', context, specifier, defaultResolve as never);
    if (typeof (result as ResolveResult).url !== 'string') {
      throw invalidReturnProperty('a URL string', 'resolve', 'url', (result as ResolveResult).url);
    }
    return result as ResolveResult;
  }

  /** The load chain of `module.register`, awaited. */
  async load(
    url: string,
    format: string | undefined,
    importAttributes: Record<string, string> | undefined,
    defaultLoad: (url: string, context: LoadContext) => LoadResult | Promise<LoadResult>,
  ): Promise<LoadResult> {
    await this.ready();
    const context: LoadContext = { conditions: ESM_CONDITIONS, format, importAttributes };
    return await this.#run(this.#loadChain, 'load', context, url, defaultLoad as never) as LoadResult;
  }

  /**
   * `nextHookFactory`: the chain walked from the top, each hook handed the one
   * below it, the bottom the default step. A hook that returns without calling
   * the next one and without `shortCircuit: true` has broken the chain, and
   * Node says so rather than quietly honouring it.
   */
  async #run<T extends object>(
    chain: Link<ChainHook>[],
    name: 'resolve' | 'load',
    context: object,
    arg0: string,
    defaultStep: (arg0: string, context: object) => T | Promise<T>,
  ): Promise<T> {
    const meta = { chainFinished: false, shortCircuited: false, identifier: '' };
    const nextName = name === 'resolve' ? 'nextResolve' : 'nextLoad';
    const build = (current?: Link<ChainHook>): (arg0: string, ctx?: object) => Promise<T> => {
      if (!current) {
        return async (value: string, ctx?: object): Promise<T> => {
          meta.chainFinished = true;
          if (ctx && ctx !== context) Object.assign(context, ctx);
          return await defaultStep(value, context);
        };
      }
      const below = build(current.next);
      return async (value: string, ctx?: object): Promise<T> => {
        meta.identifier = `${current.url} '${name}'`;
        if (typeof value !== 'string') {
          throw invalidArgType(`${meta.identifier} hook's ${nextName}() specifier`, 'string', value);
        }
        if (ctx && ctx !== context) Object.assign(context, ctx);
        const output = await current.fn(value, context, below) as T & { shortCircuit?: boolean };
        if (typeof output !== 'object' || output === null) {
          throw invalidReturnValue('an object', `${meta.identifier} hook's ${nextName}()`, output);
        }
        if (output.shortCircuit === true) meta.shortCircuited = true;
        return output;
      };
    };
    const top = build(chain[chain.length - 1]);
    const output = await top(arg0, context);
    if (!meta.chainFinished && !meta.shortCircuited) {
      const error = new Error(
        `The ${name} hook from ${meta.identifier} did not call the next hook in its chain and did not ` +
        "explicitly signal a short circuit. If this is intentional, include `shortCircuit: true` in the hook's return.",
      );
      throw Object.assign(error, { code: 'ERR_LOADER_CHAIN_INCOMPLETE' });
    }
    return output;
  }
}

function invalidReturnProperty(expected: string, name: string, property: string, value: unknown): Error {
  const error = new TypeError(
    `Expected ${expected} to be returned for the "${property}" from the "${name}" function but got ${String(value)}.`,
  );
  return Object.assign(error, { code: 'ERR_INVALID_RETURN_PROPERTY_VALUE' });
}

function invalidReturnValue(expected: string, name: string, value: unknown): Error {
  const error = new TypeError(`Expected ${expected} to be returned from the "${name}" function but got ${String(value)}.`);
  return Object.assign(error, { code: 'ERR_INVALID_RETURN_VALUE' });
}

function invalidArgType(name: string, expected: string, value: unknown): Error {
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${String(value)}`);
  return Object.assign(error, { code: 'ERR_INVALID_ARG_TYPE' });
}

export { CJS_CONDITIONS, ESM_CONDITIONS };
export type { ResolveContext, LoadContext };
