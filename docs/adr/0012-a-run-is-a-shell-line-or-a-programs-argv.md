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
- **An array is an argv: the program, then its words, exactly.** No shell reads it. It is non-empty and every entry
  is a string, else `TypeError`. `argv[0]` names the program as `spawn(file, args)`'s `file` does (the engine's own
  names, a path in the tree, a name on `PATH`).

There is no second run method; `runNode` stays the door for an argv a host already knows is Node.

### 2. Which process the run is

- **A line's process is a shell.** A numbered line claims its pid as `['sh', '-c', line]`; every `node` the line runs
  is that shell's child, under its own pid through the run's registry (`holdShellRun`), as today.
- **An argv naming the engine's Node is that Node** (`__substrateRunsNode(argv[0])`: `node`, `process.execPath`, any
  `.../node` the tree does not carry). The run is `runNode`'s launch (`launchNode` from that argv), the existing
  owner of a Node process: a numbered run claims the given pid for the Node itself (`argv` as given), and
  `process.pid` and `process.ppid` are the pid and ppid the host gave. No shell process stands between.
- **An argv naming any other program is that program.** A numbered one claims its pid with the argv as given. A
  `node` that program runs (an `npm` script, a shell script, a `sh -c` argv) is its child, exactly as a shell's is,
  since that program is not Node (`holdShellRun`'s rule: a run whose program is a shell or another non-Node program).

Kernel admission is unchanged: the pid and ppid are the kernel's, claimed through `claimRunPid`; children are numbered
through the run's registry; the engine keeps no table of its own.

### 3. How an argv reaches the program, on every route

Every argv run that is not Node (§2) goes through `runCommand` and `routeCommand`, the one dispatch a `spawn` of a
non-Node child takes. The routes:

| Route | When | A line | An argv |
| --- | --- | --- | --- |
| **Local engine** | no host executor, or a program the engine has first (`engineFirst`), or the host's bypass | `bash.exec(line)` | `bash.exec('command --', { args: argv })`: just-bash's interpreter-level argv, which no parser reads, appended to the `command` builtin, which dispatches `argv[0]` by name with its words as given (shell functions skipped, as `execvp` has none) |
| **Host** | a published host executor runs it (`hostExecutor()`) | `bridge.run(line)`, for the host's shell | `bridge.run(line, { argv })`: the host starts the program from the list; the line beside it is for a host that has only a shell |
| **Kernel tree** | `options.filesystem`, a kernel process's tree | that tree's shell (`shellForRunTree`), then the local or host branch by the rules above | the same, on that tree |
| **Node** | `argv[0]` is the engine's Node | the shell's `node` command, a child of the shell | `runNode`'s launch on the run's tree: the process host admits it where one is installed (`runHostedNode`), else it runs in this realm |

A `spawn(file, args)` of a non-Node child carries the same argv (`__substrateArgvFor`), so it reaches its program
the same way on the local route.

The line made for a host's shell from a program and its words (`__substrateCommandLine`) quotes the program word
whenever a shell would read it as something else at a command's start, a word with `=` (an assignment) or a reserved
word (`if`, `for`, `time`, ...), beside the syntax characters every word already has quoted.

## Where the evidence stops

- **Read:** just-bash 2.14.5 as published: `ExecOptions.args` ("Values bypass shell parsing entirely") and its
  interpreter appending `extraArgs` to the first simple command's words; the `command` builtin (`--`, then
  `runCommand(name, words, ..., skipFunctions)`). Tabnode's `index.ts` (`run`, `runNode`), `child_process.ts`
  (`runCommand`, `routeCommand`, `runNode`, `launchNode`, `holdShellRun`, `nestedNodeToken`, `startChildRun`) and
  `command-line.ts`.
- **Not run.** No probe of a line or argv run was made for this decision.
