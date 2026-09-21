// Tailwind v4 through its Vite plugin, in the tab. `@tailwindcss/vite`
// wraps the `tailwindcss` core, which is JavaScript, with two native
// pieces the tab cannot run: the oxide scanner that finds class candidates
// in source files, and lightningcss that minifies the result. The tab
// stands in for the plugin with one that compiles through the project's
// own `tailwindcss` core, the same compiler the PostCSS route reaches
// through Tailwind's browser engine, scans candidates in JavaScript, and
// leaves the CSS unminified. A sheet that imports `tailwindcss` is
// compiled; every other sheet passes through untouched.

/** Where the tab keeps the stand-in, outside the workspace. */
export const TAILWIND_RUNTIME_DIRECTORY = "/tmp/browser-runtime-tailwind";
export const TAILWIND_VITE_PATH = `${TAILWIND_RUNTIME_DIRECTORY}/vite.cjs`;

/** Bare names the engine resolves to a file of the tab's own, by name. */
export const STAND_IN_PATHS: Readonly<Record<string, string>> = {
  "@tailwindcss/vite": TAILWIND_VITE_PATH,
};

export const TAILWIND_VITE_SOURCE = String.raw`"use strict";
const fs = require("fs");
const path = require("path");

const SOURCE_EXTENSIONS = new Set([".html", ".htm", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro", ".md", ".mdx", ".json", ".php", ".erb", ".hbs", ".ejs", ".pug", ".txt"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".svelte-kit", ".next", ".react-router", ".cache", ".stages", "coverage"]);
const IMPORTS_TAILWIND = /@import\s+(?:url\()?["']tailwindcss(?:\/[^"']*)?["']|@tailwind\s+\w+|@reference\s+["']tailwindcss|@config\s+["']|@plugin\s+["']/u;

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Every token a class name could be, from every source file under the root. */
function scanCandidates(root) {
  const candidates = new Set();
  const visit = (directory, depth) => {
    if (depth > 12) return;
    let names;
    try { names = fs.readdirSync(directory); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") && name !== ".") { if (SKIPPED_DIRECTORIES.has(name)) continue; }
      if (SKIPPED_DIRECTORIES.has(name)) continue;
      const full = path.join(directory, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) { visit(full, depth + 1); continue; }
      if (!stat.isFile() || !isSourceFile(full) || stat.size > 2 * 1024 * 1024) continue;
      let text;
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      for (const token of text.split(/[\s"'\x60<>=(){}\[\];,]+/u)) {
        if (token.length > 0 && token.length < 200) candidates.add(token);
      }
    }
  };
  visit(root, 0);
  return [...candidates];
}

function findPackage(name, from) {
  let directory = from;
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function loadCore(root) {
  const home = findPackage("tailwindcss", root);
  if (!home) throw new Error("@tailwindcss/vite: the project has no tailwindcss package installed beside it.");
  const core = require(path.join(home, "dist", "lib.js"));
  return { home, compile: core.compile || (core.default && core.default.compile) };
}

/** A stylesheet the core asks for: "tailwindcss", one of its files, a package's, or a relative one. */
function resolveStylesheet(id, base, root) {
  if (id === "tailwindcss") return path.join(findPackage("tailwindcss", root), "index.css");
  if (id.startsWith("tailwindcss/")) return path.join(findPackage("tailwindcss", root), id.slice("tailwindcss/".length));
  if (id.startsWith("./") || id.startsWith("../") || id.startsWith("/")) return path.resolve(base, id);
  const slash = id.startsWith("@") ? id.indexOf("/", id.indexOf("/") + 1) : id.indexOf("/");
  const packageName = slash > 0 ? id.slice(0, slash) : id;
  const rest = slash > 0 ? id.slice(slash + 1) : "";
  const home = findPackage(packageName, base) || findPackage(packageName, root);
  if (!home) throw new Error("@tailwindcss/vite: cannot find the stylesheet " + id);
  if (rest) return path.join(home, rest);
  // The package's stylesheet, the way Tailwind's own loader finds it: its
  // "style" field, its exports' style condition, an exports or main that
  // is itself a stylesheet, else index.css.
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(home, "package.json"), "utf8")); } catch {}
  const dot = manifest.exports && typeof manifest.exports === "object" ? manifest.exports["."] : undefined;
  const isSheet = (value) => typeof value === "string" && /\.css$/u.test(value);
  const candidates = [
    manifest.style,
    isSheet(manifest.exports) ? manifest.exports : undefined,
    dot && typeof dot === "object" ? dot.style : undefined,
    isSheet(dot) ? dot : undefined,
    dot && typeof dot === "object" && isSheet(dot.default) ? dot.default : undefined,
    isSheet(manifest.main) ? manifest.main : undefined,
    "index.css",
  ].filter((candidate) => typeof candidate === "string");
  for (const candidate of candidates) {
    const resolved = path.join(home, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return path.join(home, candidates[0]);
}

async function compileSheet(css, file, root) {
  const { compile } = loadCore(root);
  const base = path.dirname(file);
  const compiled = await compile(css, {
    base,
    from: file,
    async loadStylesheet(id, from) {
      const resolved = resolveStylesheet(id, from, root);
      return { path: resolved, base: path.dirname(resolved), content: fs.readFileSync(resolved, "utf8") };
    },
    async loadModule(id, from) {
      const resolved = id.startsWith(".") || id.startsWith("/") ? path.resolve(from, id) : require.resolve(id, { paths: [from, root] });
      const loaded = require(resolved);
      return { path: resolved, base: path.dirname(resolved), module: loaded && loaded.default ? loaded.default : loaded };
    },
  });
  return compiled.build(scanCandidates(root));
}

function tailwindcss() {
  let root = process.cwd();
  const sheets = new Set();
  const plugin = {
    name: "@tailwindcss/vite",
    enforce: "pre",
    configResolved(config) { root = config.root || root; },
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.(?:css|pcss|postcss)$/u.test(file) || !IMPORTS_TAILWIND.test(code)) return null;
      sheets.add(file);
      const css = await compileSheet(code, file, root);
      return { code: css, map: null };
    },
    handleHotUpdate(context) {
      const changed = context.file.split("?")[0];
      if (!isSourceFile(changed) || SKIPPED_DIRECTORIES.has(path.basename(path.dirname(changed)))) return;
      const modules = [];
      for (const sheet of sheets) {
        for (const module of context.server.moduleGraph.getModulesByFile(sheet) || []) {
          context.server.moduleGraph.invalidateModule(module);
          modules.push(module);
        }
      }
      return modules.length > 0 ? [...context.modules, ...modules] : undefined;
    },
  };
  return [plugin];
}

module.exports = tailwindcss;
module.exports.default = tailwindcss;
`;
