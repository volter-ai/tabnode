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
  /**
   * `contentDigest`: where the filesystem's stat carries it (a kernel tree's stat of a regular file, links followed,
   * KernelVirtualFS `statWithDigest`), the file's content digest from the same walk as the stat.
   * With throwIfNoEntry:false, only ENOENT/ENOTDIR return undefined. Permission/I/O failures still throw,
   * so the package-config cache never mistakes them for a persistent absence.
   */
  statSync(path: string, options?: { throwIfNoEntry?: boolean }): { isFile(): boolean; isDirectory(): boolean; contentDigest?: string } | undefined;
  readFileSync(path: string, encoding: "utf8"): string | Uint8Array;
  realpathSync?(path: string): string;
  /**
   * A path's kind where the filesystem answers it without a stat (KernelVirtualFS `kindSync`: its realm's kept
   * answer, links followed): 0 a file, 1 a directory, -1 proved absent; undefined where it cannot, and `statSync` is
   * asked as before. A probe answered here makes no Stats and no digest: a file's digest, wanted of the file a
   * resolution answers alone, is then asked of `contentDigest`.
   */
  kindSync?(path: string): 0 | 1 | -1 | undefined;
  /** A regular file's content digest, or undefined where the tree holds none; asked only after `kindSync` said 0. */
  contentDigest?(path: string): string | undefined;
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
  /**
   * A package found whose `exports` map names the subpath under no condition set throws ERR_PACKAGE_PATH_NOT_EXPORTED and
   * ends the walk, as Node's `packageExportsResolve` does, where a null would let the caller say MODULE_NOT_FOUND. The
   * code is the answer a program reads: MeshCentral's InstallModules (meshcentral.js:4188, 029b7338) asks
   * `require("otplib/package.json")`, falls back to reading the file for this code alone, and took any other for a
   * missing module, which it went to install with npm.
   */
  throwNotExported?: boolean;
}

/**
 * What one process keeps between its resolutions, as Node's CommonJS loader does (lib/internal/modules/cjs/loader.js
 * and helpers.js, v24.21.0). A caller that passes none resolves as before, every probe asked of the tree.
 */
export interface ResolutionKept {
  /**
   * `package.json` files read and parsed, by path, for the process's life: Node's package reader keeps each one it
   * has read. Missing configs are retained separately by this resolver for the same process and filesystem,
   * as Node's GetPackageJSON does; malformed or unreadable configs are not kept as missing.
   */
  manifests: Map<string, Record<string, unknown>>;
  /** Node's missing package configs persist with the process, shared by its resolvers for the same filesystem. */
  missingManifests?: WeakMap<ResolutionFs, Set<string>>;
  /** Scalar evidence for package-config reuse; published through the existing deferred module clock. */
  packageConfigs?: { lookups: number; positiveHits: number; negativeHits: number; checks: number; reads: number; missingKept: number };
  /** Real paths answered, for the process's life: Node's `realpathCache` (helpers.js `toRealPath`). */
  realPaths: Map<string, string>;
  /**
   * Paths found to exist, 0 a file and 1 a directory: Node's `statCache`, which holds successful stats only
   * (`stat()` sets it when `internalModuleStat` answers >= 0) and exists only while a module compiled at require
   * depth 0 is executing (`Module.prototype._compile`). The caller sets it for that window and unsets it after;
   * a path that was absent is asked again every time, so a file written and then required is found.
   */
  stats?: Map<string, 0 | 1>;
  /**
   * An instrument: the resolver's stat probes for this process. `file`, `directory`, `absent`: asked of the tree, by
   * the answer. `held`: answered from `stats` without asking. `outside`: of those asked, the ones asked with no
   * window open. `windows`: stat windows opened.
   */
  probes?: { file: number; directory: number; absent: number; held: number; outside: number; windows: number };
  /**
   * The file the last resolution answered, with the content digest its own stat carried, for the load that follows
   * it: the load asked the tree for the digest again, one request a module (`contentDigest`, LibreChat 14's server:
   * 6,172 asks beside 7,893 stats that had carried one). Set by every resolution, a digest only where the stat that
   * found the file was asked of the tree in that resolution (not one `stats` held); the caller takes it once.
   */
  carried?: { path: string; digest: string };
  /**
   * Whether a `.cjs` entry is a throwing stub (`skipThrowingCjs`), learned once for the bytes it was learned from,
   * by their content digest, for the process's life: the answer is a fact of those bytes. The check read the file
   * whole at every resolution that passed it: LibreChat run 40's server read @librechat/api's 6.19 MB entry 52 times
   * and data-schemas' 1.76 MB entry 48 times, 406 of the 409 MB its realm read again.
   */
  throwingStubs?: Map<string, boolean>;
}

export interface NodeResolver {
  /** The file a specifier names from a directory, or null when the tree does not answer it. Builtins are the caller's. */
  resolve(specifier: string, fromDir: string, kept?: ResolutionKept): string | null;
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
  // Node24.21 src/node_modules.cc:95-110 looks up package_configs_, including nullopt;115-135 keeps
  // ENOENT/ENOTDIR/EISDIR there for the realm lifetime, without invalidation. A later-created config
  // remains unseen in that process. ResolutionKept owns the absence set for each filesystem, so another
  // resolver of the same tree shares it, while another process/tree does not. General misses stay uncached.
  /** The same fact by path, while one stat window stands (`ResolutionKept.stats`): a stat it holds asks nothing, so no digest. */
  const stubsInWindow = new WeakMap<Map<string, 0 | 1>, Map<string, boolean>>();
  /** Whether `found`, a `.cjs` file, is a stub whose whole content is a `throw`: read once per digest, or once per window. */
  const throwingStub = (found: string): boolean => {
    const digest = digestOf(found);
    const window = kept?.stats;
    const byPath = window ? stubsInWindow.get(window) : undefined;
    const known = byPath?.get(found) ?? (digest !== undefined ? kept?.throwingStubs?.get(digest) : undefined);
    if (known !== undefined) return known;
    let throwing = false;
    try { const text = fs.readFileSync(found, "utf8"); throwing = String(text).trimStart().startsWith("throw "); } catch { /* unreadable: taken as is */ }
    if (digest !== undefined && kept) (kept.throwingStubs ??= new Map()).set(digest, throwing);
    if (window) {
      let held = byPath;
      if (!held) { held = new Map(); stubsInWindow.set(window, held); }
      held.set(found, throwing);
    }
    return throwing;
  };
  // stat already distinguishes absence and type; probing exists first walks
  // the same filesystem path twice for every successful module candidate.
  /** What the resolution in hand keeps for its process; none for a caller that keeps nothing. */
  let kept: ResolutionKept | undefined;
  /**
   * What the resolution in hand has been answered, absences too: one resolution is one synchronous walk and nothing
   * changes the tree under it, so it asks each path once. Emptied when a resolution begins; nothing outlives it.
   */
  // -1 is proved absence, -2 an unclassified non-file or failed stat. Both mean no candidate, but only
  // proved absence may become a persistent package-config miss. Keep this in the existing probe map.
  const asked = new Map<string, 0 | 1 | -1 | -2>();
  const missingConfigError = (cause: unknown): boolean => {
    const code = (cause as { code?: unknown } | null | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
  };
  /** The content digest each file stat of the resolution in hand carried, by path; emptied with `asked`. */
  const digests = new Map<string, string>();
  /**
   * Files of the resolution in hand that `kindSync` answered, whose digest is not asked until wanted (S2 R77): the
   * stat asked it of every file probed, each package.json and each candidate passed over, beside a Stats made for
   * every file and directory probed (Twenty's server: 222,711 realm kind answers for 41,112 resolutions, ~41 µs each).
   * Emptied with `asked`.
   */
  const undigested = new Set<string>();
  /** A file's digest as its stat would have carried it: the one carried, else asked once where `kindSync` answered it. */
  const digestOf = (path: string): string | undefined => {
    const carried = digests.get(path);
    if (carried !== undefined || !undigested.delete(path)) return carried;
    let digest: string | undefined;
    try { digest = fs.contentDigest?.(path); } catch { digest = undefined; }
    if (typeof digest === "string") digests.set(path, digest);
    return typeof digest === "string" ? digest : undefined;
  };
  /** 0 a file, 1 a directory, -1 absent, -2 another non-file or failed stat. */
  const kind = (path: string): 0 | 1 | -1 | -2 => {
    const again = asked.get(path);
    if (again !== undefined) return again;
    const answer = ask(path);
    asked.set(path, answer);
    return answer;
  };
  const ask = (path: string): 0 | 1 | -1 | -2 => {
    const held = kept?.stats?.get(path);
    const probes = kept?.probes;
    if (held !== undefined) { if (probes) probes.held += 1; return held; }
    let found: 0 | 1 | -1 | -2;
    let local: 0 | 1 | -1 | undefined;
    try { local = fs.kindSync?.(path); } catch { local = undefined; }
    if (local !== undefined) {
      found = local;
      if (found === 0) undigested.add(path);
    } else try {
      const stat = fs.statSync(path, { throwIfNoEntry: false });
      found = stat === undefined ? -1 : stat.isFile() ? 0 : stat.isDirectory() ? 1 : -2;
      if (found === 0 && typeof stat?.contentDigest === "string") digests.set(path, stat.contentDigest);
    } catch (cause) { found = missingConfigError(cause) ? -1 : -2; }
    if (probes) {
      if (found === 0) probes.file += 1; else if (found === 1) probes.directory += 1; else probes.absent += 1;
      if (kept?.stats === undefined) probes.outside += 1;
    }
    if (found === 0 || found === 1) kept?.stats?.set(path, found);
    return found;
  };
  const isFile = (path: string): boolean => kind(path) === 0;
  const isDirectory = (path: string): boolean => kind(path) === 1;
  const manifest = (directory: string): Record<string, unknown> | null => {
    const path = `${directory === "/" ? "" : directory}/package.json`;
    const counts = kept?.packageConfigs;
    if (counts) counts.lookups += 1;
    if (kept?.missingManifests?.get(fs)?.has(path)) {
      if (counts) counts.negativeHits += 1;
      return null;
    }
    const held = kept?.manifests.get(path);
    if (held) { if (counts) counts.positiveHits += 1; return held; }
    if (manifests.has(path)) return manifests.get(path)!;
    if (counts) counts.checks += 1;
    let parsed: Record<string, unknown> | null = null;
    let missing = false;
    if (isFile(path)) {
      try {
        if (counts) counts.reads += 1;
        const text = fs.readFileSync(path, "utf8");
        parsed = JSON.parse(typeof text === "string" ? text : new TextDecoder().decode(text)) as Record<string, unknown>;
      } catch (cause) { missing = missingConfigError(cause); parsed = null; }
    } else {
      // A directory config is EISDIR. An unclassified non-file or failed stat is not a missing fact.
      missing = asked.get(path) === 1 || asked.get(path) === -1;
    }
    if (missing && kept) {
      let paths = kept.missingManifests?.get(fs);
      if (!paths) { paths = new Set(); (kept.missingManifests ??= new WeakMap()).set(fs, paths); }
      paths.add(path);
      if (counts) counts.missingKept += 1;
    }
    manifests.set(path, parsed);
    if (parsed && typeof parsed === "object") kept?.manifests.set(path, parsed);
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
  const loadPackageExports = (packageRoot: string, pkg: Record<string, unknown>, specifier: string, packageName: string, refuse = false): string | null => {
    const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
    // Whether the map names the subpath under any condition set: one that names a missing file is not a refusal.
    let named = false;
    for (const conditions of options.conditionSetsFor?.(packageName) ?? options.conditionSets) {
      let targets: string[];
      try { targets = targetsOf(options.exports.resolve(pkg, subpath, { conditions, unsafe: true })); } catch { continue; }
      if (targets.length) named = true;
      for (const target of targets) {
        const path = join(packageRoot, target);
        const found = loadAsFile(path) ?? workspaceSource(packageRoot, target);
        if (!found) continue;
        if (options.skipThrowingCjs && found.endsWith(".cjs") && throwingStub(found)) continue;
        return found;
      }
    }
    if (refuse && !named) {
      // Node's own words (lib/internal/errors.js ERR_PACKAGE_PATH_NOT_EXPORTED).
      const where = `${packageRoot}/package.json`;
      throw Object.assign(new Error(subpath === "." ? `No "exports" main defined in ${where}` : `Package subpath '${subpath}' is not defined by "exports" in ${where}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
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
    const rooted = isDirectory(packageRoot);
    // Nothing is under a directory that is not there: a subpath of an absent package ends here, unprobed.
    if (!rooted && specifier !== packageName) return null;
    const pkg = rooted ? manifest(packageRoot) : null;
    if (pkg && pkg.exports !== undefined && pkg.exports !== null) return loadPackageExports(packageRoot, pkg, specifier, packageName, options.throwNotExported === true);
    const path = `${nodeModules}/${specifier}`;
    return loadAsFile(path) ?? loadAsDirectory(path);
  };
  // LOAD_PACKAGE_SELF: a package importing itself by name through its exports. The package is the nearest manifest
  // above the importer and no other (Node's `trySelf` reads `getNearestParentPackageJSON` and answers false unless
  // that one has `exports` and the name asked for), so the walk ends at the first manifest it meets.
  // Node24.21 src/node_modules.cc:311-350 stops before / and a directory named node_modules.
  const loadPackageSelf = (specifier: string, fromDir: string): string | null => {
    const packageName = packageNameOf(specifier);
    let directory = fromDir;
    while (directory !== "/" && !directory.endsWith("/node_modules")) {
      const pkg = manifest(directory);
      if (pkg) return pkg.name === packageName && pkg.exports !== undefined && pkg.exports !== null ? loadPackageExports(directory, pkg, specifier, packageName) : null;
      directory = parent(directory);
    }
    return null;
  };
  // `#name`: the nearest manifest's imports map.
  const loadPackageImports = (specifier: string, fromDir: string): string | null => {
    let directory = fromDir;
    while (directory !== "/" && !directory.endsWith("/node_modules")) {
      const pkg = manifest(directory);
      if (pkg) {
        // The nearest config owns this scope; no imports map there does not authorize a parent map.
        if (!pkg.imports) return null;
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
      directory = parent(directory);
    }
    return null;
  };

  const resolve = (specifier: string, fromDir: string, keeping?: ResolutionKept): string | null => {
    // Without a process's own store, manifests are read once per resolution and never kept across: this resolver
    // outlives processes, the tree changes under it, an install links a package in. A process's store keeps the
    // ones it read, and proved absences, as Node's does. Callers without a process owner retain no configs.
    manifests.clear();
    asked.clear();
    digests.clear();
    undigested.clear();
    const outer = kept;
    kept = keeping;
    if (keeping) keeping.carried = undefined;
    try {
      const found = resolveCached(specifier, fromDir);
      // The digest is of the file the stat reached with links followed, so it is the real path's too.
      const digest = found ? digestOf(found) : undefined;
      const carry = (path: string): string => { if (digest !== undefined && keeping) keeping.carried = { path, digest }; return path; };
      // Node answers the real path of what it found: a package reached through
      // a link (pnpm lays every dependency under `.pnpm` and links it in) is
      // then walked up from where it really is, so its own dependencies beside
      // it are found. A filesystem without links answers the path itself.
      if (found && fs.realpathSync) {
        const held = kept?.realPaths.get(found);
        if (held !== undefined) return carry(held);
        try { const real = fs.realpathSync(found); kept?.realPaths.set(found, real); return carry(real); } catch { return carry(found); }
      }
      return found ? carry(found) : found;
    } finally { kept = outer; }
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
        // A level with no `node_modules` directory is one probe, as it is in Node (`Module._findPath`:
        // `if (curPath && _stat(curPath) < 1) continue`), not one per name a package there could have had.
        const nodeModules = `${directory === "/" ? "" : directory}/node_modules`;
        const found = isDirectory(nodeModules) ? loadFromNodeModules(nodeModules, specifier) : null;
        if (found) return found;
      }
      if (directory === "/") break;
      directory = parent(directory);
    }
    for (const root of options.globalRoots ?? []) {
      const found = isDirectory(root) ? loadFromNodeModules(root, specifier) : null;
      if (found) return found;
    }
    return null;
  };
  return { resolve };
}
