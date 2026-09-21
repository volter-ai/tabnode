/**
 * Node's glob, for `path.matchesGlob` and for `fs.glob`: `**` crosses
 * separators, `*` and `?` do not, `[...]` is a character class and `{a,b}` is
 * an alternation, and the whole path is matched.
 *
 * It lives here because both the builtin table in `runtime.ts` and the fs
 * shim's `globSync` need it. It used to be a function declared in
 * `runtime.ts` and merely `declare`d in `src/shims/fs.ts`, on the belief that
 * the bundle gives every module one shared scope; it does not, so a guest
 * that called `fs.globSync` — the vitest and Prisma CLIs glob for their own
 * files — died on `__browserRuntimeNodeGlob is not defined`. A module both
 * import is the same helper in either build.
 *
 * This is not npm's package.json glob, which anchors a pattern without a
 * separator at any segment; that one stays with the installer, since each
 * source system keeps its own semantics.
 */
export declare function globToRegExp(glob: string, nocase?: boolean): RegExp;
//# sourceMappingURL=glob.d.ts.map