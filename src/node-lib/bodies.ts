import { NODE_LIB_PARAMETERS } from '../guest-scope';
import { scopedBody, type ScopedBody } from './scoped-body';
import { NODE_LIB_SOURCES } from './sources';

/**
 * Node's own files' bodies (scoped-body.ts), by the name Node's `require` calls each one: what a process's realm
 * compiles for a builtin. The library's build replaces this module with the bodies already made (vite.lib.config.js
 * `node-lib-bodies`), as Node embeds its library ready to run (js2c, its startup snapshot), so no process's realm parses
 * Node's library to rewrite it: in the machine that was 110 ms of every Node process's start, read 2026-11-14. Run from
 * source, a body is made on its first ask.
 */
const made = new Map<string, ScopedBody>();

/** The vendored file's body, or undefined where Node's library has no file of the name. */
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
