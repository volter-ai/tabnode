/** Native OS reads belong to the Process captured by its NodeLibScope, never guest pid/env fields. */
const readers = new WeakMap<object, () => string>();
export function recordProcessHostname(process: object, read: () => string): void { readers.set(process, read); }
export function processHostnameOf(process: object): string { return readers.get(process)?.() ?? "localhost"; }

/**
 * A reader of the process's resolver files (`/etc/hosts`, `/etc/resolv.conf`), captured from the same filesystem as the
 * process's fs binding; no guest env/pid authority.
 */
const hostsReaders = new WeakMap<object, (path: '/etc/hosts' | '/etc/resolv.conf') => string>();
export function recordProcessHosts(process: object, read: (path: '/etc/hosts' | '/etc/resolv.conf') => string): void { hostsReaders.set(process, read); }
export function processHostsReaderOf(process: object): ((path: '/etc/hosts' | '/etc/resolv.conf') => string) | undefined { return hostsReaders.get(process); }
