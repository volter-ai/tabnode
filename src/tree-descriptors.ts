/**
 * A tree that owns its open file descriptions.
 *
 * The engine's own trees keep a descriptor table of the engine's: an fd is a
 * path, flags and an offset in `node-lib/binding/fs.ts`. A tree a host
 * supplies may instead be a client of a kernel that keeps those descriptions
 * itself, shared with every other process of the kernel: one offset for a
 * dup'd or inherited descriptor, `O_APPEND` decided where the file is,
 * locks, and fork and exec inheritance (ADR-0005). Such a tree offers this
 * capability under `TREE_DESCRIPTORS`, and the engine then asks it for every
 * descriptor operation on a file it opened, and for the numbers of the
 * engine's own handles, so the process has one numbering.
 *
 * A symbol, not method names: `openSync`/`readSync` are what a Node `fs`
 * module looks like, and a tree that happened to carry one would be taken
 * for a kernel's.
 */
export const TREE_DESCRIPTORS = Symbol.for('tabnode.tree.descriptors');

/** What the stat of an open description answers, in the shape a tree's `statSync` answers. */
export interface TreeDescriptorStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  /** The other kinds of file, where the tree has them; a mode's type bits answer first. */
  isCharacterDevice?(): boolean;
  isBlockDevice?(): boolean;
  isFIFO?(): boolean;
  isSocket?(): boolean;
  size: number;
  mode: number;
  mtimeMs?: number;
  atimeMs?: number;
  ctimeMs?: number;
  birthtimeMs?: number;
  mtime?: Date;
  atime?: Date;
  ctime?: Date;
  birthtime?: Date;
  nlink?: number;
  uid?: number;
  gid?: number;
  dev?: number;
  ino?: number;
  rdev?: number;
  blksize?: number;
  blocks?: number;
}

/**
 * The descriptor operations of a tree that owns its descriptions. Each is the
 * Linux call of its name; a failure throws an error carrying the call's
 * `code` (and `errno`), as Node's fs errors do.
 */
export interface TreeDescriptors {
  /** open(2): `flags` are the O_* bits Node passes, `mode` the creation mode; answers the fd. */
  open(path: string, flags: number, mode: number): number;
  close(fd: number): void;
  /** read(2) at the description's offset when `position` is null, pread(2) at `position` otherwise. */
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  /** write(2) (honouring O_APPEND) when `position` is null, pwrite(2) at `position` otherwise. */
  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  fstat(fd: number): TreeDescriptorStats;
  ftruncate(fd: number, length: number): void;
  fsync(fd: number): void;
  fchmod(fd: number, mode: number): void;
  /** futimens(2), in seconds. */
  futimes(fd: number, atime: number, mtime: number): void;
  /**
   * fcntl(fd, F_DUPFD_CLOEXEC, 0): a second number for the SAME open description (one offset, its
   * `O_APPEND`), which `close` releases; the description lives while either number does. The engine
   * holds one for a child whose stdio names this descriptor, as fork's copy and dup2 give a Linux
   * child its own reference: the parent may close its number at once (`spawn` then `closeSync`), and
   * the child still writes the file. A tree without it leaves such a child writing by the parent's
   * number, which a close drops and a reuse misdirects.
   */
  dup?(fd: number): number;
  /** A number for a handle of the engine's own (a pipe, a socket), held until `release`. */
  reserve(): number;
  release(fd: number): void;
}

/** The descriptor capability a tree offers, where it offers one. */
export function treeDescriptorsOf(tree: unknown): TreeDescriptors | undefined {
  if (tree === null || (typeof tree !== 'object' && typeof tree !== 'function')) return undefined;
  const offered = (tree as Record<symbol, unknown>)[TREE_DESCRIPTORS];
  return offered !== null && typeof offered === 'object' ? offered as TreeDescriptors : undefined;
}
