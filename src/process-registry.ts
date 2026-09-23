/** Native process identity shared by the container's worker realms. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
}

/** Installed by the trusted embedding host before this realm starts runs. */
export interface ProcessRegistry {
  allocate(): number;
  publish(token: string, identity: ProcessIdentity): void;
  forget(token: string): void;
  lookup(pid: number): ProcessIdentity | undefined;
}

export interface ProcessRegistryScope extends ProcessRegistry {
  /** Ends this realm's registrations, including after abrupt worker death. */
  dispose(): void;
}

/**
 * One container owns the counter and live table. Each realm receives a scope,
 * so identical local run tokens cannot overwrite or release another realm's
 * process. Allocation alone does not announce a live process.
 */
export function createProcessRegistryOwner(): { createScope(): ProcessRegistryScope } {
  let nextPid = 1000 + Math.floor(Math.random() * 30000);
  const live = new Map<number, ProcessIdentity>();
  return {
    createScope() {
      const allocated = new Set<number>();
      const runs = new Map<string, ProcessIdentity>();
      let disposed = false;
      const active = (): void => {
        if (disposed) throw new Error('Process registry scope is closed.');
      };
      return {
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
          const entry = Object.freeze({ pid: identity.pid, ppid: identity.ppid });
          runs.set(token, entry);
          live.set(entry.pid, entry);
        },
        forget(token) {
          active();
          const entry = runs.get(token);
          if (!entry) return;
          runs.delete(token);
          live.delete(entry.pid);
          allocated.delete(entry.pid);
        },
        lookup(pid) { active(); return live.get(pid); },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const entry of runs.values()) live.delete(entry.pid);
          runs.clear();
          allocated.clear();
        },
      };
    },
  };
}
