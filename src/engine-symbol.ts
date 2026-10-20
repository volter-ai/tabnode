/**
 * `Symbol.for` as the realm had it when the engine loaded, before any guest ran. A guest may replace `Symbol.for`
 * for a while: miniflare's getFreshSourceMapSupport swaps it for a function that asserts it is only asked
 * "source-map-support/sharedData" while it requires that package again. The engine's own lookups made during that
 * require (the module loader's trace sinks, a run's tree) reached the guest's function, and wrangler died on the
 * assertion (browser-substrate ADR-0213, card t_d4b07ea8). The registry is the realm's either way: this asks the same
 * one, through the function the guest cannot replace.
 */
export const engineSymbolFor: (key: string) => symbol = Symbol.for.bind(Symbol);
