// Host budgets and measurements retain elapsed time even when a guest replaces its Date.
const nativeNow = Date.now.bind(Date);
const performanceNow = typeof performance === 'undefined' ? undefined : performance.now.bind(performance);
const origin = typeof performance === 'undefined' ? 0 : performance.timeOrigin;
export const hostRealtimeMilliseconds = (): number => nativeNow();
export const hostMonotonicMilliseconds = (): number => performanceNow ? origin + performanceNow() : nativeNow();
