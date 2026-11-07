/**
 * The engine's shell runs a statement that ends in `&` in the background, as
 * a POSIX shell does, as a process of its own (browser-substrate ADR-0227,
 * "What a page program is", "One task per worker").
 *
 * just-bash, the engine's shell, parses `&` (a statement's `background` flag)
 * and its interpreter never reads it. On a machine the job starts and the
 * script goes on, `$!` is the job's pid, `wait` waits for it and returns its
 * status, and `kill` reaches it.
 *
 * This is built on the doors just-bash offers rather than on a patched copy of
 * it: a transform plugin, which runs on every script the shell executes (the
 * top-level line, `sh -c`, `bash -c`, a script file), and custom commands.
 *
 * - The plugin replaces each background statement with a call of
 *   `__tabnode_bg` carrying the statement's own text and two answers the
 *   interpreter gives at that moment, where the `&` runs: `declare -p` (its
 *   variables, their attributes, arrays and associative arrays) and
 *   `declare -F` (its functions). After each function definition it runs, it
 *   keeps the definition's text in a shell variable of that function's
 *   (`FUNCTION_TEXT`), as live as the function, since just-bash's `declare -f`
 *   prints no bodies. It renames `$!` to the variable `__tabnode_bg` sets, and
 *   the `wait` builtin (which answers 0 at once and cannot be overridden) to
 *   `__tabnode_wait`.
 * - `__tabnode_bg` starts the job as bash runs one in a forked subshell, which
 *   no host image can fork (ADR-0227 §6, ENOSYS): a spawn of the shell's own
 *   program (`$BASH`, `SHELL_PROGRAM`) with `-c`, as bash's fork runs the same
 *   shell, through the engine's own child start (the door `spawn` takes). It
 *   carries the shell's state at the `&` as a forked subshell has it, written
 *   ahead of the job's text: its options (`SHELLOPTS`, `BASHOPTS`), its
 *   variables as `declare -p` named them, valued from the live variables, its
 *   aliases, and its functions as `declare -F` named them, each as its
 *   definition last ran; its `$0` and positional parameters are the spawn's
 *   words. just-bash keeps no traps, so none is written. just-bash applies its
 *   transform plugins only in `Bash.exec`, so a function defined by `eval` or
 *   a sourced file has no text kept: a job that would need to carry one is
 *   refused, naming it. A spawn is a new process, not a copy: the job's
 *   `$$` and `$PPID` are its own, and a variable it sets does not reach the
 *   shell. The child is its own process, the host's to run, which no bypass
 *   leaves to the engine's shell; with no host to run it, the start refuses it
 *   and the job fails as a fork does, never run in this realm.
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
import { defineCommand, parse } from 'just-bash';
import type { Bash, CommandContext } from 'just-bash';
import { PROCESS_TOKEN_ENV, pidIsLive, signalPid, tokenOfPid, __signalOwnedProcess, type ProcessToken } from '../process-tokens';
import { __substrateChildrenOf, __substrateSignals, __substrateSignalNames } from './process';
import type { RunStreams } from './child_process';
import type { StartedRun } from '../node-lib/binding/process_wrap';
import { __substrateShellWord } from './command-line';

/** A background job's start, as the engine's child start takes one. */
export interface JobStart {
  owner: ProcessToken | null;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  output(fd: 1 | 2, chunk: string | Uint8Array): void;
  exit(code: number, signal: string | null): void;
}

/** What the engine's process model gives this module. */
export interface ShellJobsHost {
  runTokenOf(ctx: CommandContext): ProcessToken | null;
  runStreamsFor(token: ProcessToken): RunStreams | undefined;
  /** The job started as a child of its shell's run, its own process, the host's to run; it throws where none can. */
  startJob(start: JobStart): StartedRun;
}

/**
 * The engine's shell's own program, where its tree carries it (`/bin/bash`, ADR-0012 §3's installed entry; a host's
 * image carries its own bash there): the shell's `$BASH`, and what runs its jobs.
 */
export const SHELL_PROGRAM = '/bin/bash';

/** The variable `$!` is read from once the plugin has renamed it. */
const LAST_JOB_VAR = '__TABNODE_LAST_JOB_PID';
/** The variable naming the shell a job belongs to; `sh -c` does not inherit it (it is not exported), a subshell copy does. */
const SHELL_VAR = '__TABNODE_SHELL';
const BG_COMMAND = '__tabnode_bg';
/**
 * A function's definition as the shell last ran it, kept beside the definition in a shell variable of the function's
 * own (its name in hex after this prefix), so it is as live as the function: a subshell's copy and a later redefinition
 * follow it. just-bash's `declare -p` lists no `BASH_` variable, so it is the shell's own and no program's.
 */
const FUNCTION_TEXT = 'BASH_TABNODE_FN_';
const WAIT_COMMAND = '__tabnode_wait';
/** How much of its jobs' output a shell holds for its next `wait`; the rest still reached the host's streams. */
const PENDING_LIMIT = 1 << 20;

interface Job {
  pid: number;
  status: number | null;
  done: Promise<number>;
}
interface Shell { jobs: Map<number, Job>; order: number[]; pendingOut: string; pendingErr: string }

type Node = Record<string, unknown>;

const shells = new Map<string, Shell>();
let nextShell = 1;

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

/** The function a statement defines, where its one command is a function definition. */
function definedFunction(statement: Node): string | null {
  const pipelines = statement.pipelines;
  if (!Array.isArray(pipelines) || pipelines.length !== 1 || !isNode(pipelines[0]) || !Array.isArray(pipelines[0].commands)) return null;
  const commands = pipelines[0].commands;
  const command = commands.length === 1 ? commands[0] : undefined;
  return isNode(command) && command.type === 'FunctionDef' && typeof command.name === 'string' ? command.name : null;
}

const hex = (text: string): string => Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The one statement a line of the shell's own syntax is. */
function statementOf(line: string): Node {
  return (parse(line).statements as unknown as Node[])[0]!;
}

/** After a function's definition runs, its text is kept in its own shell variable (`FUNCTION_TEXT`). */
function keepsDefinition(name: string, text: string): Node {
  return statementOf(`${FUNCTION_TEXT}${hex(name)}=${__substrateShellWord(text)}`);
}

/**
 * The rewrite, in place: a background statement becomes a call of `__tabnode_bg` (its own subtree is not descended
 * into: its text is the job's), a function's definition is followed by the statement that keeps its text, `$!` reads
 * the job variable, `wait` is the job table's.
 */
function rewrite(node: unknown): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const child = node[index];
      if (isNode(child) && child.type === 'Statement' && child.background === true) {
        node[index] = backgroundCall(child);
        continue;
      }
      rewrite(child);
      const name = isNode(child) && child.type === 'Statement' ? definedFunction(child) : null;
      if (name !== null && typeof child.sourceText === 'string') node.splice(++index, 0, keepsDefinition(name, child.sourceText));
    }
    return;
  }
  if (!isNode(node)) return;
  if (node.type === 'ParameterExpansion' && node.parameter === '!') node.parameter = LAST_JOB_VAR;
  if (node.type === 'SimpleCommand' && wordLiteral(node.name) === 'wait') node.name = literalWord(WAIT_COMMAND);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (isNode(child) && child.type === 'Statement' && child.background === true) node[key] = backgroundCall(child);
    else rewrite(child);
  }
}

/**
 * The job's start, made where the `&` was: its text, and the interpreter's own answers at that moment for its
 * variables (`declare -p`: their attributes, arrays and associative arrays) and its functions (`declare -F`).
 */
function backgroundCall(statement: Node): Node {
  const job = typeof statement.sourceText === 'string' ? statement.sourceText.replace(/\s*&\s*$/u, '') : '';
  return statementOf(`${BG_COMMAND} ${__substrateShellWord(job)} "$(declare -p)" "$(declare -F)"`);
}

/** The plugin: every script is rewritten. */
function transform({ ast }: { ast: Node }): { ast: Node } {
  if (!Array.isArray(ast.statements)
    || !JSON.stringify(ast).match(/"background":true|"parameter":"!"|"value":"wait"|"FunctionDef"/u)) return { ast };
  rewrite(ast.statements);
  return { ast };
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

/**
 * A job's output, on its parent run's fd: as bytes where the parent takes
 * bytes, else as text. A parent that gave only byte sinks gets a builtin's
 * text as its UTF-8 bytes; it is never dropped for want of a text sink.
 */
function toRun(streams: RunStreams | undefined, fd: 1 | 2, chunk: string | Uint8Array): void {
  if (!streams) return;
  const bytes = fd === 1 ? streams.onStdoutBytes : streams.onStderrBytes;
  if (bytes) { bytes(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk); return; }
  const text = fd === 1 ? streams.onStdout : streams.onStderr;
  text?.(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
}

/** Variables the job's shell sets for itself, or that are this module's or the engine's own. */
const OWN_VARIABLES = new Set([SHELL_VAR, LAST_JOB_VAR, PROCESS_TOKEN_ENV, 'BASH', 'SHELLOPTS', 'BASHOPTS', 'PPID', 'UID', 'EUID', 'BASHPID', 'BASH_VERSINFO', 'RANDOM', 'SECONDS', 'LINENO']);

/**
 * The interpreter's variables at the `&`, from its own `declare -p` there: each line names a variable and its
 * attributes (`declare -ax name=…`), and its value is read from the shell's live variables (`ctx.env`), where an
 * indexed or associative array's elements are `name_<key>`. Each is written back as bash reads it, its words quoted
 * by the engine's one quoting (`__substrateShellWord`), since `declare -p`'s own value text leaves `$` and backquotes
 * to expand again.
 */
function variableDeclarations(ctx: CommandContext, declared: string): string[] {
  const lines: string[] = [];
  for (const match of declared.matchAll(/^declare (-[A-Za-z-]*) ([A-Za-z_][A-Za-z0-9_]*)/gmu)) {
    const [, attributes, name] = match as unknown as [string, string, string];
    if (OWN_VARIABLES.has(name)) continue;
    const indexed = attributes.includes('a');
    const associative = attributes.includes('A');
    if (indexed || associative) {
      const elements: string[] = [];
      for (const [key, value] of ctx.env) {
        if (!key.startsWith(`${name}_`) || key.endsWith('__length')) continue;
        const element = key.slice(name.length + 1);
        if (indexed && !/^\d+$/u.test(element)) continue;
        elements.push(`[${indexed ? element : __substrateShellWord(element)}]=${__substrateShellWord(value)}`);
      }
      lines.push(`declare ${attributes} ${name}=(${elements.join(' ')})`);
      continue;
    }
    const value = ctx.env.get(name);
    lines.push(value === undefined ? `declare ${attributes} ${name}` : `declare ${attributes} ${name}=${__substrateShellWord(value)}`);
  }
  return lines;
}

/**
 * The interpreter's functions at the `&`, from its own `declare -F` there, each as its definition last ran
 * (`FUNCTION_TEXT`). A function defined by text the plugin never sees (`eval`'s, a sourced file's: just-bash applies
 * its transform plugins only in `Bash.exec`) has no definition kept, and the job is refused naming it rather than run
 * without it.
 */
function functionDefinitions(ctx: CommandContext, listed: string): { definitions: string[] } | { missing: string } {
  const definitions: string[] = [];
  for (const match of listed.matchAll(/^declare -f (\S+)$/gmu)) {
    const name = match[1]!;
    const text = ctx.env.get(`${FUNCTION_TEXT}${hex(name)}`);
    if (text === undefined) return { missing: name };
    definitions.push(text);
  }
  return { definitions };
}

/**
 * The job's script for the shell's own `-c`: the shell's state at the `&`, as a forked subshell has it, written ahead
 * of the job's text (ADR-0227, "One task per worker", *Kept*): its `shopt` options (`expand_aliases` among them), its
 * variables with their attributes, its aliases and its functions, then its `set -o` options, last so that `errexit`
 * and `xtrace` take hold where the shell's own commands begin; then the job.
 */
function jobScript(ctx: CommandContext, variables: string[], functions: string[], job: string): string {
  const lines: string[] = [];
  const shopts = (ctx.env.get('BASHOPTS') ?? '').split(':').filter(Boolean);
  if (shopts.length > 0) lines.push(`shopt -s ${shopts.join(' ')}`);
  lines.push(...variables);
  for (const [name, value] of ctx.env) {
    if (name.startsWith('BASH_ALIAS_')) lines.push(`alias ${name.slice(11)}=${__substrateShellWord(value)}`);
  }
  lines.push(...functions);
  const shellOptions = (ctx.env.get('SHELLOPTS') ?? '').split(':').filter(Boolean);
  if (shellOptions.length > 0) lines.push(`set ${shellOptions.map((option) => `-o ${option}`).join(' ')}`);
  lines.push(job);
  return lines.join('\n');
}

/** The job's environment: the shell's exported variables, without the names of this module's and the engine's own. */
function environmentOf(ctx: CommandContext): Record<string, string> {
  const env = { ...(ctx.exportedEnv ?? {}) };
  for (const name of OWN_VARIABLES) delete env[name];
  return env;
}

/**
 * The job, a spawn of the shell's own program with `-c` as a child of the shell's run, with the shell's `$0` and
 * positional parameters as its words. It throws where no host can run it.
 */
function startJob(host: ShellJobsHost, ctx: CommandContext, shell: Shell, script: string): Job {
  const parent = host.runTokenOf(ctx);
  const live = (): RunStreams | undefined => (parent === null ? undefined : host.runStreamsFor(parent));
  const positional = Array.from({ length: Number(ctx.env.get('#') ?? 0) }, (_, index) => ctx.env.get(String(index + 1)) ?? '');
  let settle: (status: number) => void = () => {};
  const entry: Job = { pid: 0, status: null, done: new Promise<number>((resolve) => { settle = resolve; }) };
  const hold = (text: string, key: 'pendingOut' | 'pendingErr'): void => {
    if (!text) return;
    const room = PENDING_LIMIT - shell[key].length;
    if (room > 0) shell[key] += text.slice(0, room);
  };
  const started = host.startJob({
    owner: parent,
    argv: [SHELL_PROGRAM, '-c', script, ctx.env.get('0') ?? 'bash', ...positional],
    cwd: ctx.cwd,
    env: environmentOf(ctx),
    output: (fd, chunk) => {
      toRun(live(), fd, chunk);
      hold(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk), fd === 1 ? 'pendingOut' : 'pendingErr');
    },
    exit: (code, signal) => {
      const status = signal === null ? code : 128 + signalNumber(signal);
      entry.status = status;
      settle(status);
    },
  });
  entry.pid = started.pid;
  return entry;
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
    const [job = '', declared = '', listed = ''] = args;
    if (!job) return { stdout: '', stderr: `bash: ${BG_COMMAND}: not a job\n`, exitCode: 2 };
    const functions = functionDefinitions(ctx, listed);
    if ('missing' in functions) {
      return { stdout: '', stderr: `bash: ${functions.missing}: a function defined by eval or source cannot be carried into a background job\n`, exitCode: 1 };
    }
    const { shell } = shellOf(ctx);
    let started: Job;
    // Refused where no host can run it: bash's subshell is a fork, which this realm has not (ADR-0227 §6), and nothing
    // runs the job here. The job fails as bash's failed fork does.
    try { started = startJob(host, ctx, shell, jobScript(ctx, variableDeclarations(ctx, declared), functions.definitions, job)); }
    catch (error) { return { stdout: '', stderr: `bash: fork: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }; }
    shell.jobs.set(started.pid, started);
    shell.order.push(started.pid);
    ctx.env.set(LAST_JOB_VAR, String(started.pid));
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

  // `sh file`, `sh -c line` and `sh` on stdin: the shell's own ran the script
  // with the caller's exported variables alone, and a run's name travels in
  // a variable the shell never exports, so a `node` on any line of a script
  // found no named run and was refused ("Isolated Node execution requires a
  // named run", a start script in browser-substrate's tab, 2026-09-28). The
  // script is run as the shell's own would run it, with the name carried.
  for (const shell of ['sh', 'bash'] as const) {
    bash.registerCommand(defineCommand(shell, async (args, ctx) => {
      const exec = ctx.exec;
      if (!exec) return { stdout: '', stderr: `bash: ${shell}: needs a shell that can run a script\n`, exitCode: 1 };
      let script: string;
      let zero: string;
      let positional: string[];
      let sourced: string | undefined;
      // Options before the script (`sh -e start.sh`, `bash -eu -c …`) are the
      // shell's own; they are passed over rather than read as the file's name.
      let at = 0;
      while (at < args.length && /^[-+][a-bd-zA-Z]+$/u.test(args[at]!)) at++;
      args = args.slice(at);
      if (args[0] === '-c' && args.length >= 2) {
        script = args[1]!;
        zero = args[2] ?? shell;
        positional = args.slice(3);
      } else if (args.length === 0) {
        if (!ctx.stdin?.trim()) return { stdout: '', stderr: '', exitCode: 0 };
        script = ctx.stdin;
        zero = shell;
        positional = [];
      } else {
        const path = ctx.fs.resolvePath(ctx.cwd, args[0]!);
        try { script = String(await ctx.fs.readFile(path)); }
        catch { return { stdout: '', stderr: `${shell}: ${args[0]}: No such file or directory\n`, exitCode: 127 }; }
        zero = args[0]!;
        positional = args.slice(1);
        sourced = path;
      }
      if (script.startsWith('#!')) {
        const newline = script.indexOf('\n');
        if (newline !== -1) script = script.slice(newline + 1);
      }
      const env: Record<string, string> = { ...(ctx.exportedEnv ?? {}), '0': zero, '#': String(positional.length), '@': positional.join(' '), '*': positional.join(' ') };
      positional.forEach((word, index) => { env[String(index + 1)] = word; });
      const token = ctx.env.get(PROCESS_TOKEN_ENV);
      if (token) env[PROCESS_TOKEN_ENV] = token;
      // A file is sourced by one statement of the nested run rather than run
      // as the nested run's own script: a nested script of several lines
      // stopped after its first hosted `node` in a tab (2026-09-28), while
      // the same lines sourced from one statement ran whole. The shebang
      // line is a comment to the shell that sources it.
      if (sourced !== undefined) script = `. ${sourced.replace(/'/gu, "'\\''").replace(/^(.*)$/su, "'$1'")}`;
      const result = await exec(script, { env, cwd: ctx.cwd, stdin: ctx.stdin, signal: (ctx as { signal?: AbortSignal }).signal });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
    }));
  }
  // `exec command…` runs the command in the script's place, with the
  // script's environment and its run's name, and answers with its status.
  // The shell's own `exec` ran a builtin but a program the engine defines,
  // `node`, ran nothing: a start script's `exec node server.js` ended with
  // no server and no word. This one hands the line back to the shell, which
  // is where `node`, `npm` and the host's programs are found. The shell is
  // not replaced: a line after `exec` runs once the command ends, where
  // bash would never reach it. A start script's `exec` is its last line, a
  // server that does not end.
  bash.registerCommand(defineCommand('exec', async (args, ctx) => {
    if (args.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
    if (!ctx.exec) return { stdout: '', stderr: 'bash: exec: needs a shell that can run a line\n', exitCode: 1 };
    const line = args.map((word) => /^[A-Za-z0-9_./:=@%+,-]+$/u.test(word) ? word : `'${word.replace(/'/gu, "'\\''")}'`).join(' ');
    const env: Record<string, string> = Object.fromEntries(ctx.env);
    const result = await ctx.exec(line, { env, cwd: ctx.cwd, replaceEnv: true });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
  }));

  bash.registerCommand(defineCommand('kill', async (args, ctx) => {
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
      // Signal zero is the caller's kill(2) query, including signed group
      // targets. It must reach that authority with the number the shell read.
      const pid = signal === '0' ? Number(target) : Math.abs(Number(target));
      if (!deliver(host.runTokenOf(ctx), pid, signal)) { stderr += `bash: kill: (${target}) - No such process\n`; status = 1; }
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
function deliver(caller: ProcessToken | null, pid: number, signal: string): boolean {
  // A saved child handle may outlive its kernel PID. Like process.kill(pid,0),
  // shell liveness is only the caller authority's no-delivery answer.
  if (signal === '0') return pidIsLive(pid, caller);
  // The calling shell's own children are found among its own; any other pid goes to the kernel's kill.
  const child = __substrateChildrenOf(caller).get(pid);
  const childLive = child !== undefined && child.exitCode === null && child.signalCode === null;
  if (childLive) return child.kill(signal);
  const token = tokenOfPid(pid, caller);
  if (token !== null && __signalOwnedProcess(token, signal)) return true;
  return signalPid(pid, signal, caller);
}
