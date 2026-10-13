/**
 * WHERE A PROCESS READS PREPARED BODIES FROM FIRST (S2 R44b): a source the HOST names for a run on a tree of its own
 * (`RunOptions.preparedSource`), never one inferred from the container's tree. A prepared body is named by the
 * engine's format and its content's digest, never by a path a guest sees, so a host that can read the store's own
 * copy of a body by that name, without the process's view walk, hands that read here: LibreChat's server
 * (lc-9fd3ee80-again, worker 76) spent ~160 ms of its 420 ms of prepared reads walking its view and the container
 * overlay to `/opt/.tabnode/prepared/<key>`, once a body.
 *
 * THE SOURCE'S TERMS. It answers a body's text or undefined, and undefined is cheap: the host names a source only
 * where a miss is answered without a kernel round trip. The engine then reads the process's tree as before, so a body
 * the source does not hold (one kept in the tab under the process's view) is found there.
 *
 * WHAT A HOST MAY NAME. Because a source's read skips the process's view, a source must serve only bodies no
 * process can write: the image's own (the substrate's KernelVirtualFS.preparedText reads the packages store's
 * image-laid `/packages/.prepared/<key>`, inside the image's immutable bytes). A source over a path a process could
 * write would hand a contained process a body its own view would never show it. A body kept in the tab is read
 * through the process's view, as before. The source's read does not pass the process's credentials either: a
 * process whose user could not search `/opt/.tabnode` takes an image body it would have failed to read, which is the
 * engine's own cache, never a read a guest sees. A source that cannot read (an I/O failure of its store) answers
 * undefined, as a miss: the process's tree is then read, and its failure is that read's.
 */
import type { VirtualFS } from './virtual-fs';

/** A host's read of prepared bodies by key: the body's text, or undefined where it holds none or cannot read one. */
export interface PreparedSource { readText(key: string): string | undefined }

const preparedSources = new WeakMap<object, PreparedSource>();

/** Prepared bodies for a process on `tree` are asked of `source` first. */
export function readPreparedFrom(tree: VirtualFS, source: PreparedSource): void {
  preparedSources.set(tree, source);
}

/** The source a process on `tree` asks prepared bodies of first, where its run named one. */
export function preparedSourceOf(tree: object): PreparedSource | undefined {
  return preparedSources.get(tree);
}
