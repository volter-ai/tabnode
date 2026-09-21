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
export function globToRegExp(glob: string, nocase = false): RegExp {
  return new RegExp("^" + globBody(glob) + "$", nocase ? "i" : "");
}

function globBody(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:[^/]*\\/)*"; } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      let end = i + 1;
      let body = "";
      if (glob[end] === "!" || glob[end] === "^") { body += "^"; end++; }
      for (; end < glob.length && glob[end] !== "]"; end++) body += glob[end] === "\\" ? "\\\\" : glob[end];
      if (end >= glob.length) out += "\\["; else { out += "[" + body + "]"; i = end; }
    } else if (ch === "{") {
      let depth = 1;
      let end = i + 1;
      let body = "";
      for (; end < glob.length; end++) {
        if (glob[end] === "{") depth++;
        else if (glob[end] === "}") { depth--; if (depth === 0) break; }
        body += glob[end];
      }
      if (depth !== 0) out += "\\{"; else { out += "(?:" + body.split(",").map(globBody).join("|") + ")"; i = end; }
    } else {
      out += ch.replace(/[.+^$()|\]}\\]/g, "\\$&");
    }
  }
  return out;
}
