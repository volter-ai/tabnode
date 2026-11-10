/**
 * perf_hooks: Node's `performance`, the engine's own (ADR-0017). Its clock is the system's monotonic one, counted from
 * the engine's start (`system.ts` `performance`), and its timeline of marks and measures is the process's, as Node keeps
 * it; no realm's `performance` stands behind it.
 */
import { eventLoopUtilization } from '../guest-loop';
import { performance as clock } from '../system';
export type { EventLoopUtilization } from '../guest-loop';

/** One entry of the timeline, Node's PerformanceMark and PerformanceMeasure shape. */
class TimelineEntry {
  constructor(readonly name: string, readonly entryType: 'mark' | 'measure', readonly startTime: number,
    readonly duration: number, readonly detail: unknown = null) {}
  toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration, detail: this.detail }; }
}

const timeline: TimelineEntry[] = [];
const byName = (name?: string, type?: string) => timeline.filter((entry) =>
  (name === undefined || entry.name === name) && (type === undefined || entry.entryType === type));
const remove = (type: 'mark' | 'measure', name?: string): void => {
  for (let at = timeline.length - 1; at >= 0; at--)
    if (timeline[at]!.entryType === type && (name === undefined || timeline[at]!.name === name)) timeline.splice(at, 1);
};
/** A mark's time by its name, or a time given as a number. */
const timeOf = (point: unknown, fallback: number): number => {
  if (point === undefined) return fallback;
  if (typeof point === 'number') return point;
  const found = byName(String(point), 'mark').at(-1);
  if (!found) throw new SyntaxError(`The "${String(point)}" performance mark has not been set`);
  return found.startTime;
};

export const performance = {
  now: (): number => clock.now(),
  get timeOrigin(): number { return clock.timeOrigin; },
  mark(name: string, options?: { startTime?: number; detail?: unknown }): TimelineEntry {
    const entry = new TimelineEntry(String(name), 'mark', options?.startTime ?? clock.now(), 0, options?.detail ?? null);
    timeline.push(entry);
    return entry;
  },
  measure(name: string, start?: string | number | { start?: string | number; end?: string | number; duration?: number; detail?: unknown }, end?: string | number): TimelineEntry {
    const now = clock.now();
    const options = start !== null && typeof start === 'object' ? start : undefined;
    const from = timeOf(options ? options.start : start, 0);
    const to = options?.duration !== undefined ? from + options.duration : timeOf(options ? options.end : end, now);
    const entry = new TimelineEntry(String(name), 'measure', from, to - from, options?.detail ?? null);
    timeline.push(entry);
    return entry;
  },
  getEntries: (): TimelineEntry[] => [...timeline],
  getEntriesByName: (name: string, type?: string): TimelineEntry[] => byName(String(name), type),
  getEntriesByType: (type: string): TimelineEntry[] => byName(undefined, String(type)),
  clearMarks: (name?: string): void => remove('mark', name),
  clearMeasures: (name?: string): void => remove('measure', name),
  clearResourceTimings: (): void => {},
  /** Node records a PerformanceResourceTiming for each fetch undici makes; this engine keeps no resource timeline. */
  markResourceTiming: (): undefined => undefined,
  setResourceTimingBufferSize: (): void => {},
  timerify: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
  eventLoopUtilization,
  toJSON(): { timeOrigin: number; eventLoopUtilization: ReturnType<typeof eventLoopUtilization> } {
    return { timeOrigin: clock.timeOrigin, eventLoopUtilization: eventLoopUtilization() };
  },
};

/** Node24.5.0 src/node_perf.h and V8's GCType/GCCallbackFlags enum values.
 * Constants describe kinds; they do not claim the browser emits GC entries. */
export const constants = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
});

export class PerformanceObserver {
  private callback: (list: PerformanceObserverEntryList) => void;
  private entryTypes: string[] = [];

  constructor(callback: (list: PerformanceObserverEntryList) => void) {
    this.callback = callback;
  }

  observe(options: { entryTypes?: string[]; type?: string }): void {
    this.entryTypes = options.entryTypes || (options.type ? [options.type] : []);
  }

  disconnect(): void {
    this.entryTypes = [];
  }

  takeRecords(): PerformanceEntry[] {
    return [];
  }

  static supportedEntryTypes = ['mark', 'measure', 'resource', 'navigation'];
}

export interface PerformanceObserverEntryList {
  getEntries(): PerformanceEntry[];
  getEntriesByName(name: string, type?: string): PerformanceEntry[];
  getEntriesByType(type: string): PerformanceEntry[];
}

export interface PerformanceEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

// Histogram stub
export class Histogram {
  min = 0;
  max = 0;
  mean = 0;
  stddev = 0;
  percentiles = new Map<number, number>();
  exceeds = 0;

  reset(): void {
    this.min = 0;
    this.max = 0;
    this.mean = 0;
    this.stddev = 0;
    this.percentiles.clear();
    this.exceeds = 0;
  }

  percentile(percentile: number): number {
    return this.percentiles.get(percentile) || 0;
  }
}

export function createHistogram(): Histogram {
  return new Histogram();
}

export function monitorEventLoopDelay(options?: { resolution?: number }): Histogram {
  const histogram = new Histogram();
  return histogram;
}

export default {
  performance,
  constants,
  PerformanceObserver,
  createHistogram,
  monitorEventLoopDelay,
};
