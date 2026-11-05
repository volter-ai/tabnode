/**
 * The file descriptors a handle can be opened on.
 *
 * libuv answers `uv_guess_handle(fd)` from the kernel. A socket is the
 * process's kernel's, asked of it (ADR-0009); the engine's own descriptors are
 * the three a process is started with, the ones a spawn hands a child and the
 * pipes the engine itself opened, registered here by the run that made them;
 * the three standard ones are pipes because the engine's stdio is a stream the
 * host reads, never a terminal it owns.
 *
 * `net.js` reads it through `internal/util`'s `guessHandleType` when a program
 * builds a socket on a descriptor (`new net.Socket({ fd })`) and when a server
 * listens on one.
 */

import type { ProcessToken } from '../../process-tokens';
import { currentOwner } from './handles';
import { nativeInheritedFdType } from '../../native-stream-binding';
import { treeDescriptorsOf, type TreeDescriptors } from '../../tree-descriptors';
import { callingSockets, linux, readIntOption, type TreeSockets } from '../../host-sockets';

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
  const owner = reservedFds.get(fd);
  if (owner) { reservedFds.delete(fd); owner.release(fd); }
}

/**
 * libuv's `uv_guess_handle`: a descriptor the engine opened is what it opened; a kernel socket of the asking process
 * is told by its type and family (`SO_TYPE`, `SO_DOMAIN`): a stream of IPv4 or IPv6 is TCP, of AF_UNIX a pipe, a
 * datagram of IPv4 or IPv6 UDP.
 */
export function guessHandleTypeOfFd(fd: number): HandleType {
  const open = tableOfAskingRun()?.get(fd) ?? openFds.get(fd);
  if (open) return open.type;
  const inherited = nativeInheritedFdType(fd);
  if (inherited) return inherited;
  const sockets = callingSockets();
  const socket = sockets && kernelSocketType(sockets, fd);
  if (socket) return socket;
  if (fd === 0 || fd === 1 || fd === 2) return 'PIPE';
  return 'FILE';
}

/** uv_guess_handle of a kernel descriptor of `sockets`' process: its socket's type and family; none for no socket. */
export function kernelSocketType(sockets: TreeSockets, fd: number): HandleType | undefined {
  if (!Number.isInteger(fd) || fd < 0) return undefined;
  const type = new Uint8Array(4), domain = new Uint8Array(4);
  if (sockets.getsockopt(fd, linux.SOL_SOCKET, linux.SO_TYPE, type) < 0) return undefined;
  if (sockets.getsockopt(fd, linux.SOL_SOCKET, linux.SO_DOMAIN, domain) < 0) return 'UNKNOWN';
  const kind = readIntOption(type), family = readIntOption(domain);
  const inet = family === linux.AF_INET || family === linux.AF_INET6;
  if (kind === linux.SOCK_STREAM) return inet ? 'TCP' : family === linux.AF_UNIX ? 'PIPE' : 'UNKNOWN';
  if (kind === linux.SOCK_DGRAM && inet) return 'UDP';
  return 'UNKNOWN';
}
