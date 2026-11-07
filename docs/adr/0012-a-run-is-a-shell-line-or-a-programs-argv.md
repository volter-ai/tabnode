# ADR-0012: A run is a shell line or a program's argv

Status: Accepted

Date: 2026-11-06. Served: the manager's contract line for `container.run` (decisions 4ea1db782: the existing run door
takes a readonly argv with no shell parsing), the first consumer being browser-substrate's kernel tree, which execs a
program it has already resolved.

## Context

`container.run(command, options)` is the engine's one door for a run a host names. A host that has a program and its
words (a kernel that execs, a page that starts `npm install`) must reach that program with exactly those words: a word
is a word, so a program named `A=x` is that program and `if` is a word, never an environment assignment or shell
syntax. An argv is therefore never made a line for a shell to read.

A numbered run of a line (`options.process`, `options.registry`: a kernel's process, browser-substrate ADR-0129) claims
its pid as a shell (`sh -c <line>`), and every `node` it runs is its child with a pid of its own (`holdShellRun`,
`nestedNodeToken`, `launchNode`'s `nested`). `container.runNode(argv)` is the door for an argv a host knows is the
engine's Node: the run itself, its pid the one the host gave.

## Decision

### 1. One door, two forms

`run(command: string | readonly string[], options?)`:
- **A string is a line.** The engine's shell or a host's shell parses it.
- **An array is an argv, as POSIX `execvp(argv[0], argv)` takes one** (§2): the executable is chosen as `execvp`
  chooses it, and the vector reaches the program untouched; nothing parses it. It is non-empty and every entry is a
  string, else `TypeError`, checked once, at the door (`admittedArgv`). A shell (`sh`, `bash`, ...) is a program like
  any other: `['sh', '-e', '-c', x]` is the resolved shell program with that argv.

There is no second run method; `runNode` is the door for an argv a host already knows is Node.

### 2. One resolution: `execvp`'s own

musl 1.2.5's `__execvpe` (`src/process/execvp.c:9-53`), which every WALI program of the substrate links:
- an empty name is `ENOENT`, and a name with a slash is that path (`execve(file)`, relative to the working directory);
- otherwise the name (over 255 bytes `ENAMETOOLONG`) is tried in each `PATH` entry in order, `PATH` unset being
  `/usr/local/bin:/bin:/usr/bin`; an empty entry is the working directory and a relative entry is taken against it;
- each candidate is `execve(candidate)`: the walk goes on past one that fails `ENOENT`, `ENOTDIR` or `EACCES` (a
  directory, a file without execute permission), remembering `EACCES`, and ends at any other failure with it
  (`ENOEXEC`, `ELOOP`, ...); with no candidate left it ends `EACCES` if one was seen, else `ENOENT`. `execve` of a
  script fails as its interpreter's `execve` does, so a candidate whose interpreter is missing is `ENOENT` and the
  walk goes on. There is no hash table, and no builtin: `execvp` has none.

Tabnode's resolver is that walk on the run's own tree (`execvpWalk`, `shims/child_process.ts`), each candidate
admitted whole, as §3 decides what it runs as, before the walk takes it. A file counts only where the tree's
`statSync` shows a regular file with an execute bit, and the program's identity is the tree's `realpathSync` of it
(the tree normalizes `.`, `..` and symlinks); the tree's own error is kept (`ENOTDIR`, `ELOOP` of a symlink loop), and
a tree error of any other kind is `EIO`, the file unreadable. `programExists` (`spawn`'s question whether a program is
there at all) walks the same way with `spawn`'s own `PATH` default and its own stub rule, admitting a candidate only as
a file, and keeps its answers: a name the shell carries exists, and a file found without execute permission still
exists (its run then fails).

**In a kernel tree the kernel decides.** A tree that offers kernel descriptors (`TREE_DESCRIPTORS`) belongs to a
kernel whose `posix_spawnp` (browser-substrate ROADMAP item 1, `SYS_posix_spawnp_v1`, musl's walk in the kernel)
resolves the program. Tabnode does not search there: the argv goes to the host as it is (§4), and with no host to run
it the run fails `EACCES`, as a child of such a process does (ADR-0010 §2).

### 3. What the resolved file runs as

Outside a kernel tree, what runs is decided by what the resolved file is, never by its name:
- **The engine's Node** where the file's realpath is the engine's node entry (`process.execPath`,
  `__substrateExecPath`, the file the tree's shell keeps there). The run is then `runNode`'s launch (`launchNode` from
  that argv), the existing owner of a Node process: a numbered run claims the given pid for the Node itself, and
  `process.pid` and `process.ppid` are the pid and ppid the host gave. A real `/tools/node`, or a `node` on an
  earlier `PATH` entry, is that file and runs as what it is.
- **A command the engine's shell registered** where the file is that command's installed entry: just-bash's
  `registerCommand` writes `/bin/<name>` and `/usr/bin/<name>` as `#!/bin/bash` then `# Built-in command: <name>`,
  where its filesystem takes synchronous writes. The command runs with the vector's words, by that path, so the
  shell neither looks the name up nor offers its builtins.
- **A script** (`#!`): its line is read as Linux's `load_script` reads it (`fs/binfmt_script.c`), from the header
  `execve` reads, `BINPRM_BUF_SIZE` (256) bytes through the tree's header owner (`executableHeader`,
  `EXECUTABLE_HEADER_BYTES`), the rest NUL. The line ends at a newline found before any NUL; with none, the interpreter
  must end at a space, tab or NUL inside the header, else its path is taken for truncated and the file is `ENOEXEC`.
  The interpreter ends at its first space, tab or NUL, and the rest of the line, trimmed and cut at a NUL, is its one
  argument. The run is the interpreter with `[interpreter, argument?, path, ...argv[1:]]`, the interpreter a path as
  `execve` takes it (no `PATH` walk) and decided by these same rules (Linux `execve`'s `binfmt_script`, up to four
  levels, then `ELOOP`), so a script whose interpreter is the engine's Node is that Node.
- **Anything else** fails `ENOEXEC`, as musl's `execvp`, which does not fall back to a shell.

A run that resolves nothing reports as a shell reports a program it could not execute (POSIX XCU 2.8.2): exit 127 with
`<argv[0]>: No such file or directory` for `ENOENT` (and `File name too long`), 126 with `Not a directory`, `Permission
denied`, `Exec format error`, `Too many levels of symbolic links` or `Input/output error`. So
`['true']` with no `true` on `PATH` is `ENOENT`, and `['cd']` fails the same way.

**The tree presents its commands where a machine carries them.** On Linux `ls` is a file at `/bin/ls`, and `execvp`
finds it there. just-bash's `registerCommand` lays its commands out so where its filesystem takes a synchronous write;
the shell's adapter (`vfs-adapter.ts`) has none, so a tree the engine made is given, when its shell is made
(`installCommandEntries`, beside the node entry at `process.execPath`), every registered command as an executable entry
at `/bin/<name>` and `/usr/bin/<name>` with just-bash's own entry text, where nothing is there already. `execvp` then
finds them for an argv and a `spawn` alike, and a command's identity is that installed entry. A tree a host supplied
is the host's: the engine writes nothing into it, as it writes no node entry there, and what it presents is what runs.
With `/usr/bin` present, just-bash's registry fallback (a command found by name where `/usr/bin` is absent) does not
answer a line whose `PATH` names neither `/bin` nor `/usr/bin`, as on a machine.

### 4. Which process the run is, and the route

- **A line's process is a shell.** A numbered line claims its pid as `['sh', '-c', line]`; every `node` the line runs
  is that shell's child, under its own pid through the run's registry (`holdShellRun`).
- **An argv that is the engine's Node** (§3) is `startNodeRun` on every route.
- **Any other argv is its program.** A numbered one claims its pid with the argv as given. A `node` that program runs
  is its child, exactly as a shell's is (`holdShellRun`).

| Route | When | A line | An argv |
| --- | --- | --- | --- |
| **Host** | a published host executor (`hostExecutor()`), unless its bypass is taken (never for an argv in a kernel tree) | `bridge.run(line)` | `bridge.run(text, { executablePath: argv[0], argv })`: the host resolves the executable (in a kernel tree, its kernel's `posix_spawnp`) and the vector is its program's; `text` is the words each single-quoted, only for a host that has nothing but a shell |
| **Local engine** | no host executor, or the host's bypass | `bash.exec(line)` | §3's decision on the run's tree: a registered command's entry is `bash.exec('command --', { args: [entry, ...argv[1:]] })`, the path naming the command; anything that resolves nothing reports 127 or 126; in a kernel tree, `EACCES` |
| **Node** | §3 decides the engine's Node | the shell's `node` command, a child of the shell | `runNode`'s launch on the run's tree |

`spawn`, `spawnSync` and `exec` are not argv runs and keep their own paths.

### Kept

- **The engine's shell programs are just-bash's imitations.** Where a tree holds just-bash's `sh` or `bash` entry, an
  argv that resolves to it runs just-bash's command, which reads `-c` only as its first argument, so
  `['sh', '-e', '-c', x]` reads `-e` as a script's name. The real shell is browser-substrate ADR-0122's (the kernel
  and the image's GNU Bash or BusyBox run commands, shebangs and Node's shell requests, and just-bash leaves the front
  door); in a kernel tree the argv is the kernel's and reaches that shell.

### 5. The argv consumers

Read by grep at this decision's head:
- **The argv path:** `index.ts` `run` (the vector admitted by `admittedArgv`, the run's tree chosen,
  `execvpExecution` for a tree that is not a kernel's, then `startNodeRun` or `runCommand` with that execution);
  `child_process.ts` `execvpWalk`, `executableAt`, `scriptLineOf`, `registeredEntry` and `execvpExecution`;
  `runCommand` (makes `CommandRun.execvp`, its execution and its quoted text); `routeCommand`'s host branch
  (`executablePath`, `argv`) and local branch (§4); `runNode` and `launchNode` for the Node case; `claimRunPid` and
  `holdShellRun` for its process.
- **The same walk for `spawn`:** `programExists`, with its own `PATH` default and stub rule.
- **The installed entries:** `installCommandEntries` writes, and `registeredEntry` recognizes, the one entry text
  (`commandEntryText`).
- **Not on the argv path, kept for `spawn` and `spawnSync` as they are:** `command-line.ts`'s `__substrateLineFor`,
  `__substrateArgvFor`, `__substrateShellLine`, `__substrateCommandLine`, `__substrateProgramName`,
  `__substrateRunsNode` and the resolver `engineProgramFor` (`setProgramResolver`).

## Where the evidence stops

- **Read:** musl 1.2.5's `src/process/execvp.c` (`__execvpe`); Linux's `fs/binfmt_script.c` (`load_script`) and
  `include/uapi/linux/binfmts.h` (`BINPRM_BUF_SIZE` 256); POSIX XCU 2.8.2 (exit status 126 and 127); just-bash
  2.14.5 as published (bundle `dist/bundle/index.js`): `ExecOptions.args`, the `command` builtin, its command
  resolution (a slash path's basename chooses a registered command; a `PATH` walk with a persistent hash table;
  registered commands at `/bin` and `/usr/bin` win; a registry fallback where `/usr/bin` is absent), its builtin
  dispatch ahead of external lookup, and `registerCommand`'s entries; Tabnode's `index.ts` (`run`, `runNode`),
  `child_process.ts` (`runCommand`, `routeCommand`, `runNode`, `launchNode`, `holdShellRun`, `startChildRun`,
  `programExists`, the tree's shell writing `/usr/local/bin/node`), `shims/vfs-adapter.ts`, `virtual-fs.ts`
  (`statSync`, `realpathSync`) and `tree-descriptors.ts`.
- **Taken from the record, not read here:** browser-substrate item 1's `SYS_posix_spawnp_v1`.
- **Not run.** No probe of a line or argv run was made for this decision.
