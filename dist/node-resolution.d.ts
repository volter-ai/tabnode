export interface ResolutionFs {
    existsSync(path: string): boolean;
    statSync(path: string): {
        isFile(): boolean;
        isDirectory(): boolean;
    };
    readFileSync(path: string, encoding: "utf8"): string | Uint8Array;
    realpathSync?(path: string): string;
}
export interface ExportsResolver {
    /** `resolve.exports`'s `resolve(pkg, entry, options)`: package exports or imports, by conditions. */
    resolve(pkg: unknown, entry: string, options?: {
        conditions?: readonly string[];
        unsafe?: boolean;
        require?: boolean;
        browser?: boolean;
    }): string[] | string | void;
    imports(pkg: unknown, entry: string, options?: {
        conditions?: readonly string[];
        unsafe?: boolean;
        require?: boolean;
        browser?: boolean;
    }): string[] | string | void;
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
export declare function createNodeResolver(options: NodeResolverOptions): NodeResolver;
//# sourceMappingURL=node-resolution.d.ts.map