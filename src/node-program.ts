/**
 * THE START OF A `node` PROGRAM'S PROCESS (ADR-0018 §2, §7, item 9). Where the realm's process is `node` on libuv's
 * loop, the realm is the process's: this is what `node::Start` does between libuv's start and `uv_run`, as an embedder
 * does it (src/node.cc StartExecution with a callback): Node's process object, Node's bootstrap on the realm's own
 * global, its pre-execution with the module loaders left to the embedder, and then the embedder's entry, which is the
 * engine's loader (runtime.ts): the run's preloads, then its file or its `-e` source. The process runs on from there;
 * its end is libuv's, the run's `beforeExit`, `exit` and code given to `main` (`attachLibnodeRun`).
 */
import { Runtime, setProcessConsole, __substratePendingOf } from './runtime';
import type { VirtualFS } from './virtual-fs';
import type { ProcessCredentials } from './process-credentials';
import type { ModuleEvaluationObserver } from './runtime';
import { attachLibnodeRun, libnode } from './node-lib/binding/libnode';
import { adoptRealmLoaders, engineBindingFor } from './node-lib/load';
import { bootstrapNodeRealm, createNodeProcessObject, prepareNodeMainThread, type NodeRealm } from './node-lib/realm';
import { nodeOptionsWords } from './node-lib/binding/options';
import { NODE_LTS_VERSION, nodeRelease, nodeVersions } from './node-lib/node-versions';
import { utilBinding } from './node-lib/binding/util';
import { withGuestCallback } from './guest-loop';
import { __onUncaughtException, type Process } from './shims/process';
import { __recordRun, enterRun, setRunPid, runWaiterOf, type ProcessToken } from './process-tokens';
import { resolve as resolvePath } from './shims/path';
import { __substrateExecPath } from './shims/command-line';

/** The run as the engine's command line read it (child_process.ts `launchNode`). */
export interface NodeProgramLaunch {
  readonly tree: VirtualFS;
  /** The whole vector: `argv[0]` the program's name, then Node's options, the script and its arguments. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly credentials: ProcessCredentials;
  readonly token: ProcessToken | null;
  readonly moduleEvaluationObserver?: ModuleEvaluationObserver;
  /** Node's options before the script, `process.execArgv`. */
  readonly execArgv: readonly string[];
  /** The script's word, where there is one, and the words after it. */
  readonly script?: string;
  readonly scriptArgs: readonly string[];
  /** `-e` or `-p`'s source. */
  readonly evaluated: { source: string; print: boolean } | null;
  /** The file the script's word names, as `require` resolves it. */
  readonly resolvedPath: string | null;
  readonly preloads: readonly string[];
  readonly imports: readonly string[];
}

/** Environment's exit_info (src/env.h ExitInfoField). */
const kExiting = 0, kExitCode = 1, kHasExitCode = 2;

/**
 * The process starts: its bootstrap, then its preloads and its entry. Answers once its entry has run; the process runs
 * on, and ends at the program's exit.
 */
export async function startNodeProgram(launch: NodeProgramLaunch): Promise<void> {
  const program = libnode();
  const exports = program.exports;
  const env: Record<string, string | undefined> = { ...launch.env };
  let realm: NodeRealm | undefined;
  /** A synchronous write to fd 2, as FPrintF(stderr) and fflush make one: the program's write(2) through libuv's fs. */
  const writeStderr = (text: string): void => {
    (engineBindingFor(process, 'fs') as { writeString(fd: number, text: string, position: null, encoding: string): number })
      .writeString(2, text, null, 'utf8');
  };
  const process = createNodeProcessObject({
    version: `v${NODE_LTS_VERSION}`, versions: { ...nodeVersions() }, arch: 'x64', platform: 'linux', release: nodeRelease(),
    rawDebug: writeStderr,
  }) as unknown as Process & Record<string, unknown>;
  const exitInfo = process[utilBinding.privateSymbols.exit_info_private_symbol as unknown as string] as Int32Array;
  const pid = exports.tabnode_getpid();
  const runToken = launch.token;
  if (runToken !== null) setRunPid(runToken, pid, runWaiterOf(runToken) ?? exports.tabnode_getppid(), { argv: [...launch.argv], cwd: launch.cwd, env: launch.env });

  const runtime = new Runtime(launch.tree, {
    process,
    cwd: launch.cwd,
    credentials: launch.credentials,
    pid,
    ...(launch.moduleEvaluationObserver ? { moduleEvaluationObserver: launch.moduleEvaluationObserver } : {}),
  });
  const inRun = <T>(fn: () => T): T => (runToken === null ? fn() : enterRun(runToken, fn));
  // TriggerUncaughtException (src/node_errors.cc), the errors binding's.
  const uncaught = (error: unknown, fromPromise = false): void => {
    (realm!.internalBinding('errors') as { triggerUncaughtException(error: unknown, fromPromise: boolean): void })
      .triggerUncaughtException(error, fromPromise);
  };
  // The argv Node's C++ holds: the program's name, then, for a file, the script as the command line named it,
  // resolved as prepareMainThreadExecution's expandArgv1 resolves it, or, for `-e`, the source's arguments.
  const argv = launch.evaluated !== null
    ? [launch.argv[0] ?? 'node', ...launch.scriptArgs]
    : [launch.argv[0] ?? 'node', resolvePath(launch.cwd, launch.script!), ...launch.scriptArgs];
  realm = inRun(() => bootstrapNodeRealm(process, {
    env, argv, execArgv: launch.execArgv, execPath: __substrateExecPath, nodeOptions: nodeOptionsWords(env.NODE_OPTIONS), pid,
    ppid: () => exports.tabnode_getppid(),
    dlopen: (...args: unknown[]) => runtime.dlopen(...args),
    writeStderr,
    loadEnvFile: (path: string) => loadEnvFile(process, path),
    timeoutCount: () => timeoutCount(process),
    immediateRefCount: () => immediateRefCount(process),
    engineBinding: (name: string) => engineBindingFor(process, name),
    adopt: (loaders) => adoptRealmLoaders(process, loaders),
  }));
  setProcessConsole(process, (globalThis as unknown as { console: Console }).console);
  if (runToken !== null) {
    __recordRun(runToken, {
      process,
      stdout: (chunk) => { (process.stdout as unknown as { write(chunk: unknown): void }).write(chunk); },
      stderr: (chunk) => { (process.stderr as unknown as { write(chunk: unknown): void }).write(chunk); },
      pendingTimers: () => 0,
      stopTimers: () => {},
      reportUncaught: (error: unknown) => { uncaught(error); return true; },
    });
  }
  __onUncaughtException(process, (error) => uncaught(error));
  inRun(() => prepareNodeMainThread(realm!));

  // The run's end (item 9): what SpinEventLoopInternal does once uv_run returns (src/api/embed_helpers.cc), each
  // emission ProcessEmit's MakeCallback (src/node_process_events.cc), its throw the process's uncaught exception.
  let entryPending = true;
  let exitEmissionFailed = false;
  const processEmit = (event: string, code: number): void => {
    inRun(() => { withGuestCallback(() => (process.emit as (event: string, code: number) => boolean).call(process, event, code), 'process', event); });
  };
  const exitCodeOr = (fallback: number): number => (exitInfo[kHasExitCode] ? exitInfo[kExitCode]! : fallback);
  attachLibnodeRun({
    // EmitProcessBeforeExit (src/api/hooks.cc): 'beforeExit' with the exit code, kNoFailure where none; nonzero where
    // the emission failed, where Node's loop stops.
    beforeExit: () => {
      try { processEmit('beforeExit', exitCodeOr(0)); return 0; }
      catch (error) { uncaught(error); return 1; }
    },
    // EmitProcessExitInternal (src/api/hooks.cc): the process exiting; its code, kUnsettledTopLevelAwait where it had
    // none and its entry's top-level await is unsettled; 'exit' with it.
    emitExit: () => {
      exitInfo[kExiting] = 1;
      let code = exitCodeOr(0);
      if (code === 0 && entryPending) { code = 13; exitInfo[kExitCode] = 13; exitInfo[kHasExitCode] = 1; }
      try { processEmit('exit', code); }
      catch (error) { exitEmissionFailed = true; uncaught(error); }
    },
    // The code its listeners left (hooks.cc), or kGenericUserError where the emission failed (node_main_instance.cc).
    exitCode: () => (exitEmissionFailed ? 1 : exitCodeOr(0)),
  });

  if (launch.preloads.length > 0 || launch.imports.length > 0) {
    try { await inRun(() => runtime.preloadModules(launch.preloads, launch.imports)); }
    catch (error) { uncaught(error); }
  }
  // The embedder's entry: the run's file, or its `-e` source as `[eval]` in its directory; `-p` prints its value.
  let settling: Promise<unknown> | undefined;
  try {
    const entry = (): { exports: unknown } => launch.evaluated !== null
      ? runtime.evaluate(
        launch.evaluated.print ? `console.log(eval(${JSON.stringify(launch.evaluated.source)}));` : launch.evaluated.source,
        resolvePath(launch.cwd, '[eval]'),
      )
      : runtime.runFile(launch.resolvedPath!);
    settling = __substratePendingOf(inRun(entry).exports);
  } catch (error) {
    uncaught(error);
  }
  // An entry still settling (a top-level `await`) that rejects is a rejection nobody handles, as Node's entry
  // promise's is (lib/internal/modules/run_main.js).
  if (settling) {
    settling.then(() => { entryPending = false; }, (error: unknown) => { entryPending = false; uncaught(error, true); });
  } else entryPending = false;
}

/** LoadEnvFile (src/node_process_methods.cc) over Node's Dotenv: each variable the environment does not hold. */
function loadEnvFile(process: Record<string, unknown>, path: string): void {
  const fs = engineBindingFor(process, 'fs') as { readFileUtf8(path: string, flags: number): string };
  const util = engineBindingFor(process, 'util') as { parseEnv(content: string): Record<string, string> };
  let content: string;
  try { content = fs.readFileUtf8(path, 0); }
  catch {
    const errno = 2;
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { errno: -errno, code: 'ENOENT', syscall: 'open', path });
  }
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(util.parseEnv(content))) {
    if (env[key] === undefined) env[key] = value;
  }
}

/** Environment::timeout_info()[0]: the referenced timers, as Node's `internal/timers` counts them in `timeoutInfo`. */
function timeoutCount(process: Record<string, unknown>): number {
  const timers = engineBindingFor(process, 'timers') as { timeoutInfo?: Int32Array };
  return timers.timeoutInfo?.[0] ?? 0;
}

/** ImmediateInfo's kRefCount (src/env.h): the referenced immediates, `immediateInfo[1]`. */
function immediateRefCount(process: Record<string, unknown>): number {
  const timers = engineBindingFor(process, 'timers') as { immediateInfo?: Uint32Array };
  return timers.immediateInfo?.[1] ?? 0;
}
