# ADR-0012: A run is a shell line or a program's argv

Status: Accepted

Date: 2026-11-06. Served: the manager's contract line for `container.run` (decisions 4ea1db782: the existing run door
takes a readonly argv with no shell parsing), the first consumer being browser-substrate's kernel tree, which execs a
program it has already resolved.

## Context

`container.run(command, options)` is the engine's one door for a run a host names. Until now `command` was a line,
read by the engine's shell (just-bash) or handed to a host's executor. A host that has a program and its words
(a kernel that execs, a page that starts `npm install`) had to make a line of them, and the engine's own `spawn`
does the same for a non-Node child (`command-line.ts`, `__substrateLineFor`): each word is quoted only where the
shell would read it as syntax, so a word with `=` or one that is a reserved word reached the shell bare. A program
named `A=x` became an environment assignment and `if` became syntax.

A numbered run (`options.process`, `options.registry`: a kernel's process, browser-substrate ADR-0129) claims its pid
as a shell (`sh -c <line>`), and every `node` it runs is its child with a pid of its own (`holdShellRun`,
`nestedNodeToken`, `launchNode`'s `nested`). `container.runNode(argv)` is the other door: the engine's Node from its
argv, the run itself, its pid the one the host gave.

## Decision

### 1. One door, two forms

`run(command: string | readonly string[], options?)`:
- **A string is a line.** The engine's shell or a host's shell parses it, as today.
- **An array is an argv, as POSIX `execvp(argv[0], argv)` takes one** (source: POSIX `exec`, `execvp`): `argv[0]` is
  resolved against `PATH` on the run's own filesystem, a name containing a slash is used as it is (from the working
  directory), and the vector reaches the program untouched; nothing parses it. It is non-empty and every entry is a
  string, else `TypeError`. A shell (`sh`, `bash`, ...) is a program like any other: `['sh', '-e', '-c', x]` reaches
  that shell as its argv, and the shell reads its own options, `-c`, `$0` and positional words.

There is no second run method; `runNode` stays the door for an argv a host already knows is Node.

### 2. Which process the run is

- **A line's process is a shell.** A numbered line claims its pid as `['sh', '-c', line]`; every `node` the line runs
  is that shell's child, under its own pid through the run's registry (`holdShellRun`), as today.
- **An argv is the engine's Node only where `execvp` reaches the engine's node entry.** The run's tree is chosen
  first (`options.filesystem`, else the container's), and `argv[0]` is resolved on it once by `execvp`'s search
  (`execvpPath`, the search `programExists` also makes). Where that reaches the engine's node entry, the path
  `process.execPath` reports (`/usr/local/bin/node`, which the tree's shell keeps there), the run is `runNode`'s launch
  (`launchNode` from that argv), the existing owner of a Node process: a numbered run claims the given pid for the
  Node itself, and `process.pid` and `process.ppid` are the pid and ppid the host gave. A basename is never the test:
  a real `/tools/node` in the tree, or a `node` on an earlier `PATH` entry, is that file and runs as itself.
- **Any other argv is its program.** A numbered one claims its pid with the argv as given. A `node` that program runs
  (an `npm` script, a shell script, a shell's `-c`) is its child, exactly as a shell's is (`holdShellRun`'s rule: a
  run whose program is a shell or another non-Node program).

Kernel admission is unchanged: the pid and ppid are the kernel's, claimed through `claimRunPid`; children are numbered
through the run's registry; the engine keeps no table of its own.

### 3. How an argv reaches its program, on every route

An argv that is not the engine's Node (§2) goes through `runCommand` and `routeCommand` as `CommandRun.execvp`, the
vector as given; the run's tree is chosen by `routeCommand` before anything resolves `argv[0]`.

| Route | When | A line | An argv |
| --- | --- | --- | --- |
| **Host** | a published host executor (`hostExecutor()`), unless its bypass is taken | `bridge.run(line)`, for the host's shell | `bridge.run(text, { executablePath: argv[0], argv })`: the executable is the host's to resolve and the vector its program's, as `spawn` leaves a host-owned executable to its host; `text` is the words each single-quoted, only for a host that has nothing but a shell |
| **Local engine** | no host executor, or the host's bypass | `bash.exec(line)` | `bash.exec('command --', { args: argv })`: just-bash's interpreter-level argv, which no parser reads, handed to its `command` builtin, which resolves `argv[0]` on the run's tree (its `PATH` lookup, shell functions skipped as `execvp` has none) and hands the program its words |
| **Kernel tree** | `options.filesystem`, a kernel process's tree | that tree's shell (`shellForRunTree`), then the host or local branch above | the same, on that tree |
| **Node** | `execvp` reaches the engine's node entry (§2) | the shell's `node` command, a child of the shell | `runNode`'s launch on the run's tree: the process host admits it where one is installed (`runHostedNode`), else it runs in this realm |

`spawn`, `spawnSync` and `exec` are not argv runs and keep their own paths as they are.

### 4. The argv consumers

Read by grep at this decision's head: every consumer of an argv run, and the helpers it does not use.
- **The argv path:** `index.ts` `run` (the Node test, `execvpReachesEngineNode`, then `startNodeRun` or `runCommand`);
  `child_process.ts` `execvpReachesEngineNode` and `execvpPath`; `runCommand` (validates the vector, makes
  `CommandRun.execvp` and its quoted text); `routeCommand`'s host branch (`executablePath`, `argv`) and local branch
  (`command --` with `args`); `runNode` and `launchNode` for the Node case; `claimRunPid` and `holdShellRun` for its
  process (§2).
- **Not on the argv path, kept for `spawn` and `spawnSync` as they are:** `command-line.ts`'s `__substrateLineFor`,
  `__substrateArgvFor`, `__substrateShellLine`, `__substrateCommandLine`, `__substrateProgramName`,
  `__substrateRunsNode` and the resolver `engineProgramFor` (`setProgramResolver`); their callers are
  `startChildRun`'s routes, `runByHost`, `hostRunsProgram`, the process model's `resolves` answer (its
  `{ shell: true }` test) and `node-lib/binding/spawn_sync.ts`.
  `programExists` takes its `PATH` search from `execvpPath`, the same search with the same answers.

## Where the evidence stops

- **Read:** POSIX `exec` (`execvp`: a file name without a slash is searched for in `PATH`, one with a slash is used as
  the path, and the argument list is passed as it is); just-bash 2.14.5 as published, `ExecOptions.args` ("Values
  bypass shell parsing entirely") and its interpreter appending `extraArgs` to the first simple command's words, and the
  `command` builtin (`--`, then `runCommand(name, words, ..., skipFunctions)`). Tabnode's `index.ts` (`run`,
  `runNode`), `child_process.ts` (`runCommand`, `routeCommand`, `runNode`, `launchNode`, `holdShellRun`,
  `nestedNodeToken`, `startChildRun`, `programExists`, the tree's shell writing `/usr/local/bin/node`) and
  `command-line.ts`.
- **Not read:** how just-bash's `command` orders its own builtins against a `PATH` file of the same name.
- **Not run.** No probe of a line or argv run was made for this decision.
