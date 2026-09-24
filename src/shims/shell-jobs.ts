/**
 * The engine's shell runs a statement that ends in `&` in the background, as
 * a POSIX shell does.
 *
 * just-bash, the engine's shell, parses `&` (a statement's `background` flag)
 * and its interpreter never reads it: `node -e '…setTimeout…' & c=$!; echo
 * "bg pid=$c"; wait "$c"` ran the child to its end first, printed its output
 * before `bg pid=0`, `$!` was always 0, `wait` returned 0 at once, and `kill`
 * was "command not found". On a machine the job starts and the script goes on,
 * `$!` is the job's pid, `wait` waits for it and returns its status, and
 * `kill` reaches it.
 *
 * This is built on the doors just-bash offers rather than on a patched copy of
 * it: a transform plugin, which runs on every script the shell executes (the
 * top-level line, `sh -c`, `bash -c`, a script file), and custom commands.
 *
 * - The plugin replaces each background statement with a call of
 *   `__tabnode_bg`, carrying the statement's syntax tree (and the functions the
 *   script defines, which a job may call) as JSON; it renames `$!` to the
 *   variable `__tabnode_bg` sets, and the `wait` builtin (which answers 0 at
 *   once and cannot be overridden) to `__tabnode_wait`.
 * - `__tabnode_bg` starts the statement as a run of the engine's own: a pid
 *   minted in the engine's process table (the one `child_process`, `kill -0`
 *   and `process.kill` read), a run name that a `node` inside the job takes as
 *   its own, so its `process.pid` is `$!`, and a copy of the shell's variables,
 *   as a forked subshell has. It returns at once.
 * - `__tabnode_wait` waits for the jobs of the shell it runs in (all, `-n` the
 *   next, or the pids named) and answers the status of the last one: an exit
 *   code, or 128 plus the signal that ended it. `kill` delivers a signal to any
 *   process of the engine by pid; `disown` forgets a job.
 *
 * A job's output reaches the host's streams as it is written, and the text the
 * shell's own run collects at the next `wait`, since the shell's result is the
 * concatenation of its commands' results. What the plugin cannot see, it leaves
 * as it was: `eval`'s text is not a script the plugin is shown.
 */
import { defineCommand } from 'just-bash';
import type { Bash, CommandContext } from 'just-bash';
import {
  PROCESS_TOKEN_ENV, enterRun, mintPid, setRunPid, runPid, forgetRunPid, pidIsLive, signalPid,
  tokenOfPid, __signalOwnedProcess, __stopOwnedProcess, type ProcessToken,
} from '../process-tokens';
import { __substrateChildren, __substrateSignals, __substrateSignalNames } from './process';
import { __releaseOwnedServers, __releaseOwnedHandles } from '../node-lib/net-module';
import type { RunStreams } from './child_process';
import { unstreamedOutput } from './streamed-output';

/** What the engine's process model gives this module. */
export interface ShellJobsHost {
  runTokenOf(ctx: CommandContext): ProcessToken | null;
  runStreamsFor(token: ProcessToken): RunStreams | undefined;
  registerRunStreams(token: ProcessToken, streams: RunStreams): void;
  releaseRunStreams(token: ProcessToken): void;
}

/** The variable `$!` is read from once the plugin has renamed it. */
const LAST_JOB_VAR = '__TABNODE_LAST_JOB_PID';
/** The variable naming the shell a job belongs to; `sh -c` does not inherit it (it is not exported), a subshell copy does. */
const SHELL_VAR = '__TABNODE_SHELL';
const BG_COMMAND = '__tabnode_bg';
const WAIT_COMMAND = '__tabnode_wait';
const JOB_PLACEHOLDER = '__tabnode_job';
/** How much of its jobs' output a shell holds for its next `wait`; the rest still reached the host's streams. */
const PENDING_LIMIT = 1 << 20;
/** Signals whose default action is to do nothing. */
const IGNORED_BY_DEFAULT = new Set(['SIGCHLD', 'SIGCONT', 'SIGURG', 'SIGWINCH']);

interface Job {
  pid: number;
  token: ProcessToken;
  status: number | null;
  done: Promise<number>;
  kill(signal: string): boolean;
}
interface Shell { jobs: Map<number, Job>; order: number[]; pendingOut: string; pendingErr: string }

type Node = Record<string, unknown>;

const shells = new Map<string, Shell>();
/** A job's script, from `__tabnode_bg` to the plugin, taken once. */
const handoff = new Map<string, Node>();
let nextShell = 1;
let nextJob = 1;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null;
}

function literalWord(value: string): Node {
  return { type: 'Word', parts: [{ type: 'Literal', value }] };
}

function wordLiteral(word: unknown): string | null {
  if (!isNode(word) || !Array.isArray(word.parts) || word.parts.length !== 1) return null;
  const part = word.parts[0];
  return isNode(part) && part.type === 'Literal' && typeof part.value === 'string' ? part.value : null;
}

/** A statement whose one command defines a function. */
function definesFunction(statement: Node): boolean {
  const pipelines = statement.pipelines;
  return Array.isArray(pipelines) && pipelines.some((pipeline) => isNode(pipeline) && Array.isArray(pipeline.commands)
    && pipeline.commands.some((command) => isNode(command) && command.type === 'FunctionDef'));
}

/** Every function definition in a script, outside the background statements (a job carries its own). */
function functionDefinitions(node: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(node)) { for (const child of node) functionDefinitions(child, found); return found; }
  if (!isNode(node)) return found;
  if (node.type === 'Statement' && node.background === true) return found;
  if (node.type === 'Statement' && definesFunction(node)) found.push(node);
  for (const key of Object.keys(node)) functionDefinitions(node[key], found);
  return found;
}

/**
 * The rewrite, in place: a background statement becomes a call of
 * `__tabnode_bg` (its own subtree is not descended into; the job's script is
 * rewritten when it runs), `$!` reads the job variable, `wait` is the job
 * table's.
 */
function rewrite(node: unknown, functions: string): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const child = node[index];
      if (isNode(child) && child.type === 'Statement' && child.background === true) {
        node[index] = backgroundCall(child, functions);
      } else rewrite(child, functions);
    }
    return;
  }
  if (!isNode(node)) return;
  if (node.type === 'ParameterExpansion' && node.parameter === '!') node.parameter = LAST_JOB_VAR;
  if (node.type === 'SimpleCommand' && wordLiteral(node.name) === 'wait') node.name = literalWord(WAIT_COMMAND);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (isNode(child) && child.type === 'Statement' && child.background === true) node[key] = backgroundCall(child, functions);
    else rewrite(child, functions);
  }
}

function backgroundCall(statement: Node, functions: string): Node {
  const job = JSON.stringify({ ...statement, background: false });
  return {
    type: 'Statement',
    pipelines: [{
      type: 'Pipeline',
      commands: [{
        type: 'SimpleCommand',
        name: literalWord(BG_COMMAND),
        args: [{ type: 'Word', parts: [{ type: 'SingleQuoted', value: job }] }, { type: 'Word', parts: [{ type: 'SingleQuoted', value: functions }] }],
        assignments: [],
        redirections: [],
      }],
      negated: false,
      timed: false,
      timePosix: false,
    }],
    operators: [],
    background: false,
    ...(typeof statement.sourceText === 'string' ? { sourceText: statement.sourceText } : {}),
  };
}

/** The plugin: a job's own script is taken from the handoff, and every script is rewritten. */
function transform({ ast }: { ast: Node }): { ast: Node } {
  let script = ast;
  const statements = Array.isArray(ast.statements) ? ast.statements : [];
  if (statements.length === 1 && isNode(statements[0])) {
    const pipelines = statements[0].pipelines;
    const command = Array.isArray(pipelines) && isNode(pipelines[0]) && Array.isArray(pipelines[0].commands) ? pipelines[0].commands[0] : undefined;
    if (isNode(command) && command.type === 'SimpleCommand' && wordLiteral(command.name) === ':' && Array.isArray(command.args)
      && command.args.length === 2 && wordLiteral(command.args[0]) === JOB_PLACEHOLDER) {
      const token = wordLiteral(command.args[1]);
      const own = token === null ? undefined : handoff.get(token);
      if (own && token !== null) { handoff.delete(token); script = own; }
    }
  }
  if (!Array.isArray(script.statements) || !JSON.stringify(script).match(/"background":true|"parameter":"!"|"value":"wait"/u)) return { ast: script };
  const functions = JSON.stringify(functionDefinitions(script.statements));
  rewrite(script.statements, functions);
  return { ast: script };
}

function shellOf(ctx: CommandContext): { id: string; shell: Shell } {
  let id = ctx.env.get(SHELL_VAR);
  if (!id) { id = `shell-${nextShell++}`; ctx.env.set(SHELL_VAR, id); }
  let shell = shells.get(id);
  if (!shell) { shell = { jobs: new Map(), order: [], pendingOut: '', pendingErr: '' }; shells.set(id, shell); }
  return { id, shell };
}

function signalNumber(name: string): number {
  return __substrateSignals[name] ?? 15;
}

/** `-TERM`, `-SIGTERM`, `TERM`, `15`, `-15` to Node's name, or null. */
function signalName(spec: string): string | null {
  const bare = spec.startsWith('-') ? spec.slice(1) : spec;
  if (/^\d+$/u.test(bare)) {
    const number = Number(bare);
    if (number === 0) return '0';
    return __substrateSignalNames[number > 128 ? number - 128 : number] ?? null;
  }
  const upper = bare.toUpperCase();
  const name = upper.startsWith('SIG') ? upper : `SIG${upper}`;
  return __substrateSignals[name] !== undefined ? name : null;
}

function startJob(host: ShellJobsHost, ctx: CommandContext, shell: Shell, script: Node, sourceText: string): Job {
  const token: ProcessToken = `job-${nextJob++}`;
  const parent = host.runTokenOf(ctx);
  const parentPid = runPid(parent)?.pid;
  const pid = mintPid();
  setRunPid(token, pid, parentPid !== undefined && pidIsLive(parentPid) ? parentPid : 0, { argv: ['sh', '-c', sourceText], cwd: ctx.cwd });
  const controller = new AbortController();
  let streamedOut: string[] = [];
  let streamedErr: string[] = [];
  const live = (): RunStreams | undefined => (parent === null ? undefined : host.runStreamsFor(parent));
  host.registerRunStreams(token, {
    onStdout: (data: string) => { streamedOut.push(data); live()?.onStdout?.(data); },
    onStderr: (data: string) => { streamedErr.push(data); live()?.onStderr?.(data); },
    signal: controller.signal,
    held: false,
  });
  let settle: (status: number) => void = () => {};
  const job: Job = {
    pid,
    token,
    status: null,
    done: new Promise<number>((resolve) => { settle = resolve; }),
    kill(signal: string): boolean {
      if (job.status !== null) return false;
      // A `node` of the job, here or in a realm of its own, takes the signal
      // as a process does: its listeners, else its default action, which ends
      // the job with it.
      if (__signalOwnedProcess(token, signal) || signalPid(pid, signal)) return true;
      if (IGNORED_BY_DEFAULT.has(signal)) return true;
      // Nothing of the job's receives signals (a builtin, `sleep`): it ends
      // now, as a killed child's run ends, and reports the signal.
      controller.abort(signal);
      __releaseOwnedServers(token, false);
      __releaseOwnedHandles(token);
      __stopOwnedProcess(token);
      end(128 + signalNumber(signal));
      return true;
    },
  };
  const end = (status: number): void => {
    if (job.status !== null) return;
    job.status = status;
    host.releaseRunStreams(token);
    forgetRunPid(token);
    __substrateChildren.delete(pid);
    settle(status);
  };
  const hold = (text: string, key: 'pendingOut' | 'pendingErr'): void => {
    if (!text) return;
    const room = PENDING_LIMIT - shell[key].length;
    if (room > 0) shell[key] += text.slice(0, room);
  };
  const env: Record<string, string> = Object.fromEntries(ctx.env);
  delete env[SHELL_VAR];
  env[PROCESS_TOKEN_ENV] = token;
  handoff.set(token, script);
  __substrateChildren.set(pid, {
    get exitCode() { return job.status; },
    signalCode: null,
    kill: (signal = 'SIGTERM') => job.kill(signal),
  } as { exitCode: number | null; signalCode: string | null; kill(signal?: string): boolean });
  const run = ctx.exec
    ? enterRun(token, () => ctx.exec!(`: ${JOB_PLACEHOLDER} ${token}`, { env, cwd: ctx.cwd, replaceEnv: true, signal: controller.signal }))
    : Promise.resolve({ stdout: '', stderr: 'bash: background jobs need a shell that can run a script\n', exitCode: 1 });
  void Promise.resolve(run).then(
    (result) => {
      handoff.delete(token);
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const restOut = unstreamedOutput(stdout, streamedOut);
      const restErr = unstreamedOutput(stderr, streamedErr);
      if (restOut) live()?.onStdout?.(restOut);
      if (restErr) live()?.onStderr?.(restErr);
      hold(stdout, 'pendingOut');
      hold(stderr, 'pendingErr');
      streamedOut = [];
      streamedErr = [];
      end(result.exitCode ?? 0);
    },
    (error: unknown) => {
      handoff.delete(token);
      const text = `${error instanceof Error ? error.message : String(error)}\n`;
      live()?.onStderr?.(text);
      hold(text, 'pendingErr');
      end(1);
    },
  );
  return job;
}

/** The job's output held for the shell's next `wait`, taken. */
function flush(shell: Shell): { stdout: string; stderr: string } {
  const taken = { stdout: shell.pendingOut, stderr: shell.pendingErr };
  shell.pendingOut = '';
  shell.pendingErr = '';
  return taken;
}

/** The engine's shell, given background jobs. */
export function installShellJobs(bash: Bash, host: ShellJobsHost): void {
  (bash as unknown as { registerTransformPlugin(plugin: { name: string; transform: typeof transform }): void })
    .registerTransformPlugin({ name: 'tabnode-background-jobs', transform });

  bash.registerCommand(defineCommand(BG_COMMAND, async (args, ctx) => {
    let statement: Node;
    let functions: Node[];
    try {
      statement = JSON.parse(args[0] ?? '') as Node;
      functions = JSON.parse(args[1] ?? '[]') as Node[];
    } catch {
      return { stdout: '', stderr: `bash: ${BG_COMMAND}: not a job\n`, exitCode: 2 };
    }
    const { shell } = shellOf(ctx);
    const script: Node = { type: 'Script', statements: [...functions, statement] };
    const job = startJob(host, ctx, shell, script, typeof statement.sourceText === 'string' ? statement.sourceText : '');
    shell.jobs.set(job.pid, job);
    shell.order.push(job.pid);
    ctx.env.set(LAST_JOB_VAR, String(job.pid));
    return { stdout: '', stderr: '', exitCode: 0 };
  }));

  bash.registerCommand(defineCommand(WAIT_COMMAND, async (args, ctx) => {
    const { id, shell } = shellOf(ctx);
    let stderr = '';
    let status = 0;
    let next = false;
    const targets: string[] = [];
    for (const arg of args) {
      if (arg === '-n') next = true;
      else if (arg === '-f' || arg === '--') continue;
      else targets.push(arg);
    }
    const aborted = new Promise<'aborted'>((resolve) => {
      if (ctx.signal?.aborted) resolve('aborted');
      ctx.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const running = (): Job[] => shell.order.map((pid) => shell.jobs.get(pid)).filter((job): job is Job => job !== undefined && job.status === null);
    const reap = (job: Job): void => {
      shell.jobs.delete(job.pid);
      shell.order = shell.order.filter((pid) => pid !== job.pid);
    };
    if (next) {
      const pending = targets.length > 0
        ? targets.map((target) => shell.jobs.get(Number(target))).filter((job): job is Job => job !== undefined)
        // A job that has ended and is not yet reaped is the next one, as bash's is.
        : shell.order.map((pid) => shell.jobs.get(pid)).filter((job): job is Job => job !== undefined);
      if (pending.length === 0) status = 127;
      else {
        const first = await Promise.race([...pending.map((job) => job.done.then(() => job)), aborted]);
        if (first === 'aborted') status = 130;
        else { status = first.status ?? 0; reap(first); }
      }
    } else if (targets.length === 0) {
      // Every job the shell has, including one started while waiting on the others.
      for (let jobs = running(); jobs.length > 0; jobs = running()) {
        if (await Promise.race([Promise.all(jobs.map((job) => job.done)), aborted]) === 'aborted') { status = 130; break; }
      }
      for (const pid of [...shell.order]) { const job = shell.jobs.get(pid); if (job && job.status !== null) reap(job); }
    } else {
      for (const target of targets) {
        if (target.startsWith('%')) { stderr += `bash: wait: ${target}: no such job\n`; status = 127; continue; }
        const pid = Number(target);
        const job = Number.isInteger(pid) ? shell.jobs.get(pid) : undefined;
        if (!job) {
          stderr += Number.isInteger(pid) ? `bash: wait: pid ${target} is not a child of this shell\n` : `bash: wait: \`${target}': not a pid or valid job spec\n`;
          status = 127;
          continue;
        }
        const outcome = await Promise.race([job.done, aborted]);
        if (outcome === 'aborted') { status = 130; break; }
        status = outcome;
        reap(job);
      }
    }
    const held = flush(shell);
    if (shell.jobs.size === 0) shells.delete(id);
    return { stdout: held.stdout, stderr: held.stderr + stderr, exitCode: status };
  }));

  bash.registerCommand(defineCommand('kill', async (args) => {
    let signal = 'SIGTERM';
    let index = 0;
    if (args[0] === '-l' || args[0] === '-L') {
      const names = Object.entries(__substrateSignals).sort((a, b) => a[1] - b[1]).map(([name]) => name.slice(3));
      if (args[1] !== undefined) {
        const number = Number(args[1]);
        const name = Number.isInteger(number) ? __substrateSignalNames[number > 128 ? number - 128 : number] : signalName(args[1]);
        if (!name) return { stdout: '', stderr: `bash: kill: ${args[1]}: invalid signal specification\n`, exitCode: 1 };
        return { stdout: `${Number.isInteger(number) ? name.slice(3) : __substrateSignals[name]}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: `${names.join(' ')}\n`, stderr: '', exitCode: 0 };
    }
    if (args[0] === '-s' || args[0] === '-n') {
      const name = args[1] === undefined ? null : signalName(args[1]);
      if (!name) return { stdout: '', stderr: `bash: kill: ${args[1] ?? ''}: invalid signal specification\n`, exitCode: 1 };
      signal = name;
      index = 2;
    } else if (args[0] !== undefined && args[0].startsWith('-') && args[0] !== '--') {
      const name = signalName(args[0]);
      if (!name) return { stdout: '', stderr: `bash: kill: ${args[0].slice(1)}: invalid signal specification\n`, exitCode: 1 };
      signal = name;
      index = 1;
    }
    if (args[index] === '--') index += 1;
    const targets = args.slice(index);
    if (targets.length === 0) return { stdout: '', stderr: 'bash: kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n', exitCode: 2 };
    let stderr = '';
    let status = 0;
    for (const target of targets) {
      if (target.startsWith('%')) { stderr += `bash: kill: ${target}: no such job\n`; status = 1; continue; }
      if (!/^-?\d+$/u.test(target)) { stderr += `bash: kill: ${target}: arguments must be process or job IDs\n`; status = 1; continue; }
      const pid = Math.abs(Number(target));
      if (!deliver(pid, signal)) { stderr += `bash: kill: (${target}) - No such process\n`; status = 1; }
    }
    return { stdout: '', stderr, exitCode: status };
  }));

  bash.registerCommand(defineCommand('disown', async (args, ctx) => {
    const { shell } = shellOf(ctx);
    const pids = args.filter((arg) => !arg.startsWith('-')).map(Number);
    const all = args.includes('-a');
    const chosen = all ? [...shell.order] : pids.length > 0 ? pids : shell.order.slice(-1);
    for (const pid of chosen) { shell.jobs.delete(pid); shell.order = shell.order.filter((own) => own !== pid); }
    return { stdout: '', stderr: '', exitCode: 0 };
  }));
}

/**
 * A signal to a process of the engine by pid, as `kill(2)` delivers one:
 * signal 0 asks whether it is there; a child a guest spawned and a shell's job
 * take it through their handle; any other run of the engine through its
 * process, or through the realm that holds it.
 */
function deliver(pid: number, signal: string): boolean {
  const child = __substrateChildren.get(pid);
  const childLive = child !== undefined && child.exitCode === null && child.signalCode === null;
  if (signal === '0') return childLive || pidIsLive(pid);
  if (childLive) return child.kill(signal);
  const token = tokenOfPid(pid);
  if (token !== null && __signalOwnedProcess(token, signal)) return true;
  return signalPid(pid, signal);
}
