/**
 * What the engine does differently by the Node line a guest's image declares.
 *
 * The engine runs one Node library, v24.21.0's own files (src/node-lib/sources.ts), for every guest. A guest's
 * `process.version` is nonetheless the version its image names (src/shims/process.ts, the image's `NODE_VERSION`),
 * so a guest of a `node:20` image is told v20.x and given v24's library. That disagreement is known and stays: the
 * library IS 24's, and its own internals say v24.21.0 whatever the guest is told (src/node-lib/load.ts). This file
 * holds the behaviours that follow the declared line instead, keyed by the major of that same `process.version`.
 *
 * A row is admitted only with its measurement beside it: the script, the Node versions it ran on, and the numbers.
 * Recall is not a source. A behaviour believed to differ and not measured on the real Node of each line is a
 * candidate, listed at the foot of this file, and changes nothing.
 */

/** The major of a `process.version` (`v20.20.2` is 20); the engine's own line where it names none. */
export function nodeLineOf(version: unknown): number {
  const major = typeof version === 'string' ? /^v?(\d+)\./.exec(version)?.[1] : undefined;
  return major ? Number(major) : NODE_LIBRARY_LINE;
}

/** The line of the library the engine carries: what every behaviour is unless a row says otherwise. */
export const NODE_LIBRARY_LINE = 24;

/**
 * Loop turns before an `import()` settles when it ran an ES module's body for the first time.
 *
 * Measured with scripts/node-line/import-turns.cjs (a setImmediate counter beside a loop of awaited imports of six
 * fresh files, then three of them again), loop turns after fresh imports 1..6:
 *   v20.20.2  ES module 3, 9, 14, 18, 22, 27 (again: no more)   CommonJS by import() 0, 0, 0, 0, 0, 0
 *   v22.23.3  ES module 0, 0, 0, 0, 0, 0                         CommonJS 0, 0, 0, 0, 0, 0
 *   v24.21.0  ES module 0, 0, 0, 0, 0, 0                         CommonJS 0, 0, 0, 0, 0, 0
 *   v26.8.1   ES module 0, 0, 0, 0, 0, 0                         CommonJS 0, 0, 0, 0, 0, 0
 * So on line 20 a fresh ES module's import does not settle in the turn that asked for it: the loop runs, and what
 * is waiting on it (a socket's bytes, a timer) is delivered between one import and the next. A program that loads
 * many modules in a chain of awaited imports while it listens, as Next's server does when it preloads its entries,
 * answers requests during that chain on line 20 and after it on the others.
 *
 * One turn, not Node's four or five: those are its loader's own hops, and the count is not the claim. That the loop
 * runs before the import settles is, and one turn is the least that makes it so.
 */
export function freshEsModuleImportTurns(line: number): number {
  return line === 20 ? 1 : 0;
}

/*
 * Candidates, not rows. Each is believed to differ between lines 20 and 24 and is what the engine does today
 * because its library is 24's; none has been measured on a real Node 20, so none is switched:
 *   - require() of an ES module
 *   - a .ts file run by erasing its types with no flag
 *   - Module.registerHooks
 *   - process.getBuiltinModule
 *   - the navigator global
 */
