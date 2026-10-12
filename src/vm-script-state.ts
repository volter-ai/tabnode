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

/** Options are opaque identities: no getter, serialization or extra coercion. */
class OptionBuckets<T> {
  private readonly objects = new WeakMap<object, T>();
  private readonly primitives = new Map<unknown, T>();
  constructor(private readonly create: () => T) {}
  get(option: unknown): T {
    const object = option !== null && (typeof option === 'object' || typeof option === 'function');
    const cache = object ? this.objects : this.primitives;
    let value = cache.get(option as object);
    if (!value) { value = this.create(); cache.set(option as object, value); }
    return value;
  }
}

/** One cache per owning process; module-local default callers stay in this realm.
 * Weak values retire a source key after its last Script releases preparation.
 * A cache hit never retains a Script, scope, sandbox, result or caller options.
 */
export class VmScriptPreparationCache {
  private readonly options = new OptionBuckets(() => new OptionBuckets<SourceBucket>(() => new Map()));
  private readonly retired = new FinalizationRegistry<{ bucket: SourceBucket; source: string; reference: WeakRef<PreparedScript> }>(held => {
    if (held.bucket.get(held.source) === held.reference) held.bucket.delete(held.source);
  });
  prepare(source: string, constructorOptions: unknown, runOptions: unknown): { prepared: PreparedScript; hit: boolean; failed: boolean; parsed: boolean } {
    const cacheable = typeof source === 'string';
    const bucket = cacheable ? this.options.get(constructorOptions).get(runOptions) : undefined;
    const kept = bucket?.get(source)?.deref();
    if (kept) return { prepared: kept, hit: true, failed: false, parsed: false };
    const declared: string[] = [];
    let failed = false;
    // No declaration can exist without its keyword text or an escape. This
    // only rules out discovery work; real eval still parses every script and
    // decides syntax/completion. Possible declarations keep the same parser.
    const parsed = !cacheable || source.includes('var') || source.includes('function') || source.includes('\\');
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
      this.retired.register(prepared, { bucket, source, reference });
    }
    return { prepared, hit: false, failed, parsed };
  }
}

const realmCache = new VmScriptPreparationCache();
interface Environment { cache: VmScriptPreparationCache; observer?: VmScriptObserver }
const environments = new WeakMap<object, Environment>();
const preparations = new WeakMap<object, { source: string; constructorOptions: unknown; runOptions: unknown;
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
export function prepareVmScript(script: object, source: string, constructorOptions: unknown, runOptions: unknown): PreparedScript {
  const environment = environments.get(script), observer = environment?.observer;
  const prior = preparations.get(script);
  if (typeof source === 'string' && prior && prior.source === source && prior.constructorOptions === constructorOptions
    && prior.runOptions === runOptions && prior.environment === environment) {
    observer?.preparation(true, false, false);
    return prior.prepared;
  }
  const result = (environment?.cache ?? realmCache).prepare(source, constructorOptions, runOptions);
  if (typeof source === 'string') preparations.set(script, { source, constructorOptions, runOptions, environment, prepared: result.prepared });
  observer?.preparation(result.hit, result.failed, result.parsed);
  return result.prepared;
}
