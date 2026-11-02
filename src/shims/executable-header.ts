import type { VirtualFS } from '../virtual-fs';
import { treeDescriptorsOf } from '../tree-descriptors';

/** Linux's script loader reads a bounded first block, not a whole executable. */
export const EXECUTABLE_HEADER_BYTES = 256;

/** Read through this tree's descriptor owner when it has one. */
export function executableHeader(tree: VirtualFS, path: string): Uint8Array {
  const door = treeDescriptorsOf(tree);
  if (door) {
    const fd = door.open(path, 0, 0);
    try {
      const head = new Uint8Array(EXECUTABLE_HEADER_BYTES);
      return head.subarray(0, door.read(fd, head, 0, head.length, 0));
    } finally { door.close(fd); }
  }
  // VirtualFS holds its file in memory; descriptor-backed trees take the bounded door above.
  return (tree.readFileSync(path) as Uint8Array).subarray(0, EXECUTABLE_HEADER_BYTES);
}
