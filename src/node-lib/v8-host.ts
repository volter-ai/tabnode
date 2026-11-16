/**
 * WHERE THE ENGINE SPEAKS FOR V8 (ADR-0018 §7). Node's C++ asks V8 to compile a CommonJS function, a script and a
 * source text module, and V8 calls Node back for a dynamic `import()` (HostImportModuleDynamically) and an
 * `import.meta` (HostInitializeImportMetaObject). A page's engine gives a script neither callback and has no source
 * text module a script can link by hand, so these are the engine's: a text is compiled by the realm's own `eval` with
 * its `import()` made a call of the host hook below (and hole 13's rewrite of its async functions), and a source text
 * module is the engine's ES lowering of it (runtime.ts `lowerModuleForV8`), linked and evaluated in V8's order by
 * `module_wrap`'s ModuleWrap (binding/module_wrap.ts). A body is prepared once a text and kept where the image keeps
 * its prepared bodies (the `node-cjs` and `node-esm` kinds, prepared-key.ts).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hashbangAsComment, lowerModuleForV8, prepareScriptForV8, PREPARED_MODULES_DIR, TOP_LEVEL_AWAIT_MARKER } from '../runtime';
import { PREPARED_MODULES_KEPT, preparedModuleKeyOf } from '../prepared-key';
import { wrapperLines } from '../stack-overrides';

const indirectEval = eval;

/** The realm's two V8 host callbacks, as `module_wrap` sets them (SetImportModuleDynamicallyCallback and the rest). */
type ImportCallback = (id: unknown, specifier: string, phase: number, attributes: object, resourceName: unknown) => unknown;
type ImportMetaCallback = (id: unknown, meta: object, wrap: object) => void;
let importModuleDynamically: ImportCallback | undefined;
let initializeImportMeta: ImportMetaCallback | undefined;
export function setImportModuleDynamicallyCallback(callback: ImportCallback): void { importModuleDynamically = callback; }
export function setInitializeImportMetaObjectCallback(callback: ImportMetaCallback): void { initializeImportMeta = callback; }

/** ModulePhase's kEvaluationPhase (src/module_wrap.h). */
const kEvaluationPhase = 2;

/**
 * ImportModuleDynamicallyWithPhase (src/module_wrap.cc): the realm's callback with the referrer's host-defined option,
 * the specifier, the phase, the import's attributes as a frozen null-prototype object, and the referrer's name; its
 * answer resolved into a promise.
 */
export function hostImport(id: unknown, resourceName: unknown, specifier: unknown, options?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const attributes: Record<string, string> = Object.create(null);
    const given = options !== null && typeof options === 'object' ? (options as { with?: unknown }).with : undefined;
    if (given !== undefined) {
      if (given === null || typeof given !== 'object') throw new TypeError("The second argument to import() must be an object with a 'with' object");
      for (const key of Object.keys(given)) {
        const value = (given as Record<string, unknown>)[key];
        if (typeof value !== 'string') throw new TypeError(`Import attribute value must be a string`);
        attributes[key] = value;
      }
    }
    if (!importModuleDynamically) throw new TypeError('import() is not supported in this realm');
    resolve(importModuleDynamically(id, `${specifier}`, kEvaluationPhase, Object.freeze(attributes), resourceName));
  });
}

/** HostInitializeImportMetaObjectCallback: the realm's callback over a module's `import.meta`. */
export function hostInitializeImportMeta(id: unknown, meta: object, wrap: object): void {
  initializeImportMeta?.(id, meta, wrap);
}

/** Where a process's prepared bodies are kept: its tree, the one its image's bodies are in. */
interface PreparedTree {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
}
let preparedTree: PreparedTree | undefined;
let keepingRefused = false;
export function setPreparedTree(tree: PreparedTree): void { preparedTree = tree; }

/** A text's body of `kind`, the one kept under its digest where there is one, else made now and kept. */
function prepared(kind: 'node-cjs' | 'node-esm', text: string, make: (text: string) => string): string {
  const tree = preparedTree;
  if (!tree) return make(text);
  const key = preparedModuleKeyOf(kind, bytesToHex(sha256(new TextEncoder().encode(text))));
  const path = `${PREPARED_MODULES_DIR}/${key}`;
  try { return tree.readFileSync(path, 'utf8'); } catch { /* none kept */ }
  const body = make(text);
  if (!keepingRefused && tree.existsSync(PREPARED_MODULES_DIR)) {
    try { tree.writeFileSync(path, body); tree.appendFileSync(`${PREPARED_MODULES_DIR}/${PREPARED_MODULES_KEPT}`, `${key}\n`); }
    catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') keepingRefused = true;
    }
  }
  return body;
}

/** A CommonJS body as the image prepares it: its `import()` V8's host hook, then hole 13's rewrite. */
export function prepareCommonJSBody(text: string): string {
  return prepareScriptForV8(hashbangAsComment(text));
}

/** A magic comment's value off a source's end (`//# sourceURL=`, `//# sourceMappingURL=`), as V8 reads it. */
export function magicComment(source: string, name: 'sourceURL' | 'sourceMappingURL'): string | undefined {
  const tail = source.slice(-4096).replace(/\s+$/u, '');
  return new RegExp(`(?:^|\\n)\\s*//[#@]\\s*${name}=\\s*(\\S+)\\s*$`, 'u').exec(tail)?.[1];
}

/** Blank lines and columns before a text, so its first line and column are V8's ScriptOrigin offsets. */
function offset(lineOffset: number, columnOffset: number): string {
  return '\n'.repeat(Math.max(0, lineOffset | 0)) + ' '.repeat(Math.max(0, columnOffset | 0));
}

/**
 * ScriptCompiler::CompileFunction at the realm's scope: `params`' function of `text`, its `import()` the host hook
 * with `id` and `resourceName`, around `extensions` (V8's context extensions, scopes around the function). The body is
 * a CommonJS body where `cjs` is set, prepared once a text.
 */
export function compileFunction(text: string, resourceName: string, params: readonly string[], id: unknown,
  options: { lineOffset?: number; columnOffset?: number; extensions?: readonly object[]; cjs?: boolean } = {}): Function {
  const body = options.cjs ? prepared('node-cjs', text, prepareCommonJSBody) : prepareScriptForV8(hashbangAsComment(text));
  const extensions = options.extensions ?? [];
  const open = extensions.map((_, index) => `with (__substrateExtensions[${index}]) {`).join('');
  const close = extensions.map(() => '}').join('');
  // The wrapper on a line of its own: the text's first line keeps its columns, its lines read back without it.
  wrapperLines.set(resourceName, 1);
  const made = indirectEval(`(function (__dynamicImport, __substrateExtensions) { ${open} return function (${params.join(', ')}) {\n`
    + `${offset(options.lineOffset ?? 0, options.columnOffset ?? 0)}${body}\n}; ${close} })\n//# sourceURL=${resourceName}`) as
    (dynamicImport: (specifier: unknown, options?: unknown) => Promise<unknown>, extensions: readonly object[]) => Function;
  return made((specifier, given) => hostImport(id, resourceName, specifier, given), extensions);
}

/** The realm's scripts' import hooks, by number: a script runs at the global scope, where no parameter can carry one. */
const scriptImports: Array<(specifier: unknown, options?: unknown) => Promise<unknown>> = [];
Object.defineProperty(globalThis, '__substrateHostImport', { value: scriptImports, configurable: true });

/** A script compiled at the realm's scope (ContextifyScript's UnboundScript), run when asked, its `this` the global. */
export function compileScript(text: string, resourceName: string, id: unknown, lineOffset = 0, columnOffset = 0): () => unknown {
  const slot = scriptImports.push((specifier, given) => hostImport(id, resourceName, specifier, given)) - 1;
  const source = `${offset(lineOffset, columnOffset)}${prepareScriptForV8(hashbangAsComment(text), `__substrateHostImport[${slot}]`)}\n//# sourceURL=${resourceName}`;
  wrapperLines.set(resourceName, 0);
  // V8 compiles the script when it is made: its syntax error is the constructor's.
  // eslint-disable-next-line no-new-func
  new Function(source);
  return () => indirectEval(source);
}

/** What a source text module compiles to: its lowered body as a function, and whether it awaits at its top level. */
export interface CompiledModule {
  run(exports: object, require: (specifier: string) => object, meta: object, dynamicImport: (specifier: unknown, options?: unknown) => Promise<unknown>): unknown;
  readonly topLevelAwait: boolean;
}
export function compileModule(text: string, url: string, lineOffset = 0, columnOffset = 0): CompiledModule {
  const body = prepared('node-esm', text, (source) => lowerModuleForV8(hashbangAsComment(source)));
  const topLevelAwait = body.endsWith(TOP_LEVEL_AWAIT_MARKER);
  wrapperLines.set(url, 1);
  const fn = indirectEval(`(${topLevelAwait ? 'async ' : ''}function ($exports, $require, $module, import_meta, __dynamicImport) {"use strict";\n`
    + `${offset(lineOffset, columnOffset)}${body}\n})\n//# sourceURL=${url}`) as Function;
  return {
    topLevelAwait,
    run: (exports, require, meta, dynamicImport) => fn.call(undefined, exports, require, {}, meta, dynamicImport),
  };
}
