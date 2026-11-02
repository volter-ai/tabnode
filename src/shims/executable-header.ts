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

/**
 * Classify a Node shebang once. Callers decide whether they can carry arguments,
 * env assignments or env's -S; a plain-shell dispatcher currently cannot.
 */
export function nodeShebang(head: Uint8Array): { plain: boolean } | undefined {
  const end = head.indexOf(10);
  const line = new TextDecoder().decode(end < 0 ? head : head.subarray(0, end));
  const match = /^#![ \t]*(?:(?<env>(?:\S*\/)?env)[ \t]+(?:(?<split>-S)[ \t]+)?(?<assignments>(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*))?(?<node>(?:\S*\/)?node)(?<arguments>[ \t][^\r\n]*)?\r?$/u.exec(line);
  if (!match?.groups) return undefined;
  const { env, split, assignments, node, arguments: args } = match.groups;
  return { plain: !split && !assignments && !args?.trim() && (env ? env.includes('/') && node === 'node' : node.includes('/')) };
}
