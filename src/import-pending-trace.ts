// Run 78 delivered an action's body/end while its guest loop kept turning.
// Observe the loader's existing awaits, without adding promise observers.
const wallNow = Date.now.bind(Date);
const elapsedNow = performance.now.bind(performance);
const log = console.log.bind(console);
const stringify = JSON.stringify.bind(JSON);
const traceKey = Symbol.for('@volter/tabnode/import-pending-trace');
const traces = new WeakMap<object, ImportPendingTrace>();

type Stage = 'module load' | 'module body' | 'async resolve hook' | 'async load hook';
interface PendingImport {
  id: number;
  kind: 'dynamic-import' | 'async-module';
  specifier: string;
  referrer: string | undefined;
  started: number;
  startedAt: number;
  stage: Stage;
  module?: object;
  waitsOn?: object;
}

export class ImportPendingTrace {
  private readonly operations = new Map<number, PendingImport>();
  private readonly promises = new WeakMap<object, number>();
  private readonly bodyWaits = new WeakMap<object, object>();
  private nextId = 0;
  constructor(private readonly pid: number) {}

  start(kind: PendingImport['kind'], specifier: string, referrer?: string, module?: object): number | undefined {
    try {
      const entry: PendingImport = { id: ++this.nextId, kind, specifier, referrer,
        started: elapsedNow(), startedAt: wallNow(), stage: kind === 'async-module' ? 'module body' : 'module load', module };
      this.operations.set(entry.id, entry);
      this.trace(`${kind}-start`, { id: entry.id, specifier, referrer: referrer ?? null, started: entry.startedAt });
      return entry.id;
    } catch { return undefined; }
  }

  waiting(id: number | undefined, stage: Stage, promise?: object): void {
    try {
      const entry = id === undefined ? undefined : this.operations.get(id);
      if (entry) { entry.stage = stage; entry.waitsOn = promise; }
    } catch { /* The original await remains the loader's. */ }
  }

  modulePromise(id: number | undefined, promise: Promise<unknown>): void {
    try { if (id !== undefined) this.promises.set(promise, id); } catch { /* Retain the existing body promise. */ }
  }

  bodyWaiting(module: object, value: unknown): void {
    try {
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) this.bodyWaits.set(module, value);
      else this.bodyWaits.delete(module);
    } catch { /* Do not change the module body's continuation. */ }
  }

  settled(id: number | undefined, outcome: 'fulfilled' | 'rejected'): void {
    try {
      const entry = id === undefined ? undefined : this.operations.get(id);
      if (!entry) return;
      this.operations.delete(entry.id);
      this.trace(`${entry.kind}-settled`, { id: entry.id, specifier: entry.specifier,
        referrer: entry.referrer ?? null, outcome, ms: elapsedNow() - entry.started });
    } catch { /* Retain the original module answer or rejection. */ }
  }

  snapshot(): Record<string, unknown>[] {
    try {
      const now = elapsedNow();
      return [...this.operations.values()].filter(entry => now - entry.started > 2000).map(entry => {
        const awaited = entry.waitsOn ?? (entry.module ? this.bodyWaits.get(entry.module) : undefined);
        const relatedId = awaited ? this.promises.get(awaited) : undefined;
        const related = relatedId === undefined ? undefined : this.operations.get(relatedId);
        return { kind: entry.kind, id: entry.id, specifier: entry.specifier, referrer: entry.referrer ?? null,
          started: entry.startedAt, age: now - entry.started,
          awaiting: related ? { kind: entry.kind === 'async-module' ? 'nested import' : entry.stage,
            id: related.id, specifier: related.specifier, stage: related.stage }
            : { kind: entry.stage } };
      });
    } catch { return []; }
  }

  private trace(event: string, detail: Record<string, unknown>): void {
    try { log('[boot-trace]', stringify({ event, at: wallNow(), pid: this.pid, ...detail })); }
    catch { /* Logging has no authority over the module operation. */ }
  }
}

/** The substrate's existing guest timer reads this process's snapshot. */
export function importPendingTrace(process: object & { pid: number }): ImportPendingTrace {
  let trace = traces.get(process);
  if (!trace) {
    trace = new ImportPendingTrace(process.pid);
    traces.set(process, trace);
    const installed = trace;
    try { Object.defineProperty(process, traceKey, { value: { snapshot: () => installed.snapshot() }, configurable: true }); }
    catch { /* A process that refuses diagnostics keeps its own shape. */ }
  }
  return trace;
}
