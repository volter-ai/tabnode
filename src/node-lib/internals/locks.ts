/**
 * `internal/locks`: the Web Locks manager `navigator.locks` answers with.
 *
 * Node's is a C++ binding shared by a process and its worker threads. This is one process's manager, in memory:
 * exclusive and shared locks by name, granted in the order asked, with `ifAvailable`, `steal` and an abort signal,
 * and `query()`. NOT covered: a worker thread of the process has a manager of its own here, so a lock taken on one
 * thread does not hold another off, where Node's does.
 */
type Mode = 'exclusive' | 'shared';
interface Held { name: string; mode: Mode; release(): void; stolen?: (reason: unknown) => void }
interface Waiting { name: string; mode: Mode; grant(): void; cancel(reason: unknown): void }

const domError = (message: string, name: string): Error => {
  const Ctor = (globalThis as { DOMException?: new (message: string, name: string) => Error }).DOMException;
  if (Ctor) return new Ctor(message, name);
  return Object.assign(new Error(message), { name });
};

class Lock {
  constructor(readonly name: string, readonly mode: Mode) {}
}

export class LockManager {
  #held: Held[] = [];
  #waiting: Waiting[] = [];
  #clientId = `node-${Math.random().toString(36).slice(2, 10)}`;

  #grantable(name: string, mode: Mode): boolean {
    const held = this.#held.filter((lock) => lock.name === name);
    return held.length === 0 || (mode === 'shared' && held.every((lock) => lock.mode === 'shared'));
  }

  #advance(): void {
    // In the order asked: a request waits behind an earlier one for the same name, granted or not.
    const blocked = new Set<string>();
    for (const request of [...this.#waiting]) {
      if (blocked.has(request.name) || !this.#grantable(request.name, request.mode)) { blocked.add(request.name); continue; }
      this.#waiting.splice(this.#waiting.indexOf(request), 1);
      request.grant();
      if (request.mode === 'exclusive') blocked.add(request.name);
    }
  }

  request(name: unknown, optionsOrCallback?: unknown, maybeCallback?: unknown): Promise<unknown> {
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as ((lock: Lock | null) => unknown) | undefined;
    const options = (typeof optionsOrCallback === 'function' ? {} : optionsOrCallback ?? {}) as { mode?: unknown; ifAvailable?: unknown; steal?: unknown; signal?: AbortSignal };
    if (typeof callback !== 'function') return Promise.reject(new TypeError('The "callback" argument must be of type function.'));
    const lockName = String(name);
    const mode = (options.mode ?? 'exclusive') as Mode;
    if (mode !== 'exclusive' && mode !== 'shared') return Promise.reject(new TypeError(`The provided value '${String(options.mode)}' is not a valid enum value of type LockMode.`));
    if (lockName.startsWith('-')) return Promise.reject(domError("Lock name may not start with hyphen", 'NotSupportedError'));
    if (options.steal && options.ifAvailable) return Promise.reject(domError("ifAvailable and steal are mutually exclusive", 'NotSupportedError'));
    if (options.steal && mode !== 'exclusive') return Promise.reject(domError("mode: 'shared' and steal are mutually exclusive", 'NotSupportedError'));
    if (options.signal && (options.steal || options.ifAvailable)) return Promise.reject(domError("ifAvailable and steal are mutually exclusive with signal", 'NotSupportedError'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);

    return new Promise((resolve, reject) => {
      const run = (): void => {
        let settled = false;
        const held: Held = { name: lockName, mode, release: () => {
          const at = this.#held.indexOf(held);
          if (at >= 0) this.#held.splice(at, 1);
          this.#advance();
        }, stolen: (reason) => { if (!settled) { settled = true; reject(reason); } } };
        this.#held.push(held);
        Promise.resolve().then(() => callback(new Lock(lockName, mode))).then(
          (value) => { held.release(); if (!settled) { settled = true; resolve(value); } },
          (error) => { held.release(); if (!settled) { settled = true; reject(error); } },
        );
      };
      if (options.steal) {
        for (const lock of this.#held.filter((entry) => entry.name === lockName)) {
          this.#held.splice(this.#held.indexOf(lock), 1);
          lock.stolen?.(domError("The lock was stolen by another request", 'AbortError'));
        }
        run();
        return;
      }
      if (options.ifAvailable) {
        if (this.#grantable(lockName, mode) && !this.#waiting.some((entry) => entry.name === lockName)) { run(); return; }
        Promise.resolve().then(() => callback(null)).then(resolve, reject);
        return;
      }
      const waiting: Waiting = { name: lockName, mode, grant: () => { options.signal?.removeEventListener('abort', abort); run(); },
        cancel: (reason) => { const at = this.#waiting.indexOf(waiting); if (at >= 0) { this.#waiting.splice(at, 1); reject(reason); this.#advance(); } } };
      const abort = (): void => waiting.cancel(options.signal!.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      this.#waiting.push(waiting);
      this.#advance();
    });
  }

  query(): Promise<{ held: Array<{ name: string; mode: Mode; clientId: string }>; pending: Array<{ name: string; mode: Mode; clientId: string }> }> {
    const row = (entry: { name: string; mode: Mode }) => ({ name: entry.name, mode: entry.mode, clientId: this.#clientId });
    return Promise.resolve({ held: this.#held.map(row), pending: this.#waiting.map(row) });
  }
}

const byProcess = new WeakMap<object, LockManager>();
let shared: LockManager | undefined;
/** The manager of a process; one for the realm where no process is named. */
export function locksOf(process?: object): LockManager {
  if (!process) return (shared ??= new LockManager());
  let manager = byProcess.get(process);
  if (!manager) { manager = new LockManager(); byProcess.set(process, manager); }
  return manager;
}
