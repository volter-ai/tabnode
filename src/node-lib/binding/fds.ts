/**
 * The file descriptors a handle can be opened on.
 *
 * libuv answers `uv_guess_handle(fd)` from the kernel, and where the realm's
 * process is `node` on libuv's loop the answer is libuv's (ADR-0018 §3). In a
 * realm with no libuv the engine's own descriptors are the three a process is
 * started with, the ones a spawn hands a child and the pipes the engine itself
 * opened, registered here by the run that made them; the three standard ones
 * are pipes because the engine's stdio is a stream the host reads, never a
 * terminal it owns.
 *
 * `net.js` reads it through `internal/util`'s `guessHandleType` when a program
 * builds a socket on a descriptor (`new net.Socket({ fd })`) and when a server
 * listens on one.
 */

import type { ProcessToken } from '../../process-tokens';
import { currentOwner } from './handles';
import { nativeInheritedFdType } from '../../native-stream-binding';
import { treeDescriptorsOf, type TreeDescriptors } from '../../tree-descriptors';
import { libnode, programForm } from './libnode';

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

/** Numbers a tree that owns its descriptions handed out for the engine's own handles, by owner. */
const reservedFds = new Map<number, TreeDescriptors>();

/** The descriptor owner of the run asking, where its tree owns its descriptions. */
function askingOwner(): TreeDescriptors | undefined {
  const realm = globalThis as unknown as { process?: Record<symbol, unknown> };
  return treeDescriptorsOf(realm.process?.[Symbol.for('tabnode.run.vfs')]);
}

/**
 * Files and streams occupy one descriptor namespace, as on the OS. Where the
 * run's tree owns its descriptions (`tree-descriptors.ts`), the namespace is
 * the tree's: a pipe or a socket of the engine's takes its number from the
 * owner, so it never names a file the owner opened.
 */
export function allocateFd(): number {
  const owner = askingOwner();
  if (owner) {
    const fd = owner.reserve();
    reservedFds.set(fd, owner);
    return fd;
  }
  // The host can inherit any descriptor number, not just the usual IPC fd 3.
  // Files allocated locally must not shadow one owned by the native channel.
  while (nativeInheritedFdType(nextFd) !== undefined) nextFd += 1;
  return nextFd++;
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
  const owner = reservedFds.get(fd);
  if (owner) { reservedFds.delete(fd); owner.release(fd); }
}

/** internal/util's `handleTypes`, GetUVHandleTypeCode's indices (native/node handle_wrap.c). */
export const HANDLE_TYPE_NAMES: readonly HandleType[] = ['TCP', 'TTY', 'UDP', 'FILE', 'PIPE', 'UNKNOWN'];

/**
 * libuv's `uv_guess_handle`: where the realm's process is `node` on libuv's loop, libuv's own answer of the kernel's
 * descriptor; else a descriptor the engine opened is what it opened, and the three standard ones are pipes.
 */
export function guessHandleTypeOfFd(fd: number): HandleType {
  if (programForm('a descriptor\'s handle type')) return HANDLE_TYPE_NAMES[libnode().exports.tabnode_guess_handle(Number(fd) | 0)] ?? 'UNKNOWN';
  const open = tableOfAskingRun()?.get(fd) ?? openFds.get(fd);
  if (open) return open.type;
  const inherited = nativeInheritedFdType(fd);
  if (inherited) return inherited;
  if (fd === 0 || fd === 1 || fd === 2) return 'PIPE';
  return 'FILE';
}
