/**
 * perf_hooks shim - Performance measurement APIs
 * Wraps browser Performance API
 */
export declare const performance: Performance;
export declare class PerformanceObserver {
    private callback;
    private entryTypes;
    constructor(callback: (list: PerformanceObserverEntryList) => void);
    observe(options: {
        entryTypes?: string[];
        type?: string;
    }): void;
    disconnect(): void;
    takeRecords(): PerformanceEntry[];
    static supportedEntryTypes: string[];
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
export declare class Histogram {
    min: number;
    max: number;
    mean: number;
    stddev: number;
    percentiles: Map<number, number>;
    exceeds: number;
    reset(): void;
    percentile(percentile: number): number;
}
export declare function createHistogram(): Histogram;
export declare function monitorEventLoopDelay(options?: {
    resolution?: number;
}): Histogram;
declare const _default: {
    performance: Performance;
    PerformanceObserver: typeof PerformanceObserver;
    createHistogram: typeof createHistogram;
    monitorEventLoopDelay: typeof monitorEventLoopDelay;
};
export default _default;
//# sourceMappingURL=perf_hooks.d.ts.map