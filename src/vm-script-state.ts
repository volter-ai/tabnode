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
    const declared: string[] = [];
    let failed = false;
    // No top-level declaration can exist without its keyword as a word at
    // bracket depth 0 (mayDeclareAtTop). This only rules out discovery work;
    // real eval still parses every script and decides syntax/completion.
    // Possible declarations keep the same parser.
    const parsed = !cacheable || mayDeclareAtTop(source);
    if (parsed) try {
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
      for (const node of ast.body) {
        if (node.type === 'FunctionDeclaration' && node.id) declared.push(node.id.name);
        if (node.type === 'VariableDeclaration' && node.kind === 'var') {
          for (const declaration of node.declarations) if (declaration.id.type === 'Identifier') declared.push(declaration.id.name);
        }
      }
    } catch { failed = true; /* The actual evaluator still decides syntax/errors. */ }
    const prepared: PreparedScript = { declared,
      own: new Set(['__substrateScope', '__substrateCode', '__substrateDeclared', ...declared]) };
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
/**
 * Whether a top-level statement of the script can begin with `var` or
 * `function`: the only statements the parser's walk above collects. Next's
 * server evaluates one client-reference manifest per app route at start
 * (Dub: 715 routes before its first page), each an object literal whose
 * module paths contain the text (packages/ui/src/rich-text-area/variables.tsx,
 * packages/utils/src/functions/), so the substring test sent every manifest
 * through acorn. This reads the text once,
 * outside strings and comments, counting bracket depth; a `var` or `function`
 * word at depth 0 answers yes. Whatever it cannot read without a parser (a
 * template, a regular expression or a division, an escape outside a string,
 * an unterminated string or comment, unbalanced brackets) also answers yes,
 * and acorn decides as before. A word is ASCII only: a non-ASCII character
 * ends one, so `var` after any Unicode space is still seen; a non-ASCII
 * identifier character can only add a false yes.
 */
export function mayDeclareAtTop(source: string): boolean {
  if (!source.includes('var') && !source.includes('function') && !source.includes('\\')) return false;
  let depth = 0;
  for (let i = 0, n = source.length; i < n;) {
    const c = source.charCodeAt(i);
    if (c === 0x22 /* " */ || c === 0x27 /* ' */) {
      for (i++; ; i++) {
        if (i >= n) return true;
        const d = source.charCodeAt(i);
        if (d === c) break;
        if (d === 0x5c /* \\ */) i++;
        else if (d === 0x0a || d === 0x0d) return true;
      }
      i++;
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
    if (c === 0x7b || c === 0x28 || c === 0x5b) { depth++; i++; continue; }
    if (c === 0x7d || c === 0x29 || c === 0x5d) {
      if (--depth < 0) return true;
      i++;
      continue;
    }
    if (isWordChar(c)) {
      const start = i;
      for (i++; i < n && isWordChar(source.charCodeAt(i)); i++);
      if (depth === 0) {
        const length = i - start;
        if (length === 3 ? source.startsWith('var', start) : length === 8 && source.startsWith('function', start)) return true;
      }
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
