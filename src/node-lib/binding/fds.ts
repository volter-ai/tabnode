/**
 * The file descriptors a handle can be opened on.
 *
 * libuv answers `uv_guess_handle(fd)` from the kernel. The engine has no
 * kernel and no descriptors of its own beyond the three a process is started
 * with and the ones a spawn hands a child, so the table is what the engine
 * itself opened: a `Pipe` or `TCP` registered here by the run that made it,
 * and the three standard ones, which are pipes because the engine's stdio is
 * a stream the host reads, never a terminal it owns.
 *
 * `net.js` reads it through `internal/util`'s `guessHandleType` when a program
 * builds a socket on a descriptor (`new net.Socket({ fd })`) and when a server
 * listens on one.
 */

import type { ProcessToken } from '../../process-tokens';
import { currentOwner } from './handles';
import { nativeInheritedFdType } from '../../native-stream-binding';

/** What libuv answers for a descriptor. */
export type HandleType = 'TCP' | 'TTY' | 'UDP' | 'FILE' | 'PIPE' | 'UNKNOWN';

/** The descriptors the engine itself opened, and the handle each names. */
const openFds = new Map<number, { type: HandleType; handle: unknown }>();

/**
 * The descriptors one run was STARTED with, which are that run's alone.
 *
 * A child's IPC channel is fd 3 in every child, because Node writes
 * `NODE_CHANNEL_FD=3` into its environment and the child opens the number it
 * is told. Two forked children in one realm would then both open the same
 * number, so the number is read against the run that asks: the parent's
 * `spawn` records the child's end of the channel under the child's name, and
 * the child's `new Pipe(IPC).open(3)` finds its own.
 */
const runFds = new Map<ProcessToken, Map<number, { type: HandleType; handle: unknown }>>();

let nextFd = 20;

/** Files and streams occupy one descriptor namespace, as on the OS. */
export function allocateFd(): number {
  // The host can inherit any descriptor number, not just the usual IPC fd 3.
  // Files allocated locally must not shadow one owned by the native channel.
  while (nativeInheritedFdType(nextFd) !== undefined) nextFd += 1;
  return nextFd++;
}


/** Record a descriptor a run is started with, under that run's name. */
export function registerRunFd(token: ProcessToken, fd: number, type: HandleType, handle: unknown): void {
  let table = runFds.get(token);
  if (!table) { table = new Map(); runFds.set(token, table); }
  table.set(fd, { type, handle });
}

/** A run that has ended was started with nothing. */
export function releaseRunFds(token: ProcessToken): void {
  runFds.delete(token);
}

/** Trusted process admission reads copies of this run's descriptor entries. */
export function inheritedRunFds(token: ProcessToken): Array<{ fd: number; type: HandleType; handle: unknown }> {
  return Array.from(runFds.get(token) ?? [], ([fd, entry]) => ({ fd, ...entry }));
}

/** The descriptor table of the run asking, where the asking run has one. */
function tableOfAskingRun(): Map<number, { type: HandleType; handle: unknown }> | undefined {
  const token = currentOwner();
  return token === null ? undefined : runFds.get(token);
}

/** Record a handle under a descriptor of the engine's own, and answer the number. */
export function registerFd(type: HandleType, handle: unknown): number {
  const fd = allocateFd();
  openFds.set(fd, { type, handle });
  return fd;
}

/** The handle a descriptor names, for `Pipe.open(fd)` and `TCP.open(fd)`. */
export function handleForFd(fd: number): unknown {
  return tableOfAskingRun()?.get(fd)?.handle ?? openFds.get(fd)?.handle;
}

/** Give a descriptor back; a handle that closes stops answering for one. */
export function releaseFd(fd: number): void {
  openFds.delete(fd);
}

/** libuv's `uv_guess_handle`. */
export function guessHandleTypeOfFd(fd: number): HandleType {
  const open = tableOfAskingRun()?.get(fd) ?? openFds.get(fd);
  if (open) return open.type;
  const inherited = nativeInheritedFdType(fd);
  if (inherited) return inherited;
  if (fd === 0 || fd === 1 || fd === 2) return 'PIPE';
  return 'FILE';
}
