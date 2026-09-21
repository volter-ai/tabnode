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
export const __substrateExecPath = '/usr/local/bin/node';

/** One word, quoted where the shell would otherwise read it as syntax. */
export function __substrateShellWord(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'";
}

/**
 * The program a caller named, as the engine's shell knows it. Node's own tests
 * and every tool that re-runs itself spawn `process.execPath`, and the engine's
 * shell has no file there: `spawnSync(process.execPath, ...)` answered
 * "No such file or directory". The one node this runtime has is its own, and
 * that is what a path naming a node binary means here.
 */
export function __substrateProgramName(file: string): string {
  const execPath = typeof process !== 'undefined' && process !== null && typeof (process as { execPath?: string }).execPath === 'string'
    ? (process as { execPath: string }).execPath
    : __substrateExecPath;
  if (file === execPath || file === __substrateExecPath) return 'node';
  if (file.includes('/') && file.slice(file.lastIndexOf('/') + 1) === 'node') return 'node';
  return file;
}

/** The line the engine's shell reads for a program and its words. */
export function __substrateCommandLine(file: string, args: string[]): string {
  const program = __substrateShellWord(__substrateProgramName(file));
  return args.length > 0 ? `${program} ${args.map((arg) => __substrateShellWord(String(arg))).join(' ')}` : program;
}

/**
 * Node's `normalizeSpawnArguments` with a truthy `shell` answers
 * `file: '/bin/sh'`, `args: ['/bin/sh', '-c', line]`, and the line is already
 * shell syntax: `exec`, `execSync` and every `{ shell: true }` spawn arrive
 * that way. Quoting it a second time would hand the shell its own quotes.
 */
export function __substrateShellLine(file: string, argv: string[]): string | null {
  const program = file.includes('/') ? file.slice(file.lastIndexOf('/') + 1) : file;
  if (program !== 'sh' && program !== 'bash' && program !== 'dash' && program !== 'zsh') return null;
  const dashC = argv.indexOf('-c');
  if (dashC < 1 || typeof argv[dashC + 1] !== 'string') return null;
  return argv[dashC + 1] as string;
}

/**
 * How a path a caller named becomes the program the engine will run. The
 * engine's process model installs it when it knows the filesystem; until then
 * a path is itself.
 */
let resolveProgram: (file: string, cwd?: string) => string = (file) => file;
export function setProgramResolver(resolve: (file: string, cwd?: string) => string): void {
  resolveProgram = resolve;
}

/**
 * The line a run of `file` with `argv` is, where argv[0] is the file as Node
 * builds it. A shell invocation is its own `-c` line; anything else is the
 * program and its words, each quoted.
 */
export function __substrateLineFor(file: string, argv: string[], cwd?: string): string {
  const shell = __substrateShellLine(file, argv);
  if (shell !== null) return shell;
  return __substrateCommandLine(resolveProgram(file, cwd), argv.slice(1));
}
