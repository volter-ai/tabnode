/**
 * A LINE'S PACKAGE BIN RUNS UNDER NODE.
 *
 * Linux's execve runs a script through the interpreter its `#!` line names. The engine's shell (just-bash) runs every
 * file it finds on PATH as a shell script, whatever that line names, and has no hook to ask: it strips the first line
 * and parses the rest as shell. A bin the tab's own installer writes is a `node "<file>"` shell stub, so that held;
 * a bin a host install wrote (npm's or bun's symlink to the package's `#!/usr/bin/env node` file) was parsed as shell.
 * videogame.ai's `npm run preview` ran `astro preview`, and node_modules/.bin/astro was read as a script: "bash: line
 * 14: unexpected EOF while looking for matching `''" (browser-substrate card t_d4b07ea8, 2026-10-17). The siblings are
 * every package script and every attached command whose first word is a bin of a host install that no program
 * registers (astro, tsx, nest, wrangler, cross-env…).
 *
 * So before a line runs (a transform of its syntax tree, the hook the shell does give), a simple command whose literal
 * name is found on the line's PATH as a plain Node script (`#!/usr/bin/env node`, `#!/usr/local/bin/node`) is that
 * script run by the shell's own `node`: `astro preview` becomes `node <path of the bin> preview`, which is what the
 * `#!` line asks execve to run, and so is a name with a `/` that names such a script (`./node_modules/.bin/x`, a bin
 * spawned by its path). Nothing else is touched: a builtin, a registered command, a function the line defines, a
 * command whose own assignments set PATH, and a script whose `#!` line gives node arguments (a
 * flag the line would have to carry) keep the shell's own lookup, as before. The PATH is the one the line is run with
 * (the caller's options, else the shell's own), read as its run begins.
 */
import type { Bash } from 'just-bash';
import type { VirtualFS } from '../virtual-fs';
import { treeDescriptorsOf } from '../tree-descriptors';

/** The shell's own builtins: the shell answers these names itself, and a file of the same name never runs for them. */
const SHELL_BUILTINS = new Set(['.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen',
  'complete', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg',
  'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd',
  'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true',
  'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait']);

/** A script whose `#!` line runs node and nothing else, directly or through env: what npm's and bun's bins are. */
const PLAIN_NODE = /^#![ \t]*(?:\S*\/env[ \t]+node|\S*\/node)[ \t]*\r?$/u;
/** Linux's binfmt_script reads a bounded first block. */
const HEAD_BYTES = 256;

function nodeScript(tree: VirtualFS, path: string): boolean {
  try {
    const stat = tree.statSync(path);
    if (!stat.isFile()) return false;
    // A PATH walk passes by a file it cannot execute, as execvp does.
    const mode = (stat as { mode?: number }).mode;
    if (mode !== undefined && (mode & 0o111) === 0) return false;
    const door = treeDescriptorsOf(tree);
    let head: Uint8Array;
    if (door) {
      const fd = door.open(path, 0, 0);
      try { const bytes = new Uint8Array(HEAD_BYTES); head = bytes.subarray(0, door.read(fd, bytes, 0, HEAD_BYTES, 0)); }
      finally { door.close(fd); }
    } else head = (tree.readFileSync(path) as Uint8Array).subarray(0, HEAD_BYTES);
    const end = head.indexOf(10);
    return PLAIN_NODE.test(new TextDecoder().decode(end < 0 ? head : head.subarray(0, end)));
  } catch { return false; }
}

/** The first file named `name` on `path` that exists and is not a directory, as execvp walks it; undefined when none. */
function onPath(tree: VirtualFS, name: string, path: string | undefined, cwd: string): string | undefined {
  for (const directory of (path ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
    if (!directory) continue;
    const absolute = directory.startsWith('/') ? directory : `${cwd.replace(/\/+$/u, '')}/${directory}`;
    const file = `${absolute.replace(/\/+$/u, '')}/${name}`;
    try { if (tree.existsSync(file) && !tree.statSync(file).isDirectory()) return file; } catch { /* the next directory */ }
  }
  return undefined;
}

/** The file a name with a `/` names, from the line's directory when it is relative; undefined when it is not a file. */
function atPath(tree: VirtualFS, name: string, cwd: string): string | undefined {
  const file = name.startsWith('/') ? name : `${cwd.replace(/\/+$/u, '')}/${name}`;
  try { return tree.existsSync(file) && !tree.statSync(file).isDirectory() ? file : undefined; } catch { return undefined; }
}

type Node = { type?: string; [key: string]: unknown };

/** Every node of a syntax tree, depth first. */
function* nodesOf(value: unknown): Generator<Node> {
  if (Array.isArray(value)) { for (const item of value) yield* nodesOf(item); return; }
  if (!value || typeof value !== 'object') return;
  const node = value as Node;
  if (typeof node.type === 'string') yield node;
  for (const key of Object.keys(node)) if (key !== 'type') yield* nodesOf(node[key]);
}

/** Install the transform on a tree's shell; `registered` says whether a name is a command the shell carries. */
export function routePackageBins(bash: Bash, tree: VirtualFS, registered: (name: string) => boolean): void {
  // The PATH and directory a line is about to run with, read when its syntax tree is transformed: the transform runs
  // as the line's run begins, and is told nothing of the run's options.
  let pending: { path?: string; cwd?: string } | undefined;
  const exec = bash.exec.bind(bash);
  bash.exec = ((line: string, options?: Parameters<Bash['exec']>[1]) => {
    // just-bash resolves a given directory with an awaited realpath when the environment names no PWD, and another
    // line's run could begin in that gap and take this one's PATH and directory. Resolved here, synchronously, and
    // given as both, the run reaches its transform with no await between (the directory it ends in is the same).
    if (options?.cwd !== undefined && options.env !== undefined && !('PWD' in options.env)) {
      let real = options.cwd;
      try { real = tree.realpathSync(options.cwd) as string; } catch { /* just-bash keeps the path as given too */ }
      options = { ...options, cwd: real, env: { ...options.env, PWD: real } };
    }
    pending = { ...(options?.env?.PATH !== undefined ? { path: options.env.PATH } : {}), ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) };
    return exec(line, options);
  }) as Bash['exec'];

  bash.registerTransformPlugin({
    name: 'tabnode-package-bins',
    transform: ({ ast }: { ast: unknown }) => {
      const seen = pending ?? {};
      pending = undefined;
      const path = seen.path ?? bash.getEnv().PATH;
      const cwd = seen.cwd ?? bash.getCwd();
      const defined = new Set<string>();
      for (const node of nodesOf(ast)) if (node.type === 'FunctionDef' && typeof node.name === 'string') defined.add(node.name);
      const answers = new Map<string, string | null>();
      const moves = [...nodesOf(ast)].some((node) => node.type === 'SimpleCommand' && ['cd', 'pushd', 'popd'].includes(String((node.name as { parts?: Array<{ value?: unknown }> } | undefined)?.parts?.[0]?.value ?? '')));
      for (const node of nodesOf(ast)) {
        if (node.type !== 'SimpleCommand') continue;
        const word = node.name as { parts?: Array<{ type?: string; value?: unknown }> } | null;
        const part = word?.parts?.length === 1 ? word.parts[0] : undefined;
        if (part?.type !== 'Literal' || typeof part.value !== 'string') continue;
        const name = part.value;
        // A name with a `/` is the file it names, as execve takes it: no PATH walk, the line's directory for a
        // relative one. The harness SDK spawns node_modules/.bin/supercode by its path, and the shell parsed the
        // package's `#!/usr/bin/env node` file as shell ("syntax error near unexpected token `('", exit 1).
        const byPath = name.includes('/');
        if (byPath ? !/^[\w./@+-]+$/u.test(name) : (!/^[A-Za-z0-9_][\w.+-]*$/u.test(name) || SHELL_BUILTINS.has(name) || defined.has(name) || registered(name))) continue;
        if (!byPath && (node.assignments as Array<{ name?: unknown }> | undefined)?.some((assignment) => assignment.name === 'PATH')) continue;
        // A relative name on a line that changes directory names a file from wherever the line has moved to, which
        // this reading of the line does not follow: the shell runs it as it would.
        if (byPath && !name.startsWith('/') && moves) continue;
        let script = answers.get(name);
        if (script === undefined) {
          const found = byPath ? atPath(tree, name, cwd) : onPath(tree, name, path, cwd);
          // Node runs its main script from the file's real path, as execve's path through a bin's link reaches it.
          let real = found;
          if (found !== undefined) try { real = tree.realpathSync(found); } catch { /* the path as found */ }
          script = found !== undefined && nodeScript(tree, found) ? real ?? found : null;
          answers.set(name, script);
        }
        if (script === null) continue;
        node.args = [{ type: 'Word', parts: [{ type: 'Literal', value: script }] }, ...(node.args as unknown[])];
        node.name = { type: 'Word', parts: [{ type: 'Literal', value: 'node' }] };
      }
      return { ast };
    },
  } as Parameters<Bash['registerTransformPlugin']>[0]);
}
