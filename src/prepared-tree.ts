/**
 * WHERE A PROCESS READS PREPARED BODIES FROM (S2 R44b): a run the host gives a tree of its own (a kernel process's,
 * `RunOptions.filesystem`) reads its files at the paths its process sees, through that tree's view walk and, in a
 * container, the overlay. A prepared body is named by its content and the engine's format, never by a path a guest
 * sees, so the same body is the container's own tree's under the same name: there the read is the store's lookup
 * alone. LibreChat's server (lc-9fd3ee80-again, worker 76) spent ~160 ms of its 420 ms of prepared reads in the view
 * walk and overlay of `/opt/.tabnode/prepared/<key>`, once a body.
 *
 * WHAT THE CONTAINER'S READ DOES NOT DO. It is not checked against the process's view or its credentials: a process
 * whose user could not search `/opt/.tabnode` takes a body it would have failed to read. The body is the engine's own
 * cache, never a read a guest sees, so that is the engine's to allow. Nor is the container's tree a more trusted
 * source: a body kept in the tab is written by processes, through the store, on either path, so this widens nothing a
 * process could write and claims nothing for what it reads. A name missing there is the container tree's own answer
 * (PackedVirtualFS: its index inside the store's roots, its memory outside them), never a kernel round trip, before the
 * process's tree is read.
 */
import type { VirtualFS } from './virtual-fs';

const preparedTrees = new WeakMap<object, VirtualFS>();

/** Reads of prepared bodies for a process on `tree` try `container` first: the container's own tree. */
export function readPreparedFrom(tree: VirtualFS, container: VirtualFS): void {
  if (tree !== container) preparedTrees.set(tree, container);
}

/** The container's tree a process on `tree` takes prepared bodies from first, where its run named one. */
export function preparedTreeOf(tree: object): VirtualFS | undefined {
  return preparedTrees.get(tree);
}
