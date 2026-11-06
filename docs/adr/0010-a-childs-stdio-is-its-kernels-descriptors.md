# ADR-0010: A child's stdio is descriptors of its kernel, and a terminal's mode is its kernel's termios

Status: Accepted.

Date: 2026-11-05. Served: browser-substrate ADR-0227 §7 and ROADMAP item 2 at 7cd0f130e3d, "Where it stops, read in
item 2's code": "a Node realm's child keeps its stdio relay (output as messages, fd 0 as a ring, `CHILD_STDIO_RELAY`)
until Tabnode's spawn makes a child's `'pipe'` stdio kernel socketpairs placed at the child's fds 0 to 2, which is
Tabnode's change [...]. A realm's raw mode reaches the kernel once Tabnode's `setRawMode` calls the run's
`terminal.setRawMode`, which the realm already gives (a TCSETSW of fd 0); until then a realm's terminal stays
canonical with echo." Builds on ADR-0009 (a realm's sockets are its kernel's).

## Context

### What a child is given on Linux (read in Node v24.21.0's `deps/uv/src/unix/process.c`, `tty.c` and `src/node.cc`)

- **`uv_spawn` makes each `UV_CREATE_PIPE` entry a socketpair** (`uv__process_init_stdio`): `uv_socketpair(SOCK_STREAM,
  0, fds, 0, 0)`, close-on-exec and blocking at both ends, each end's `SO_RCVBUF` and `SO_SNDBUF` set to 64 KiB. Node
  asks for one for every `'pipe'` entry, IPC or not (`src/process_wrap.cc` `ParseStdioOptions`).
- **An `'inherit'`, a number or a stream** (`UV_INHERIT_FD`, `UV_INHERIT_STREAM`) is the parent's descriptor by its
  number, a stream's being `uv__stream_fd`.
- **The child places them** (`uv__process_child_init`): each entry's descriptor is `dup2`'d to its index (a source an
  earlier `dup2` would overwrite moved above them first); one already at its number has close-on-exec cleared; an
  entry with nothing at 0, 1 or 2 (`'ignore'`) is `/dev/null` opened there (read-only for 0, read-write for 1 and 2);
  and each of fds 0 to 2 is made blocking (`uv__nonblock_fcntl(fd, 0)`). The exec closes everything else
  close-on-exec.
- **The parent keeps its end** (`uv__process_open_stream`): it closes the child's end, makes its own non-blocking and
  opens its handle on it. The child's output reaches the parent's `child.stdout` as reads of that socket, and the
  parent's writes to `child.stdin` are the child's reads of fd 0.
- **A terminal's mode is its termios** (`uv_tty_set_mode`): the first change from normal saves the termios
  (`tcgetattr`), `UV_TTY_MODE_RAW` (Node's `'raw'` and `true`, sent as `UV_TTY_MODE_RAW_VT`) clears `BRKINT ICRNL
  INPCK ISTRIP IXON`, sets `ONLCR` and `CS8`, clears `ECHO ICANON IEXTEN ISIG`, `VMIN` 1 and `VTIME` 0;
  `UV_TTY_MODE_IO` (Node's `'io'`) is `cfmakeraw`; normal restores the saved termios; each is a `tcsetattr(TCSADRAIN)`,
  which is `TCSETSW`. `uv_tty_get_winsize` is `TIOCGWINSZ`; `uv_guess_handle` is a terminal where `isatty` holds
  (`TCGETS` answers), else by `fstat`. At exit Node restores the termios each terminal fd had at its start
  (`ResetStdio`, `tcsetattr(TCSANOW)`, its failure ignored), so a program that ends in raw mode leaves its terminal as
  it found it.

### What the engine did

- A child's `'pipe'` entry was the engine's pairing (`LibuvStreamWrap.pair`): only an IPC entry of a process with
  socket calls was a kernel socketpair (ADR-0009 §4). The child's fd 1 and 2 reached the parent's handle through the
  run's sinks (`RunRequest.stdout`, `stderr`), and the parent's writes to fd 0 through `writeStdin`; a child a host
  ran in another realm got those sinks as `NodeProcessLaunch.streams` or `ChildProcessHostRequest`'s callbacks, and
  the host relayed them as messages (browser-substrate's `CHILD_STDIO_RELAY`).
- `'inherit'` and a number were the parent's sinks; `'ignore'` dropped the bytes; a `'wrap'` entry at 0 to 2 was given
  nothing; an `'fd'` entry past 2 was given nothing.
- `setRawMode` did nothing (`proc.stdin.setRawMode` returned the stream; `TTY.setRawMode` answered 0, or `ENOTSUP` on
  the engine's own pty endpoints), and a TTY handle's window was its engine pty's or 80 by 24.

### What the substrate holds (browser-substrate at 7cd0f130e3d)

- Every host image reads and writes its fds 0 to 2 through its own instance of the kernel
  (`packages/node/src/kernel-standard-streams.ts`): Tabnode's `onStdoutBytes` and `onStderrBytes` are `write(2)` of fd
  1 and 2, `stdinReader` is `read(2)` of fd 0, `stdioKind` is each fd's `fstat` (a character device answering `TCGETS`
  a terminal), and the terminal's size is `TIOCGWINSZ`, read again at each SIGWINCH. Its `KernelTerminal.setRawMode`
  is a `TCSETSW` of fd 0 with libuv's raw termios, normal restoring the termios before the first.
- A child the realm's registry forked is made ready by `readyKernelChild` (`packages/wali/src/kernel-file-calls.ts`,
  through `KernelVirtualFS.issueChild`): each `{ fd, from }` of its descriptors is a `dup2` of its fork's copy of
  `from`, made as libuv's child places them, and then the exec's close-on-exec closes run.
- The attached terminal is a pty's master and a run's fds 0 to 2 its slave (pty.c), so its line discipline, echo and
  signal characters are the kernel's for every process of the run.

## Decision

### 1. A process with socket calls places its child's stdio as libuv does

Where the spawning process's tree offers socket calls (`TREE_SOCKETS`, so its descriptors are a kernel's), `Process.spawn`
(`src/node-lib/binding/process_wrap.ts`) makes each stdio entry what `uv__process_init_stdio` makes it, in the
parent's own table before the child's fork, and lists each in `RunRequest.kernelDescriptors` as `{ fd, from }`: the
child's `fd` is the parent's descriptor `from`.

- **`'pipe'` (IPC or not) is a kernel socketpair** (`AF_UNIX`, `SOCK_STREAM`, close-on-exec, 64 KiB `SO_RCVBUF` and
  `SO_SNDBUF` at both ends): Node's handle is the parent's end, non-blocking, and the other end is the child's.
- **`'inherit'` and a number** are the parent's descriptor of that number. A number the parent's run was started with
  as a kernel stream (its channel) is that stream's descriptor. A descriptor the parent does not hold fails the spawn
  with the call's `EBADF`, as the child's `dup2` fails libuv's.
- **`'wrap'`** (a stream handed as stdio) is the stream's descriptor (`uv__stream_fd`), where it is a kernel one.
- **`'ignore'` at 0 to 2 is `/dev/null`**, opened through the tree's descriptor calls (read-only for 0, read-write for
  1 and 2, close-on-exec as the tree's `open` makes every file) and given to the child at that number.

A process whose tree offers no socket calls keeps the engine's pairing and its sinks (ADR-0009 §5), and
`kernelDescriptors` is empty.

### 2. A child a host runs as its own process takes them; the parent keeps only its ends

The runner (`startChildRun`, `src/shims/child_process.ts`) knows at the start which child it hands to a host that
runs it as its own process: a Node child the process host admits (`runHostedNode`), and any child the host's
executor runs (every program but the engine's own Node). For such a child the start answers
`StartedRun.startedWithDescriptors`, and:

- **The host places them.** A Node child's `NodeProcessLaunch.descriptors` is `kernelDescriptors`; any other child's
  is `ChildProcessHostRequest.kernelDescriptors`, the same `{ fd, from }` records. The host makes the child ready as
  `readyKernelChild` does: its `fd` a `dup2` of its fork's copy of `from`.
- **Each of the child's fds 0 to 2, and each socketpair end, is made blocking** before the parent lets go of it, as
  `uv__process_child_init` makes 0 to 2 and as `uv_socketpair(..., 0, 0)` makes a pipe's child end: a host image
  writes its fd 1 with `write(2)` and reads its fd 0 with `read(2)` (ADR-0227 §7), which must block where a pipe is
  full or empty. The flag is the description's, so this is done on the parent's number for it.
- **The parent closes what it made for the child** (each socketpair's child end and each `/dev/null`) once the
  start has returned: the child's fork holds its own copies (the registry forks it when the runner numbers it, before
  the start returns), as libuv's parent closes the child's end after `fork`. Node's handles keep only the parent's
  ends, which read the child's output and EOF when the last copy of the child's end closes, as on Linux.
- **Nothing of a placed fd crosses the run's sinks.** The parent reads none of the child's fd 0 into `writeStdin`; a
  hosted Node child's `streams` carries no sink for an fd it was given (`onStdout`, `onStdoutBytes`, `onStderr`,
  `onStderrBytes`, `stderrIsPipe`, `stdinOpen`), and no input stream is made for its fd 0; a host executor's child is
  given no live input, and none of its pipes past fd 2 is relayed (`ChildProcessHostRequest.descriptors` names only
  the engine's pairings). Such a child always goes to the host: the executor's `bypass` is not read for it, since its
  descriptors are placed for a process.

A child the engine runs in its own realm (the engine's own `node` without a process host, a command of the engine's
shell) is no process with a table of its own: the parent's realm serves the child's ends for it, through the sinks
as before (the child's writes are writes to its kernel end, the parent's writes to fd 0 reads of it).

### 3. A terminal's mode is set through the run's terminal

- `RunStreams.terminal` gains `setRawMode?(mode: false | 'raw' | 'io')`: fd 0's terminal mode, set by the host as
  `uv_tty_set_mode` sets it (`'raw'` libuv's raw termios, `'io'` `cfmakeraw`, `false` the termios before the first
  change), throwing an error whose `errno` is the call's negative errno where it cannot (`ENOTTY`).
- A run whose fd 0 is a terminal answers `process.stdin.setRawMode(mode)` as Node's `tty.ReadStream.setRawMode` does:
  `true` is `'raw'`, another string than `'raw'` or `'io'` throws `ERR_INVALID_ARG_VALUE`, a failure emits `'error'`
  with an `ErrnoException` for `setRawMode`, and `isRaw` and `rawMode` say the mode set. A `TTY` handle on fd 0
  (`new tty.ReadStream(0)`) sets it the same way through `setRawMode(UV_TTY_MODE_*)`, answering the errno. A host that
  gives no `setRawMode` keeps the old answer (no mode is claimed), and the engine's own pty endpoints keep `ENOTSUP`.
- At a run's end a mode it set is put back to normal, as Node's `ResetStdio` restores its terminal, its failure
  ignored.
- A `TTY` handle on fd 0, 1 or 2 answers `getWindowSize` from the run's terminal, whose `columns` and `rows` the host
  keeps (`TIOCGWINSZ`, read again at SIGWINCH); whether an fd is a terminal is the host's `stdioKind`, its `fstat`.

The line discipline, echo and signal characters are the pty's (browser-substrate's pty.c); the engine keeps no mode
of its own and reads its fd 0 as the kernel's `read(2)` delivers it.

### 4. What the substrate does with it

- Binds `kernelDescriptors` into the child's start: a Node child's `NodeProcessLaunch.descriptors` already reaches
  `issueChild`; a program child's `ChildProcessHostRequest.kernelDescriptors` is passed to `issueChild` beside its
  image, where today it passes `nodeProcess?.descriptors` only.
- Deletes the child stdio relay (`CHILD_STDIO_RELAY`): a child's fds 0 to 2 and its pipes past 2 are its process's
  descriptors, read and written by its own image.
- Accepts `'io'` in `KernelTerminal.setRawMode` (`cfmakeraw`).

## Where the evidence stops

- **Read:** Tabnode at 5224b95; browser-substrate at 7cd0f130e3d (ADR-0227 §7, `kernel-standard-streams.ts`,
  `readyKernelChild`, `cross-origin-container-worker.ts`'s `requestPageChild` and Node entry bridges, f11f54de967 and
  its revert 4411407ede4); Node v24.21.0's `deps/uv/src/unix/process.c` (`uv__process_init_stdio`,
  `uv__process_open_stream`, `uv__process_child_init`), `deps/uv/src/unix/tty.c` (`uv_tty_set_mode`,
  `uv_tty_get_winsize`, `uv_guess_handle`), `src/tty_wrap.cc`, `src/node.cc` (`ResetStdio`) and `lib/tty.js`.
- **Not run.** The engine side is written; nothing was run against a kernel.
- **Not built: `spawnSync`.** libuv's synchronous spawn reads the parent's pipe ends in a loop of its own while the
  child runs. The engine's synchronous child is the host's synchronous door (`runSync`), which blocks this realm
  until the child ends and hands its output to `onStdout` and `onStderr`; with no blocking readiness call in
  `TreeSockets` (its `wait` is a promise), a realm blocked there cannot read its own ends, and a child that filled a
  64 KiB pipe would never end. Its stdio stays the host's door's, which is not the child stdio relay.
- **Extrapolation:** that every child a host's executor runs is forked by the realm's registry before the start
  returns (true of the substrate's `KernelRealmProcessRegistry`, read; not of a host that numbers a child later), so
  the parent's close after the start never ends the child's copy.
