/** Native OS reads belong to the Process captured by its NodeLibScope, never guest pid/env fields. */
const readers = new WeakMap<object, () => string>();
export function recordProcessHostname(process: object, read: () => string): void { readers.set(process, read); }
export function processHostnameOf(process: object): string { return readers.get(process)?.() ?? "localhost"; }
