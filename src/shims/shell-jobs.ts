/**
 * The engine's shell's own commands for a run's processes: `sh` and `bash` that carry a run's name, `exec`, and a
 * `kill` that reaches any process of the engine by pid, built on the doors just-bash offers (custom commands) rather
 * than on a patched copy of it.
 *
 * The engine's shell runs a line only where no host runs it (`routeCommand`): in the substrate every shell line is the
 * catalog's own `/bin/sh -c` through the host's child start, so a `&` there is that shell's own fork. With no host
 * there is no fork, and a statement ending in `&` runs in the foreground in the realm, as just-bash runs it
 * (browser-substrate decisions, "with no host, Tabnode's `&` runs in the foreground").
 */
import type { Bash, CommandContext } from 'just-bash';
import { PROCESS_TOKEN_ENV, pidIsLive, signalPid, tokenOfPid, __signalOwnedProcess, type ProcessToken } from '../process-tokens';
import { __substrateChildrenOf, __substrateSignals, __substrateSignalNames } from './process';

/** What the engine's process model gives this module. */
export interface ShellJobsHost {
  runTokenOf(ctx: CommandContext): ProcessToken | null;
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

/** The engine's shell, given `sh`, `bash`, `exec` and `kill`. */
export function installShellJobs(bash: Bash, host: ShellJobsHost & { defineCommand: typeof import('just-bash').defineCommand }): void {
  const { defineCommand } = host;
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
