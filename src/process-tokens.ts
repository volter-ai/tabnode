/**
 * A run the embedding host has named, and the registry the container answers
 * about it from.
 *
 * `container.run(command, { processToken })` names one run. The `node` command
 * records the guest process it creates under that name, for as long as the run
 * lasts, and forgets it when the run ends. Nothing here starts or ends a
 * program: it is the registry three doors read, and the name a server
 * registers itself under while its run is the one launching.
 *
 * The name reaches the `node` command through the shell's environment, under
 * the reserved variable below, because two runs can be in flight at once on
 * one shell and a module-level "the current run" would answer the later one
 * for both. The guest never sees the variable: the environment the `node`
 * command gives its process has it removed.
 */

import type { Process } from './shims/process';
import { AsyncLocalStorage } from './shims/async_hooks';
import { createProcessRegistryOwner, type ProcessIdentity, type ProcessRegistry, type ProcessRegistryScope, type InitialProcessRegistration } from './process-registry';

/** Whatever the embedding runtime uses to name one guest process. */
export type ProcessToken = string;

/** The environment variable a run's name travels in, from `exec` to `node`. */
export const PROCESS_TOKEN_ENV = '__TABNODE_PROCESS_TOKEN';

/** What the engine can answer about one named run. */
export interface OwnedRun {
  /** The guest whose cwd and inherited streams belong to this run. */
  process: Process;
  stdout(text: string): void;
  stderr(text: string): void;
  /** The timers the run's guest still holds, as Node's loop counts them. */
  pendingTimers(): number;
  /** Clear those timers, as ending the process clears them. */
  stopTimers(): void;
  /**
   * Report an exception nobody caught as this run's own, the way Node's
   * process reports one: the run's `uncaughtException` listeners, else its
   * stderr and exit 1. False when the run no longer answers.
   */
  reportUncaught(error: unknown): boolean;
}

const runs = new Map<ProcessToken, OwnedRun>();
const tokensByProcess = new WeakMap<Process, ProcessToken>();

/**
 * The run whose guest code is executing, as an async-local value rather than a
 * module global. A module-level "the current run" answered the LATEST run for
 * every reader, so a guest that spawned a child while another run was in
 * flight was attributed to the wrong parent. The engine's own storage carries
 * the value into timers, immediates, microtasks and `then` callbacks scheduled
 * from inside the run; a native `await` continuation is its documented limit.
 */
const executing = new AsyncLocalStorage<ProcessToken>();

/** Run `fn` as this token's guest code, so the doors below name that run. */
export function enterRun<T>(token: ProcessToken, fn: () => T): T {
  return executing.run(token, fn as (...args: unknown[]) => T);
}

/**
 * Record a named run's guest for the run's lifetime. The answer releases it;
 * releasing twice is harmless, as a run ends once.
 */
export function __recordRun(token: ProcessToken, run: OwnedRun): () => void {
  runs.set(token, run);
  tokensByProcess.set(run.process, token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (runs.get(token) === run) runs.delete(token);
    // Retain the weak association so delayed callbacks cannot turn an ended
    // process into an unowned host request. The Process itself remains weak.
  };
}

/**
 * The signal whose default action ended a run's guest, kept under the run's
 * name until the run reports its result: Node reports such a process as ended
 * by that signal, not by the exit code its default action implies.
 */
const terminations = new Map<ProcessToken, string>();
export function __recordTermination(process: Process, signal: string): void {
  const token = tokensByProcess.get(process);
  if (token !== undefined) terminations.set(token, signal);
}
export function __takeTermination(token: ProcessToken): string | undefined {
  const signal = terminations.get(token);
  terminations.delete(token);
  return signal;
}

/** Bound guest globals retain their actual process across native await turns. */
export function __tokenForProcess(process: Process): ProcessToken | null {
  return tokensByProcess.get(process) ?? null;
}

/** The run recorded under this name, while it lasts. */
export function __runFor(token: ProcessToken): OwnedRun | undefined {
  return runs.get(token);
}

/**
 * The run now launching a guest, for a handle or a server the guest opens
 * after its entry has returned, when no run is the current one any more.
 * `enterRun`'s async-local value covers the guest's own turn and everything
 * scheduled from inside it; a listen that lands after a native `await`
 * continuation is attributed here.
 */
export let __lastLaunchedToken: ProcessToken | null = null;
export function __setLastLaunchedToken(token: ProcessToken | null): void {
  __lastLaunchedToken = token;
}

/** The run a guest is being launched under, where the host named one. */
export function __currentProcessToken(): ProcessToken | null {
  return executing.getStore() ?? null;
}

/**
 * End a named run's timers. The servers it owns are released by `http`'s own
 * half, `__releaseOwnedServers`, which calls this for the timers.
 */
export function __stopOwnedProcess(token: ProcessToken): void {
  runs.get(token)?.stopTimers();
}

/**
 * Another process's `kill(pid, signal)`, delivered to a named run's guest.
 * On a machine the target's handlers run, or its default action ends it; the
 * guest's own `process.kill(process.pid, signal)` is exactly that, so the
 * signal is raised through it, as the run. False when the run is gone or the
 * signal is not one Node names.
 */
export function __signalOwnedProcess(token: ProcessToken, signal: string): boolean {
  const run = runs.get(token);
  if (!run) return false;
  const guest = run.process as unknown as { pid: number; kill(pid: number, signal: string): unknown };
  try { enterRun(token, () => guest.kill(guest.pid, signal)); }
  catch (error) {
    // A default action ends the process by `exit`, which a synchronous guest
    // frame reports by throwing; that is the signal delivered.
    if (error instanceof Error && error.message.startsWith("Process exited with code")) return true;
    return false;
  }
  return true;
}

/**
 * A process's own number.
 *
 * Node gives every process a distinct pid and `process.ppid` names its
 * parent's; a program reads both, and other programs read a program's pid out
 * of a file and ask whether it is still there. The engine gave every guest
 * `pid: 1` and `ppid: 0`, while the parent's `ChildProcess` handle carried a
 * real, distinct number minted by `process_wrap` -- so a child and its parent
 * disagreed about the child's pid, and worse, every run answered
 * `process.kill(1, 0)` with "yes, that is me".
 *
 * What that cost: openvscode-server's extension host takes a lock on its
 * workspace storage directory (`vs/workbench/api/node/extHostStoragePaths`),
 * writes `{ pid: process.pid }` into `vscode.lock`, and a later host reads
 * that file and asks `processExists(pid)` -- `try { process.kill(pid, 0);
 * return true } catch { return false }` -- before stealing a stale lock. Every
 * host wrote pid 1 and every later host asked about pid 1, which is its own,
 * so the lock read as held by a live process forever. `ExtensionStoragePaths.
 * whenReady` never resolved, every `_loadExtensionContext` awaits it, and so
 * every extension in the tab sat at "Activating..." and `vscode.git` never
 * started at all.
 */
const processRegistryOwner = createProcessRegistryOwner();
let processRegistry: ProcessRegistry = processRegistryOwner.createScope();
let registryInstalled = false;
let registryUsed = false;
const pidsOfRuns = new Map<ProcessToken, { pid: number; ppid: number }>();

/** Each child realm gets its own registration authority in this container. */
export function createProcessRegistryScope(): ProcessRegistryScope {
  if (registryInstalled) throw new Error('Only the container owner can create process registry scopes.');
  return processRegistryOwner.createScope();
}

/** Trusted container owner only: every live process of the container, from every realm. */
export function ownerProcessTable(): ProcessIdentity[] {
  if (registryInstalled) throw new Error('This realm is a process registry client, not the container owner.');
  return processRegistryOwner.table();
}

/** Trusted container owner only; worker clients cannot expose their authority. */
export function ownerProcessRegistryScope(): ProcessRegistryScope {
  if (registryInstalled) throw new Error('This realm is a process registry client, not the container owner.');
  return processRegistry as ProcessRegistryScope;
}

/** Startup-only host seam; never swap identity authorities under live runs. */
export function installProcessRegistry(registry: ProcessRegistry, initial?: InitialProcessRegistration): void {
  if (registryInstalled || registryUsed) throw new Error('Process registry must be installed once before creating processes.');
  if (initial) {
    if (typeof initial.token !== 'string' || initial.token.length === 0) throw new Error('Invalid initial process token.');
    // Validate with the owner before installing any local state. For an
    // adopted child this is an idempotent publication, not a new PID or a
    // guest claim to another realm's parent. Container construction can
    // allocate an anonymous Runtime first; that must not consume this PID.
    const identity = Object.freeze({ pid: initial.identity.pid, ppid: initial.identity.ppid });
    registry.publish(initial.token, identity);
    pidsOfRuns.set(initial.token, identity);
  }
  processRegistry = registry;
  registryInstalled = true;
}

/** The next process number this engine hands out. */
export function mintPid(): number {
  registryUsed = true;
  return processRegistry.allocate();
}

/** Record the numbers a named run was started with, for the run to read back. */
export function setRunPid(token: ProcessToken, pid: number, ppid: number, started?: { argv?: readonly string[]; cwd?: string }): void {
  registryUsed = true;
  processRegistry.publish(token, { pid, ppid, ...started, startedAt: Date.now() });
  pidsOfRuns.set(token, { pid, ppid });
}

/** The numbers a named run was started with, where one was recorded. */
export function runPid(token: ProcessToken | null | undefined): { pid: number; ppid: number } | undefined {
  return token === null || token === undefined ? undefined : pidsOfRuns.get(token);
}

/** A run that has ended is no longer a process; its number is nobody's. */
export function forgetRunPid(token: ProcessToken): void {
  processRegistry.forget(token);
  pidsOfRuns.delete(token);
}

/** The named run a pid belongs to in this realm, for a signal sent by number (the shell's `kill`). */
export function tokenOfPid(pid: number): ProcessToken | null {
  for (const [token, numbers] of pidsOfRuns) if (numbers.pid === pid) return token;
  return null;
}

/** Whether a live run carries this number, which is what `kill(pid, 0)` asks. */
export function pidIsLive(pid: number): boolean {
  return processRegistry.lookup(pid) !== undefined;
}

/** `kill(pid, signal)` to another realm's live process; whether one took it. */
export function signalPid(pid: number, signal: string): boolean {
  return processRegistry.signal(pid, signal);
}

/** The numbers a live process carries, looked up by its own pid. */
export function processByPid(pid: number): { pid: number; ppid: number } | undefined {
  return processRegistry.lookup(pid);
}
