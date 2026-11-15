import { NODE_LIB_PARAMETERS } from '../guest-scope';
import { scopedBody, type ScopedBody } from './scoped-body';
import { NODE_LIB_SOURCES } from './sources';

/**
 * Node's own files, by the name Node's `require` calls each one. A process whose global is its realm's own compiles
 * the file as it is (load.ts); a process that shares its realm with others compiles its body (scoped-body.ts), made
 * on its first ask in the realm.
 */
const made = new Map<string, ScopedBody>();

/** The vendored file's text, or undefined where Node's library has no file of the name. */
export function nodeLibSource(name: string): string | undefined {
  return NODE_LIB_SOURCES[name];
}

/** The vendored file's scoped body, or undefined where Node's library has no file of the name. */
export function nodeLibBody(name: string): ScopedBody | undefined {
  const source = NODE_LIB_SOURCES[name];
  if (source === undefined) return undefined;
  let body = made.get(name);
  if (!body) made.set(name, body = scopedBody(NODE_LIB_PARAMETERS, source, `node:${name}`));
  return body;
}

/** Whether Node's library has a file of the name. */
export function isNodeLibFile(name: string): boolean {
  return NODE_LIB_SOURCES[name] !== undefined;
}
