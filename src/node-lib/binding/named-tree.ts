/**
 * A tree named for the length of one call, which is how the engine's own
 * parts use `fs` outside a run: the substrate builds with rolldown over a
 * project's tree, and the engine hands WASI a tree of its own. Node's `fs` is
 * one module and reads the run's tree off the run's process; this is the
 * door for a caller that has a tree but is not a run. Its own module, so the
 * socket calls (`host-sockets.ts`) find the calling tree without the `fs`
 * binding's imports.
 */
import type { VirtualFS } from '../../virtual-fs';

// eslint-disable-next-line no-var, vars-on-top
var overrideTree: VirtualFS | null = null;
export function withFilesystem<T>(tree: VirtualFS, work: () => T): T {
  const previous = overrideTree;
  overrideTree = tree;
  try { return work(); } finally { overrideTree = previous; }
}

/** The tree named for the length of one call, where one is: the engine's own door acting as its process. */
export function namedTree(): VirtualFS | null { return overrideTree; }
