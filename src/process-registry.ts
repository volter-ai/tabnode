/** Native process identity shared by the container's worker realms. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  /** What the process was started as, where its starter said: `/proc/<pid>/cmdline`. */
  readonly argv?: readonly string[];
  /** The directory it was started in: `/proc/<pid>/cwd`. */
  readonly cwd?: string;
  /** When it started, in milliseconds since the epoch. */
  readonly startedAt?: number;
}

/** The parts of an identity a starter may add, checked before they are kept. */
function describedIdentity(identity: ProcessIdentity): ProcessIdentity {
  const { pid, ppid, argv, cwd, startedAt } = identity;
  const described: { pid: number; ppid: number; argv?: readonly string[]; cwd?: string; startedAt?: number } = { pid, ppid };
  if (Array.isArray(argv) && argv.length <= 4096 && argv.every(arg => typeof arg === 'string')) described.argv = Object.freeze([...argv]);
  if (typeof cwd === 'string' && cwd.startsWith('/')) described.cwd = cwd;
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) described.startedAt = startedAt;
  return Object.freeze(described);
}

/** A run already admitted by the container owner into this realm's scope. */
export interface InitialProcessRegistration {
  readonly token: string;
  readonly identity: ProcessIdentity;
}

/** Installed by the trusted embedding host before this realm starts runs. */
export interface ProcessRegistry {
  allocate(): number;
  publish(token: string, identity: ProcessIdentity): void;
  forget(token: string): void;
  lookup(pid: number): ProcessIdentity | undefined;
  /**
   * `kill(pid, signal)` for a live process of another realm in this container:
   * whether a process there took the signal. A machine lets a process signal
   * any process of its user, including one its parent left behind.
   */
  signal(pid: number, signal: string): boolean;
}

export interface ProcessRegistryScope extends ProcessRegistry {
  /** Trusted owner only: how this realm answers a signal sent to one of its processes. */
  receiveSignals(handler: (pid: number, signal: string) => boolean): void;
  /** Trusted owner handoff before the destination worker starts; not a guest operation. */
  adoptRun(source: ProcessRegistryScope, sourceToken: string, token: string, parentPid?: number): ProcessIdentity;
  /** Ends this realm's registrations, including after abrupt worker death. */
  dispose(): void;
}

/**
 * One container owns the counter and live table. Each realm receives a scope,
 * so identical local run tokens cannot overwrite or release another realm's
 * process. Allocation alone does not announce a live process.
 */
export function createProcessRegistryOwner(): { createScope(): ProcessRegistryScope; table(): ProcessIdentity[] } {
  let nextPid = 1000 + Math.floor(Math.random() * 30000);
  const live = new Map<number, ProcessIdentity>();
  // Which realm's scope answers for each live pid, including after handoff.
  const receivers = new Map<number, { handler?: (pid: number, signal: string) => boolean }>();
  const scopes = new WeakMap<ProcessRegistryScope, {
    allocated: Set<number>;
    runs: Map<string, ProcessIdentity>;
    active(): void;
  }>();
  return {
    createScope() {
      const allocated = new Set<number>();
      const runs = new Map<string, ProcessIdentity>();
      let disposed = false;
      const receiver: { handler?: (pid: number, signal: string) => boolean } = {};
      const active = (): void => {
        if (disposed) throw new Error('Process registry scope is closed.');
      };
      const scope: ProcessRegistryScope = {
        adoptRun(source, sourceToken, token, parentPid) {
          active();
          const parent = scopes.get(source);
          if (!parent) throw new Error('Process scopes belong to different container owners.');
          parent.active();
          if (allocated.size || runs.size) throw new Error('Process handoff requires an unused destination scope.');
          if (typeof sourceToken !== 'string' || typeof token !== 'string' || !token.length) throw new Error('Invalid process handoff token.');
          const identity = parent.runs.get(sourceToken);
          if (!identity || live.get(identity.pid) !== identity) throw new Error('Source scope does not own that live process.');
          if (parentPid !== undefined) {
            // The trusted holder retains its admitted parent PID. The parent
            // may already have exited; publication established this ancestry
            // while it still belonged to the source scope.
            if (!Number.isSafeInteger(parentPid) || parentPid < 1 || identity.pid === parentPid || identity.ppid !== parentPid) {
              throw new Error('Process admission does not name a child of the source realm.');
            }
          }
          // The PID stays live throughout the synchronous owner operation.
          // Old-scope disposal/forget cannot remove the child's new ownership.
          parent.runs.delete(sourceToken);
          parent.allocated.delete(identity.pid);
          allocated.add(identity.pid);
          runs.set(token, identity);
          receivers.set(identity.pid, receiver);
          return identity;
        },
        allocate() {
          active();
          if (nextPid > 0x7fffffff) throw new Error('Process identifier space exhausted.');
          const pid = nextPid++;
          allocated.add(pid);
          return pid;
        },
        publish(token, identity) {
          active();
          const previous = runs.get(token);
          if (previous?.pid === identity.pid && previous.ppid === identity.ppid) return;
          if (previous || !allocated.has(identity.pid) || live.has(identity.pid)) {
            throw new Error('Process identity is not owned by this run.');
          }
          if (!Number.isInteger(identity.ppid) || identity.ppid < 0 || identity.ppid > 0x7fffffff) {
            throw new Error('Invalid parent process identifier.');
          }
          if (identity.ppid !== 0 && !Array.from(runs.values()).some(parent => parent.pid === identity.ppid)) {
            throw new Error('Parent process is not owned by this realm.');
          }
          const entry = describedIdentity(identity);
          runs.set(token, entry);
          live.set(entry.pid, entry);
          receivers.set(entry.pid, receiver);
        },
        forget(token) {
          active();
          const entry = runs.get(token);
          if (!entry) return;
          runs.delete(token);
          live.delete(entry.pid);
          receivers.delete(entry.pid);
          allocated.delete(entry.pid);
        },
        lookup(pid) { active(); return live.get(pid); },
        signal(pid, signal) {
          active();
          if (!live.has(pid) || typeof signal !== 'string') return false;
          return receivers.get(pid)?.handler?.(pid, signal) === true;
        },
        receiveSignals(handler) {
          active();
          receiver.handler = handler;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const entry of runs.values()) { live.delete(entry.pid); receivers.delete(entry.pid); }
          receiver.handler = undefined;
          runs.clear();
          allocated.clear();
        },
      };
      scopes.set(scope, { allocated, runs, active });
      return scope;
    },
    /** Every live process of the container, in pid order: what `/proc` lists. */
    table() {
      return [...live.values()].sort((a, b) => a.pid - b.pid);
    },
  };
}
