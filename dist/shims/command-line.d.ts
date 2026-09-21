/**
 * A program and its exact words, as the one line the engine's shell reads.
 *
 * The engine has no `execve`: every child is a command line handed to
 * just-bash, whether it came from `spawn(file, args)` or from `exec(line)`.
 * Turning the first into the second is this file, and it is the engine's
 * process model, not Node's: `child_process.js` never sees it.
 *
 * A spawned child's arguments are exact words, not a command line the shell
 * reads again: quoting an argument only when it held a space let an argument
 * carrying a pipe, a semicolon, an ampersand, a redirection or a quote come
 * apart into shell syntax, and a program handed `--spec a|b|c` received
 * `--spec a` and two commands it never asked for.
 */
/** Where the engine's node is, the path `process.execPath` reports. */
export declare const __substrateExecPath = "/usr/local/bin/node";
/** One word, quoted where the shell would otherwise read it as syntax. */
export declare function __substrateShellWord(word: string): string;
/**
 * The program a caller named, as the engine's shell knows it. Node's own tests
 * and every tool that re-runs itself spawn `process.execPath`, and the engine's
 * shell has no file there: `spawnSync(process.execPath, ...)` answered
 * "No such file or directory". The one node this runtime has is its own, and
 * that is what a path naming a node binary means here.
 */
export declare function __substrateProgramName(file: string): string;
/** The line the engine's shell reads for a program and its words. */
export declare function __substrateCommandLine(file: string, args: string[]): string;
/**
 * Node's `normalizeSpawnArguments` with a truthy `shell` answers
 * `file: '/bin/sh'`, `args: ['/bin/sh', '-c', line]`, and the line is already
 * shell syntax: `exec`, `execSync` and every `{ shell: true }` spawn arrive
 * that way. Quoting it a second time would hand the shell its own quotes.
 */
export declare function __substrateShellLine(file: string, argv: string[]): string | null;
export declare function setProgramResolver(resolve: (file: string, cwd?: string) => string): void;
/**
 * The line a run of `file` with `argv` is, where argv[0] is the file as Node
 * builds it. A shell invocation is its own `-c` line; anything else is the
 * program and its words, each quoted.
 */
export declare function __substrateLineFor(file: string, argv: string[], cwd?: string): string;
//# sourceMappingURL=command-line.d.ts.map