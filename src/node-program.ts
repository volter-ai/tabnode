/**
 * THE START OF A `node` PROGRAM'S PROCESS (ADR-0018 §2, §7, item 9). Where the realm's process is `node` on libuv's
 * loop, the realm is the process's, and this is what `node::Start` does between libuv's start and `uv_run`: the
 * command line read as Node's options parser reads it, Node's process object, Node's bootstrap on the realm's own
 * global, and the main script `StartExecution` selects (src/node.cc), run as Node runs it, which prepares the process
 * (`prepareMainThreadExecution`) and runs its entry through Node's own module loaders. The process runs on from there;
 * its end is libuv's, the run's `beforeExit`, `exit` and code given to `main` (`attachLibnodeRun`).
 */
import type { VirtualFS } from './virtual-fs';
import { attachLibnodeRun, libnode, reallyExit } from './node-lib/binding/libnode';
import { adoptRealmLoaders, engineBindingFor } from './node-lib/load';
import { bootstrapNodeRealm, createNodeProcessObject, runNodeMain, type NodeRealm } from './node-lib/realm';
import { nodeOptionsWords, splitCommandLine } from './node-lib/binding/options';
import { NODE_LTS_VERSION, nodeRelease, nodeVersions } from './node-lib/node-versions';
import { utilBinding } from './node-lib/binding/util';
import { realEnvStore } from './node-lib/binding/env_var';
import { setPreparedTree } from './node-lib/v8-host';
import { startGuestLoop, withGuestCallback } from './guest-loop';
import { installGuestRealm } from './host-globals';
import { recordProcessHostname, recordProcessHosts } from './process-hostname';
import { __onUncaughtException } from './shims/process';
import { __recordRun, enterRun, setRunPid, runWaiterOf, type ProcessToken } from './process-tokens';
import { __substrateExecPath } from './shims/command-line';
import { dlopenNative } from './native-addon';

/** The run as the host asks for it: the program's tree, its whole vector, and the directory and environment it was exec'd with (the process's own are libc's). */
export interface NodeProgramLaunch {
  readonly tree: VirtualFS;
  /** The whole vector, as `execve` takes it: `argv[0]` the program's name, then Node's options, the script and its arguments. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly token: ProcessToken | null;
}

/** Environment's exit_info (src/env.h ExitInfoField). */
const kExiting = 0, kExitCode = 1, kHasExitCode = 2;
/** kInvalidCommandLineArgument (src/node_exit_code.h). */
const kInvalidCommandLineArgument = 9;

/** The process starts: its options, its bootstrap, then its main script. The process runs on; it ends at its exit. */
export function startNodeProgram(launch: NodeProgramLaunch): void {
  const exports = libnode().exports;
  let realm: NodeRealm | undefined;
  /** A synchronous write to fd 2, as FPrintF(stderr) and fflush make one: the program's write(2) through libuv's fs. */
  const writeStderr = (text: string): void => {
    (engineBindingFor(process, 'fs') as { writeString(fd: number, text: string, position: null, encoding: string): number })
      .writeString(2, text, null, 'utf8');
  };
  const process = createNodeProcessObject({
    version: `v${NODE_LTS_VERSION}`, versions: { ...nodeVersions() }, arch: 'x64', platform: 'linux', release: nodeRelease(),
    rawDebug: writeStderr,
  });
  // The process's tree, which the bindings over it read (its sockets, its descriptors, its blob files), its hostname
  // and its hosts files, and the store its prepared bodies are kept in.
  (process as Record<symbol, unknown>)[Symbol.for('tabnode.run.vfs')] = launch.tree;
  const hostname = launch.tree.processHostname?.bind(launch.tree);
  recordProcessHostname(process, hostname ?? (() => 'localhost'));
  const readHostFile = launch.tree.readFileSync.bind(launch.tree);
  recordProcessHosts(process, (path) => {
    const content = readHostFile(path, 'utf8');
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  });
  setPreparedTree(launch.tree as unknown as Parameters<typeof setPreparedTree>[0]);
  startGuestLoop();
  installGuestRealm();

  // ProcessGlobalArgs (src/node.cc): the command line's options split from the script and its arguments; a bad option
  // ends the process with kInvalidCommandLineArgument before anything runs.
  const nodeOptions = nodeOptionsWords(realEnvStore.get('NODE_OPTIONS'));
  const split = splitCommandLine(launch.argv);
  if ('error' in split) {
    writeStderr(`${launch.argv[0] ?? 'node'}: ${split.error}\n`);
    reallyExit(kInvalidCommandLineArgument);
    return;
  }
  const exitInfo = process[utilBinding.privateSymbols.exit_info_private_symbol as unknown as string] as Int32Array;
  const pid = exports.tabnode_getpid();
  const runToken = launch.token;
  if (runToken !== null) setRunPid(runToken, pid, runWaiterOf(runToken) ?? exports.tabnode_getppid(), { argv: [...launch.argv], cwd: launch.cwd, env: launch.env });
  const inRun = <T>(fn: () => T): T => (runToken === null ? fn() : enterRun(runToken, fn));
  // TriggerUncaughtException (src/node_errors.cc), the errors binding's.
  const uncaught = (error: unknown, fromPromise = false): void => {
    (realm!.internalBinding('errors') as { triggerUncaughtException(error: unknown, fromPromise: boolean): void })
      .triggerUncaughtException(error, fromPromise);
  };
  realm = inRun(() => bootstrapNodeRealm(process, {
    argv: split.argv, execArgv: split.execArgv, execPath: __substrateExecPath, nodeOptions, pid,
    ppid: () => exports.tabnode_getppid(),
    writeStderr,
    dlopen: (...args: unknown[]) => dlopen(process, launch.tree, args),
    loadEnvFile: (path: string) => loadEnvFile(process, path),
    timeoutCount: () => (engineBindingFor(process, 'timers') as { timeoutInfo?: Int32Array }).timeoutInfo?.[0] ?? 0,
    immediateRefCount: () => (engineBindingFor(process, 'timers') as { immediateInfo?: Uint32Array }).immediateInfo?.[1] ?? 0,
    engineBinding: (name: string) => engineBindingFor(process, name),
    adopt: (loaders) => adoptRealmLoaders(process, loaders),
  }));
  if (runToken !== null) {
    __recordRun(runToken, {
      process: process as never,
      stdout: (chunk) => { (process.stdout as { write(chunk: unknown): void }).write(chunk); },
      stderr: (chunk) => { (process.stderr as { write(chunk: unknown): void }).write(chunk); },
      pendingTimers: () => 0,
      stopTimers: () => {},
      reportUncaught: (error: unknown) => { uncaught(error); return true; },
    });
  }
  __onUncaughtException(process, (error) => uncaught(error));

  // The run's end (item 9): what SpinEventLoopInternal does once uv_run returns (src/api/embed_helpers.cc), each
  // emission ProcessEmit's MakeCallback (src/node_process_events.cc), its throw the process's uncaught exception.
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
    // none and the entry's promise is unsettled (Environment::CheckUnsettledTopLevelAwait); 'exit' with it.
    emitExit: () => {
      exitInfo[kExiting] = 1;
      let code = exitCodeOr(0);
      if (code === 0 && realm!.entryUnsettled()) { code = 13; exitInfo[kExitCode] = 13; exitInfo[kHasExitCode] = 1; }
      try { processEmit('exit', code); }
      catch (error) { exitEmissionFailed = true; uncaught(error); }
    },
    // The code its listeners left (hooks.cc), or kGenericUserError where the emission failed (node_main_instance.cc).
    exitCode: () => (exitEmissionFailed ? 1 : exitCodeOr(0)),
  });

  // StartExecution: the main script SelectLoadMode picks, run in an InternalCallbackScope.
  inRun(() => {
    try { withGuestCallback(() => runNodeMain(realm!, split.argv), 'entry', 'main'); }
    catch (error) { uncaught(error); }
  });
}

/**
 * binding::DLOpen (src/node_binding.cc): `module` and `module.exports` as objects, the flags an integer, the file the
 * process's, opened as ADR-0011 opens an addon (native-addon.ts), its initializer called on `module.exports`.
 */
function dlopen(process: object, tree: VirtualFS, args: unknown[]): void {
  if (args.length < 2) throw Object.assign(new TypeError('process.dlopen needs at least 2 arguments'), { code: 'ERR_MISSING_ARGS' });
  if (args.length > 2 && !Number.isInteger(Number(args[2]))) {
    throw Object.assign(new TypeError('flag argument must be an integer.'), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  const object = (value: unknown): object => {
    if (value === null || value === undefined) throw new TypeError('Cannot convert undefined or null to object');
    return Object(value) as object;
  };
  const target = object(args[0]) as { exports?: unknown; filename?: unknown };
  const exports = object(target.exports);
  const file = `${args[1]}`;
  let bytes: Uint8Array;
  try { bytes = tree.readFileSync(file) as Uint8Array; }
  catch { throw Object.assign(new Error(`${file}: cannot open shared object file: No such file or directory`), { code: 'ERR_DLOPEN_FAILED' }); }
  dlopenNative(process, target, exports, file, bytes);
}

/** LoadEnvFile (src/node_process_methods.cc) over Node's Dotenv: each variable the process's environment does not hold. */
function loadEnvFile(process: Record<string, unknown>, path: string): void {
  const fs = engineBindingFor(process, 'fs') as { readFileUtf8(path: string, flags: number): string };
  const util = engineBindingFor(process, 'util') as { parseEnv(content: string): Record<string, string> };
  let content: string;
  try { content = fs.readFileUtf8(path, 0); }
  catch {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { errno: -2, code: 'ENOENT', syscall: 'open', path });
  }
  // Dotenv::SetEnvironment (src/node_dotenv.cc): each the store does not hold, set in it.
  for (const [key, value] of Object.entries(util.parseEnv(content))) {
    if (realEnvStore.get(key) === undefined) realEnvStore.set(key, value);
  }
}
