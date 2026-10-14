/** Engine-owned VM preparation; never a cache of sandbox state or execution. */
import { parse } from 'acorn';

export type VmScriptPhase = 'parse' | 'setup' | 'eval';
export interface VmScriptObserver {
  phase<T>(phase: VmScriptPhase, operation: () => T): T;
  run(kind: 'context' | 'thisContext', codeUnits: number): void;
  preparation(hit: boolean, failed: boolean, parsed: boolean): void;
}
interface PreparedScript {
  readonly declared: readonly string[];
  /** Of `declared`, the names a function declaration binds: it replaces a context property, as a `var` does not. */
  readonly functions: ReadonlySet<string>;
  readonly own: ReadonlySet<string>;
}
type SourceBucket = Map<string, WeakRef<PreparedScript>>;

/** One cache per owning process; module-local default callers stay in this realm.
 * Weak values retire a source key after its last Script releases preparation.
 * A cache hit never retains a Script, scope, sandbox, result or caller options.
 * Preparation depends only on source: parser settings are constant and VM
 * options remain handled by the public shim, without being read by this cache.
 */
export class VmScriptPreparationCache {
  private readonly sources: SourceBucket = new Map();
  private readonly retired = new FinalizationRegistry<{ source: string; reference: WeakRef<PreparedScript> }>(held => {
    if (this.sources.get(held.source) === held.reference) this.sources.delete(held.source);
  });
  prepare(source: string): { prepared: PreparedScript; hit: boolean; failed: boolean; parsed: boolean } {
    const cacheable = typeof source === 'string';
    const bucket = cacheable ? this.sources : undefined;
    const kept = bucket?.get(source)?.deref();
    if (kept) return { prepared: kept, hit: true, failed: false, parsed: false };
    const declared: string[] = [], functions: string[] = [];
    let failed = false;
    // No declaration can exist without its keyword as a word outside
    // strings and comments (mayDeclare). This only rules out discovery work;
    // real eval still parses every script and decides syntax/completion.
    // Possible declarations keep the same parser.
    const parsed = !cacheable || mayDeclare(source);
    if (parsed) try {
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
      collectDeclared(ast as unknown as Walked, declared, functions);
    } catch { failed = true; /* The actual evaluator still decides syntax/errors. */ }
    const unique = [...new Set(declared)];
    const prepared: PreparedScript = { declared: unique, functions: new Set(functions),
      own: new Set(['__substrateScope', '__substrateCode', '__substrateDeclared', ...unique]) };
    if (bucket) {
      const reference = new WeakRef(prepared);
      bucket.set(source, reference);
      this.retired.register(prepared, { source, reference });
    }
    return { prepared, hit: false, failed, parsed };
  }
}

function isWordChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x24;
}
/** The ESTree shape the walk reads; acorn's nodes carry more. */
interface Walked { type: string; body?: Walked | Walked[]; id?: Walked | null; name?: string; kind?: string;
  declarations?: Walked[]; consequent?: Walked | Walked[]; alternate?: Walked | null; cases?: Walked[];
  init?: Walked | null; left?: Walked; block?: Walked; handler?: Walked | null; finalizer?: Walked | null;
  properties?: Walked[]; elements?: (Walked | null)[]; value?: Walked; argument?: Walked;
  async?: boolean; generator?: boolean; expression?: Walked; directive?: string; param?: Walked | null }
/**
 * The names a script declares in its context's global, as Node's
 * vm.runInContext leaves them on the context: every `var` bound anywhere
 * outside a function (in blocks, loop heads and catch bodies too, with
 * destructured names), every top-level function declaration, and in sloppy
 * code each plain function declared in a block (Annex B.3.3). The walk
 * descends statements only; a function or class body is its own scope.
 * A block function whose `var` would collide with a lexical declaration on
 * its way to the top (a `let`, `const` or `class` of an enclosing block,
 * loop head, switch, destructured catch parameter or the script itself) is
 * not hoisted (B.3.3's early-error test), so it is not collected: its read
 * would find the host's global of that name.
 */
function collectDeclared(program: Walked, declared: string[], functions: string[]): void {
  const statements = (program.body ?? []) as Walked[];
  let strict = false;
  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') break;
    if (statement.directive === 'use strict') strict = true;
  }
  const names = (pattern: Walked | null | undefined, into: (name: string) => void): void => {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier': into(pattern.name!); return;
      case 'ObjectPattern': for (const property of pattern.properties ?? []) names(property.type === 'RestElement' ? property.argument : property.value, into); return;
      case 'ArrayPattern': for (const element of pattern.elements ?? []) names(element, into); return;
      case 'RestElement': names(pattern.argument, into); return;
      case 'AssignmentPattern': names(pattern.left, into); return;
    }
  };
  const declare = (name: string): void => { declared.push(name); };
  const declaration = (node: Walked | null | undefined): void => {
    if (node?.type === 'VariableDeclaration' && node.kind === 'var') for (const one of node.declarations ?? []) names(one.id, declare);
  };
  // The lexical names in scope below `outer` once these statements' own let/const/class are added.
  const lexical = (outer: ReadonlySet<string>, nodes: readonly (Walked | null | undefined)[]): ReadonlySet<string> => {
    let inner: Set<string> | undefined;
    const add = (name: string): void => { (inner ??= new Set(outer)).add(name); };
    for (const node of nodes) {
      if (node?.type === 'VariableDeclaration' && node.kind !== 'var') for (const one of node.declarations ?? []) names(one.id, add);
      else if (node?.type === 'ClassDeclaration' && node.id) add(node.id.name!);
    }
    return inner ?? outer;
  };
  const walk = (node: Walked | null | undefined, top: boolean, shadowed: ReadonlySet<string>): void => {
    if (!node) return;
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id && (top || (!strict && !node.async && !node.generator && !shadowed.has(node.id.name!)))) { declared.push(node.id.name!); functions.push(node.id.name!); }
        return;
      case 'VariableDeclaration': declaration(node); return;
      case 'BlockStatement': {
        const body = node.body as Walked[], inner = lexical(shadowed, body);
        for (const child of body) walk(child, false, inner);
        return;
      }
      case 'IfStatement': walk(node.consequent as Walked, false, shadowed); walk(node.alternate, false, shadowed); return;
      case 'ForStatement': declaration(node.init); walk(node.body as Walked, false, lexical(shadowed, [node.init])); return;
      case 'ForInStatement': case 'ForOfStatement': declaration(node.left); walk(node.body as Walked, false, lexical(shadowed, [node.left])); return;
      case 'WhileStatement': case 'DoWhileStatement': case 'LabeledStatement': case 'WithStatement': walk(node.body as Walked, false, shadowed); return;
      case 'TryStatement': {
        walk(node.block, false, shadowed);
        // A simple catch parameter may share a var's name (B.3.5); a destructured one may not.
        const parameter = node.handler?.param;
        let caught = shadowed;
        if (parameter && parameter.type !== 'Identifier') { const inner = new Set(shadowed); names(parameter, name => { inner.add(name); }); caught = inner; }
        walk(node.handler?.body as Walked | undefined, false, caught);
        walk(node.finalizer, false, shadowed);
        return;
      }
      case 'SwitchStatement': {
        const children = (node.cases ?? []).flatMap(one => one.consequent as Walked[]), inner = lexical(shadowed, children);
        for (const child of children) walk(child, false, inner);
        return;
      }
    }
  };
  const top = lexical(new Set(), statements);
  for (const statement of statements) walk(statement, true, top);
}

/**
 * Whether the script can declare a name in its context's global at all: a
 * `var` or `function` word outside strings and comments. Next's server
 * evaluates one client-reference manifest per app route at start (Dub: 715
 * routes before its first page), each an object literal whose module paths
 * contain the text (packages/ui/src/rich-text-area/variables.tsx,
 * packages/utils/src/functions/), so a substring test sent every manifest
 * through acorn. This reads the text once. Whatever it cannot read without a
 * parser (a template, a regular expression or a division, an escape outside
 * a string, an unterminated string or comment) also answers yes, and acorn
 * decides. A word is ASCII only: a non-ASCII character ends one, so `var`
 * after any Unicode space is still seen; a non-ASCII identifier character can
 * only add a false yes.
 */
export function mayDeclare(source: string): boolean {
  if (!source.includes('var') && !source.includes('function') && !source.includes('\\')) return false;
  // A string's body is skipped by the engine's own searches, not a character at a time (S2 T11: Dub's 715 manifests are
  // almost all string text; the per-character walk cost 161 ms of its server's start before this change, measured in
  // c6a11f38's warm-up profile; no reading after it yet). The string's closing quote, the next backslash, line feed and
  // carriage return are each searched for and kept until the scan passes them, so each is found at most once per
  // position and the whole text is read a bounded number of times however many escapes a string holds; -2 is "not
  // searched yet", -1 "none further".
  let nextBackslash = -2, nextLf = -2, nextCr = -2;
  for (let i = 0, n = source.length; i < n;) {
    const c = source.charCodeAt(i);
    if (c === 0x22 /* " */ || c === 0x27 /* ' */) {
      const quote = c === 0x22 ? '"' : "'";
      let close = -2;
      for (let from = i + 1; ;) {
        // Searched again only once an escape has carried the reading past it (an escaped quote), never per escape.
        if (close !== -1 && close < from) close = source.indexOf(quote, from);
        if (close < 0) return true;
        if (nextBackslash !== -1 && nextBackslash < from) nextBackslash = source.indexOf('\\', from);
        if (nextLf !== -1 && nextLf < from) nextLf = source.indexOf('\n', from);
        if (nextCr !== -1 && nextCr < from) nextCr = source.indexOf('\r', from);
        // Up to the nearer of an escape and the quote, an unescaped line break ends the string's reading: yes. An escape
        // before the quote passes the one character after it (a quote, or a line feed continuing the line; after a
        // backslash and a CR, the LF that follows is a break of its own, answered yes as the per-character loop did),
        // and the reading goes on after it (lane A's review of d2a7d3001: a break before the escape was not looked for).
        const stop = nextBackslash !== -1 && nextBackslash < close ? nextBackslash : close;
        if ((nextLf !== -1 && nextLf < stop) || (nextCr !== -1 && nextCr < stop)) return true;
        if (stop !== close) { from = nextBackslash + 2; continue; }
        i = close + 1;
        break;
      }
      continue;
    }
    if (c === 0x2f /* / */) {
      const d = source.charCodeAt(i + 1);
      if (d === 0x2f /* / */) {
        for (i += 2; i < n; i++) { const e = source.charCodeAt(i); if (e === 0x0a || e === 0x0d || e === 0x2028 || e === 0x2029) break; }
        continue;
      }
      if (d === 0x2a /* * */) {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) return true;
        i = end + 2;
        continue;
      }
      return true;
    }
    if (c === 0x60 /* ` */ || c === 0x5c /* \\ */) return true;
    if (isWordChar(c)) {
      const start = i;
      for (i++; i < n && isWordChar(source.charCodeAt(i)); i++);
      const length = i - start;
      if (length === 3 ? source.startsWith('var', start) : length === 8 && source.startsWith('function', start)) return true;
      continue;
    }
    i++;
  }
  return false;
}

const realmCache = new VmScriptPreparationCache();
interface Environment { cache: VmScriptPreparationCache; observer?: VmScriptObserver }
const environments = new WeakMap<object, Environment>();
const preparations = new WeakMap<object, { source: string;
  environment: Environment | undefined; prepared: PreparedScript }>();

/** Internal seam: the guest VM facade supplies its actual process owner. */
export function attachVmScriptEnvironment(script: object, environment: Environment): void {
  environments.set(script, environment);
}
export function vmScriptRun(script: object, kind: 'context' | 'thisContext', code: unknown): void {
  environments.get(script)?.observer?.run(kind, typeof code === 'string' ? code.length : 0);
}
export function vmScriptPhase<T>(script: object, phase: VmScriptPhase, operation: () => T): T {
  const observer = environments.get(script)?.observer;
  return observer ? observer.phase(phase, operation) : operation();
}
export function prepareVmScript(script: object, source: string): PreparedScript {
  const environment = environments.get(script), observer = environment?.observer;
  const prior = preparations.get(script);
  if (typeof source === 'string' && prior && prior.source === source && prior.environment === environment) {
    observer?.preparation(true, false, false);
    return prior.prepared;
  }
  const result = (environment?.cache ?? realmCache).prepare(source);
  if (typeof source === 'string') preparations.set(script, { source, environment, prepared: result.prepared });
  observer?.preparation(result.hit, result.failed, result.parsed);
  return result.prepared;
}
