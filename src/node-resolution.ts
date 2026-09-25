// Node's module resolution, once, for every place the engine resolves a
// name: the runtime's require, the simple loader's, and the bundler's
// plugin. Each hand-rolled a subset and disagreed with the others and with
// Node; this is the algorithm Node documents (LOAD_AS_FILE, LOAD_AS_DIRECTORY,
// LOAD_NODE_MODULES, package exports and imports, self-reference), over a
// filesystem interface, with the lane's own choices as options: which
// conditions, which extensions, which main fields, and the workspace rule
// that a member's unbuilt entry is answered by its source.
//
// This file has no imports and the resolver is one self-contained function:
// the source adapter injects its own source text into the engine bundle and
// hands it the engine's `resolve.exports` functions, in the page as on Node.

export interface ResolutionFs {
  existsSync(path: string): boolean;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
  readFileSync(path: string, encoding: "utf8"): string | Uint8Array;
  realpathSync?(path: string): string;
}

export interface ExportsResolver {
  /** `resolve.exports`'s `resolve(pkg, entry, options)`: package exports or imports, by conditions. */
  resolve(pkg: unknown, entry: string, options?: { conditions?: readonly string[]; unsafe?: boolean; require?: boolean; browser?: boolean }): string[] | string | void;
  imports(pkg: unknown, entry: string, options?: { conditions?: readonly string[]; unsafe?: boolean; require?: boolean; browser?: boolean }): string[] | string | void;
}

export interface NodeResolverOptions {
  fs: ResolutionFs;
  exports: ExportsResolver;
  /** Condition sets tried in order for a package `exports`/`imports` map; the first that names an existing file wins. */
  conditionSets: readonly (readonly string[])[];
  /** Condition sets for one package by name, where a package is resolved for a side its default sets do not name. */
  conditionSetsFor?: (packageName: string) => readonly (readonly string[])[] | undefined;
  /** File extensions tried after the exact path, in order. Node's are `.js`, `.json`, `.node`. */
  extensions: readonly string[];
  /** Package fields naming the entry of a package without `exports`, in order. Node's is `main` alone. */
  mainFields: readonly string[];
  /** Directories searched after the walk-up, Node's global folders; the engine's `/node_modules`. */
  globalRoots?: readonly string[];
  /** Directories that are workspace members: an entry their build would write is answered by its source. */
  workspaceMembers?: () => ReadonlySet<string> | undefined;
  /** Extensions a member's source may have, when the lane can run them. */
  sourceExtensions?: readonly string[];
  /** A `.cjs` entry whose whole content is a `throw` is a stub for consumers that should import; skip it for the next condition set. */
  skipThrowingCjs?: boolean;
}

export interface NodeResolver {
  /** The file a specifier names from a directory, or null when the tree does not answer it. Builtins are the caller's. */
  resolve(specifier: string, fromDir: string): string | null;
}

export function createNodeResolver(options: NodeResolverOptions): NodeResolver {
  const { fs } = options;
  const normalize = (path: string): string => {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") { parts.pop(); continue; }
      parts.push(part);
    }
    return `/${parts.join("/")}`;
  };
  const manifests = new Map<string, Record<string, unknown> | null>();
  const isFile = (path: string): boolean => { try { return fs.existsSync(path) && fs.statSync(path).isFile(); } catch { return false; } };
  const isDirectory = (path: string): boolean => { try { return fs.existsSync(path) && fs.statSync(path).isDirectory(); } catch { return false; } };
  const manifest = (directory: string): Record<string, unknown> | null => {
    const path = `${directory === "/" ? "" : directory}/package.json`;
    if (manifests.has(path)) return manifests.get(path)!;
    let parsed: Record<string, unknown> | null = null;
    try { const text = fs.readFileSync(path, "utf8"); parsed = JSON.parse(typeof text === "string" ? text : new TextDecoder().decode(text)) as Record<string, unknown>; } catch { parsed = null; }
    manifests.set(path, parsed);
    return parsed;
  };
  const join = (base: string, relative: string): string => normalize(relative.startsWith("/") ? relative : `${base}/${relative}`);
  const parent = (path: string): string => { const index = path.lastIndexOf("/"); return index <= 0 ? "/" : path.slice(0, index); };

  // LOAD_AS_FILE(X): X, then X with each extension. A `.js` name whose
  // file is absent but whose TypeScript source is beside it is that source:
  // TypeScript's own module convention, which a project written for a
  // loader such as tsx relies on, and which resolving `.ts` at all implies.
  const typescriptSibling: Record<string, string> = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts", ".jsx": ".tsx" };
  const loadAsFile = (path: string): string | null => {
    if (isFile(path)) return path;
    for (const extension of options.extensions) if (isFile(path + extension)) return path + extension;
    const dot = path.lastIndexOf(".");
    const sibling = dot > path.lastIndexOf("/") ? typescriptSibling[path.slice(dot)] : undefined;
    if (sibling && options.extensions.includes(sibling) && isFile(path.slice(0, dot) + sibling)) return path.slice(0, dot) + sibling;
    return null;
  };
  // LOAD_INDEX(X): X/index with each extension.
  const loadIndex = (path: string): string | null => {
    for (const extension of options.extensions) if (isFile(`${path}/index${extension}`)) return `${path}/index${extension}`;
    return null;
  };
  // LOAD_AS_DIRECTORY(X): the manifest's main field as a file or a directory, else the index.
  const loadAsDirectory = (path: string): string | null => {
    if (!isDirectory(path)) return null;
    const pkg = manifest(path);
    if (pkg) {
      for (const field of options.mainFields) {
        const value = pkg[field];
        if (typeof value !== "string" || value.length === 0) continue;
        const target = join(path, value);
        const found = loadAsFile(target) ?? loadIndex(target);
        if (found) return found;
        const source = workspaceSource(path, value);
        if (source) return source;
      }
    }
    return loadIndex(path);
  };
  // A workspace member whose declared entry is not there: the source the
  // entry was built from, `src/index.ts` for `./dist/index.mjs`.
  const workspaceSource = (packageRoot: string, declared: string): string | null => {
    const members = options.workspaceMembers?.();
    if (!members || members.size === 0) return null;
    const root = packageRoot.replace(/\/+$/u, "") || "/";
    let real = root;
    try { if (fs.realpathSync) real = fs.realpathSync(root); } catch { /* the alias is the path */ }
    if (!members.has(root) && !members.has(real)) return null;
    const parts = declared.replace(/^\.\//u, "").replace(/^\//u, "").split("/").filter((part) => part.length > 0);
    const inner = parts.length > 1 ? parts.slice(1).join("/") : parts[0] ?? "index";
    const stem = inner.replace(/\.(?:m|c)?[jt]sx?$/u, "");
    const extensions = options.sourceExtensions ?? options.extensions;
    for (const base of real === root ? [root] : [root, real]) {
      for (const directory of ["src", ""]) {
        const prefix = directory ? `${base}/${directory}/` : `${base}/`;
        for (const extension of extensions) {
          if (isFile(`${prefix}${stem}${extension}`)) return `${prefix}${stem}${extension}`;
          if (isFile(`${prefix}${stem}/index${extension}`)) return `${prefix}${stem}/index${extension}`;
        }
      }
    }
    return null;
  };
  const targetsOf = (value: string[] | string | void): string[] => Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  // LOAD_PACKAGE_EXPORTS: the map's answer for each condition set, the first that is a file.
  const loadPackageExports = (packageRoot: string, pkg: Record<string, unknown>, specifier: string, packageName: string): string | null => {
    const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
    for (const conditions of options.conditionSetsFor?.(packageName) ?? options.conditionSets) {
      let targets: string[];
      try { targets = targetsOf(options.exports.resolve(pkg, subpath, { conditions, unsafe: true })); } catch { continue; }
      for (const target of targets) {
        const path = join(packageRoot, target);
        const found = loadAsFile(path) ?? workspaceSource(packageRoot, target);
        if (!found) continue;
        if (options.skipThrowingCjs && found.endsWith(".cjs")) {
          try { const text = fs.readFileSync(found, "utf8"); if (String(text).trimStart().startsWith("throw ")) continue; } catch { /* unreadable: taken as is */ }
        }
        return found;
      }
    }
    return null;
  };
  const packageNameOf = (specifier: string): string => {
    const parts = specifier.split("/");
    return parts[0]!.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]!;
  };
  // LOAD_NODE_MODULES from one directory: exports, else the package's own entry or a file under it.
  // A package with `exports` is answered by the map alone, as Node answers it:
  // a subpath the map does not name, or names to a missing file, does not
  // resolve. Falling through to the file under the package made
  // `require.resolve("<pkg>/package.json")` succeed where Node throws, and a
  // program that asks that question to decide what it does (Vite config that
  // excludes a package it cannot resolve) decided differently in the tab.
  const loadFromNodeModules = (nodeModules: string, specifier: string): string | null => {
    const packageName = packageNameOf(specifier);
    const packageRoot = `${nodeModules}/${packageName}`;
    const pkg = isDirectory(packageRoot) ? manifest(packageRoot) : null;
    if (pkg && pkg.exports !== undefined && pkg.exports !== null) return loadPackageExports(packageRoot, pkg, specifier, packageName);
    const path = `${nodeModules}/${specifier}`;
    return loadAsFile(path) ?? loadAsDirectory(path);
  };
  // LOAD_PACKAGE_SELF: a package importing itself by name through its exports.
  const loadPackageSelf = (specifier: string, fromDir: string): string | null => {
    const packageName = packageNameOf(specifier);
    let directory = fromDir;
    for (;;) {
      const pkg = manifest(directory);
      if (pkg && pkg.name === packageName && pkg.exports !== undefined && pkg.exports !== null) return loadPackageExports(directory, pkg, specifier, packageName);
      if (directory === "/") return null;
      directory = parent(directory);
    }
  };
  // `#name`: the nearest manifest's imports map.
  const loadPackageImports = (specifier: string, fromDir: string): string | null => {
    let directory = fromDir;
    for (;;) {
      const pkg = manifest(directory);
      if (pkg && pkg.imports) {
        for (const conditions of options.conditionSets) {
          let targets: string[];
          try { targets = targetsOf(options.exports.imports(pkg, specifier, { conditions, unsafe: true })); } catch { continue; }
          for (const target of targets) {
            if (!target.startsWith(".") && !target.startsWith("/")) { const found = resolveCached(target, directory); if (found) return found; continue; }
            const found = loadAsFile(join(directory, target));
            if (found) return found;
          }
        }
        return null;
      }
      if (directory === "/") return null;
      directory = parent(directory);
    }
  };

  const resolve = (specifier: string, fromDir: string): string | null => {
    // Manifests are read once per resolution, never kept across: the tree
    // changes under a long-lived resolver, an install links a package in.
    manifests.clear();
    const found = resolveCached(specifier, fromDir);
    // Node answers the real path of what it found: a package reached through
    // a link (pnpm lays every dependency under `.pnpm` and links it in) is
    // then walked up from where it really is, so its own dependencies beside
    // it are found. A filesystem without links answers the path itself.
    if (found && fs.realpathSync) { try { return fs.realpathSync(found); } catch { return found; } }
    return found;
  };
  const resolveCached = (specifier: string, fromDir: string): string | null => {
    if (specifier.startsWith("#")) return loadPackageImports(specifier, fromDir);
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier === "." || specifier === "..") {
      const path = join(fromDir, specifier);
      return loadAsFile(path) ?? loadAsDirectory(path);
    }
    const self = loadPackageSelf(specifier, fromDir);
    if (self) return self;
    let directory = fromDir;
    for (;;) {
      if (!directory.endsWith("/node_modules")) {
        const found = loadFromNodeModules(`${directory === "/" ? "" : directory}/node_modules`, specifier);
        if (found) return found;
      }
      if (directory === "/") break;
      directory = parent(directory);
    }
    for (const root of options.globalRoots ?? []) {
      const found = loadFromNodeModules(root, specifier);
      if (found) return found;
    }
    return null;
  };
  return { resolve };
}
