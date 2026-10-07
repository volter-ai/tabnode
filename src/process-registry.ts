/** Native process identity shared by the container's worker realms. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  /** POSIX process group; optional for hosts predating group support. */
  readonly pgid?: number;
  /** What the process was started as, where its starter said: `/proc/<pid>/cmdline`. */
  readonly argv?: readonly string[];
  /** The directory it was started in: `/proc/<pid>/cwd`. */
  readonly cwd?: string;
  /** When it started, in milliseconds since the epoch. */
  readonly startedAt?: number;
}

/** The parts of an identity a starter may add, checked before they are kept. */
function describedIdentity(identity: ProcessIdentity): ProcessIdentity {
  const { pid, ppid, pgid, argv, cwd, startedAt } = identity;
  const described: ProcessIdentity = { pid, ppid, ...(pgid !== undefined ? { pgid } : {}),
    ...(Array.isArray(argv) && argv.length <= 4096 && argv.every(arg => typeof arg === 'string') ? { argv: Object.freeze([...argv]) } : {}),
    ...(typeof cwd === 'string' && cwd.startsWith('/') ? { cwd } : {}),
    ...(typeof startedAt === 'number' && Number.isFinite(startedAt) ? { startedAt } : {}) };
  return Object.freeze(described);
}

/** A run already admitted by the container owner into this realm's scope. */
export interface InitialProcessRegistration {
  readonly token: string;
  readonly identity: ProcessIdentity;
}

/** Installed by the trusted embedding host before this realm starts runs. */
export interface ProcessRegistry {
  /**
   * A new process's number. `parentPid` is the process that starts it, where the caller knows it, and `newSession`
   * says it leads a session of its own (a detached spawn): a registry over a kernel makes the process there and then,
   * as fork (and setsid) do (browser-substrate ADR-0129); tabnode's own ignores both.
   */
  allocate(parentPid?: number, newSession?: boolean): number;
  publish(token: string, identity: ProcessIdentity): void;
  /**
   * execve(2) into a process forked elsewhere: an image starts in this realm in a process whose fork already made it
   * (a kernel shell's child exec'ing `node`), keeping its pid and parent. No process is made here; a pid the registry
   * does not hold answers loudly. Every other pid this realm publishes is one its `allocate` made.
   */
  exec(token: string, identity: ProcessIdentity): void;
  /**
   * exit_group for `pid`, a child forked under `parentPid` whose image this realm ran itself (an engine run): ended
   * with `code`, or by `signal`. A child another realm or the host runs reports its own exit.
   */
  exit(pid: number, parentPid: number, code: number, signal: string | null): void;
  /**
   * wait4 for `pid`, a child forked under `parentPid`, once its run has ended: the end its parent reports (Node's
   * 'exit' code and signal). A registry over a kernel answers with the zombie's status and reaps it; tabnode's own,
   * which is its own kernel, answers with the end its run gave.
   */
  reap(pid: number, parentPid: number, code: number, signal: string | null): { code: number; signal: string | null };
  forget(token: string): void;
  lookup(pid: number): ProcessIdentity | undefined;
  /**
   * `kill(pid, signal)` for a live process of another realm in this container:
   * whether a process there took the signal. A machine lets a process signal
   * any process of its user, including one its parent left behind.
   */
  signal(pid: number, signal: string): boolean;
  /** A group may remain live after its leader exits. */
  lookupGroup?(pgid: number): boolean;
  /** Deliver to every live group member; true when any member took it. */
  signalGroup?(pgid: number, signal: string): boolean;
}

export interface ProcessRegistryScope extends ProcessRegistry {
  /** Trusted owner only: how this realm answers a signal sent to one of its processes. */
  receiveSignals(handler: (pid: number, signal: string) => boolean): void;
  /**
   * Trusted owner only: a run the embedder already numbered, as a kernel
   * numbers a `node` its shell exec'd. Its parent is the embedder's process,
   * which this registry need not hold.
   */
  claim(pid: number): void;
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
/**
 * The container's process authority: what every realm's scope is made from and what `/proc` lists. tabnode's own
 * (`createProcessRegistryOwner`) is the standalone implementation, for a library user with no kernel; an embedder
 * with a kernel installs its own (`installProcessRegistryOwner`), a view of the kernel's process table, so the
 * container has one process table (browser-substrate ADR-0129).
 */
export interface ProcessRegistryOwner {
  createScope(): ProcessRegistryScope;
  table(): ProcessIdentity[];
  /**
   * The numbers come from here from now on: a kernel's own pid counter, so
   * the container's processes and the kernel's are one pid space, and a
   * child's `process.ppid` is the parent its kernel names. A number still
   * held here is passed over. An owner that is the kernel's view has no counter of its own and may refuse.
   */
  installAllocator(allocate: () => number): void;
}

export function createProcessRegistryOwner(): ProcessRegistryOwner {
  let nextPid = 1000 + Math.floor(Math.random() * 30000);
  let allocator: (() => number) | undefined;
  // Every number a scope holds, allocated or claimed, so no two runs share one.
  const held = new Set<number>();
  const live = new Map<number, ProcessIdentity>();
  // Which realm's scope answers for each live pid, including after handoff.
  const receivers = new Map<number, { handler?: (pid: number, signal: string) => boolean }>();
  const scopes = new WeakMap<ProcessRegistryScope, {
    allocated: Set<number>;
    claimed: Set<number>;
    runs: Map<string, ProcessIdentity>;
    active(): void;
  }>();
  return {
    createScope() {
      const allocated = new Set<number>();
      // The numbers the embedder gave, whose parents are the embedder's.
      const claimed = new Set<number>();
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
          if (parent.claimed.delete(identity.pid)) claimed.add(identity.pid);
          allocated.add(identity.pid);
          runs.set(token, identity);
          receivers.set(identity.pid, receiver);
          return identity;
        },
        allocate() {
          active();
          for (;;) {
            if (!allocator && nextPid > 0x7fffffff) throw new Error('Process identifier space exhausted.');
            const pid = allocator ? allocator() : nextPid++;
            if (!Number.isSafeInteger(pid) || pid < 2 || pid > 0x7fffffff) throw new Error('Process identifier space exhausted.');
            if (held.has(pid) || live.has(pid)) continue;
            allocated.add(pid);
            held.add(pid);
            return pid;
          }
        },
        claim(pid) {
          active();
          if (!Number.isSafeInteger(pid) || pid < 2 || pid > 0x7fffffff) throw new Error('Invalid process identifier.');
          if (held.has(pid) || live.has(pid)) throw new Error('Process identifier is already held.');
          allocated.add(pid);
          claimed.add(pid);
          held.add(pid);
        },
        exec(token, identity) {
          this.claim(identity.pid);
          this.publish(token, identity);
        },
        exit() {},
        reap(_pid, _parentPid, code, signal) { return { code, signal }; },
        publish(token, identity) {
          active();
          const previous = runs.get(token);
          if (previous?.pid === identity.pid && previous.ppid === identity.ppid) {
            if (identity.pgid !== undefined && identity.pgid !== previous.pgid) throw new Error('Process group identity cannot change at publication.');
            return;
          }
          if (previous || !allocated.has(identity.pid) || live.has(identity.pid)) {
            throw new Error('Process identity is not owned by this run.');
          }
          if (!Number.isInteger(identity.ppid) || identity.ppid < 0 || identity.ppid > 0x7fffffff) {
            throw new Error('Invalid parent process identifier.');
          }
          const parent = Array.from(runs.values()).find(parent => parent.pid === identity.ppid);
          if (identity.ppid !== 0 && !parent && !claimed.has(identity.pid)) {
            throw new Error('Parent process is not owned by this realm.');
          }
          const inherited = parent?.pgid ?? parent?.pid ?? identity.pid;
          const pgid = identity.pgid ?? inherited;
          if (!Number.isInteger(pgid) || pgid < 1 || pgid > 0x7fffffff || (pgid !== identity.pid && pgid !== inherited)) {
            throw new Error('Invalid or unowned process group identifier.');
          }
          const entry = describedIdentity({ ...identity, pgid });
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
          claimed.delete(entry.pid);
          held.delete(entry.pid);
        },
        lookup(pid) { active(); return live.get(pid); },
        signal(pid, signal) {
          active();
          if (!live.has(pid) || typeof signal !== 'string') return false;
          return receivers.get(pid)?.handler?.(pid, signal) === true;
        },
        lookupGroup(pgid) {
          active();
          return Array.from(live.values()).some(identity => identity.pgid === pgid);
        },
        signalGroup(pgid, signal) {
          active();
          if (typeof signal !== 'string') return false;
          // Snapshot before delivery: a leader's handler may retire itself or
          // other members. Group membership is independent of leader liveness.
          const members = Array.from(live.values()).filter(identity => identity.pgid === pgid);
          let delivered = false;
          for (const identity of members) {
            if (live.get(identity.pid) === identity && receivers.get(identity.pid)?.handler?.(identity.pid, signal) === true) delivered = true;
          }
          return delivered;
        },
        receiveSignals(handler) {
          active();
          receiver.handler = handler;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const entry of runs.values()) { live.delete(entry.pid); receivers.delete(entry.pid); }
          for (const pid of allocated) held.delete(pid);
          receiver.handler = undefined;
          runs.clear();
          allocated.clear();
          claimed.clear();
        },
      };
      scopes.set(scope, { allocated, claimed, runs, active });
      return scope;
    },
    /** Every live process of the container, in pid order: what `/proc` lists. */
    table() {
      return [...live.values()].sort((a, b) => a.pid - b.pid);
    },
    installAllocator(allocate) {
      if (typeof allocate !== 'function') throw new TypeError('A process identifier allocator is a function.');
      allocator = allocate;
    },
  };
}
