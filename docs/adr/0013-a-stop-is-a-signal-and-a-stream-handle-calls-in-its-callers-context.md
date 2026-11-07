# ADR-0013: A process stop is a signal; a program's stream handle calls it in its caller's context

Status: Accepted

Date: 2026-11-06.

## 1. A process stop is a signal delivered to the process

**Purpose.** A host that stops a named run asks the process to end exactly as another process's `kill(pid)` asks it,
and the run settles as it ends: by the signal's default action, or by its own handler's `exit`.

**Callers, by grep.** In Tabnode, `container.stopProcess(token)` (`index.ts`) is a public door with no internal
caller. Its siblings deliver signals first: `signalProcess` is `__signalOwnedProcess`; a job's `kill`
(`shims/child_process.ts`) and a shell job's `kill` (`shims/shell-jobs.ts`) call `__signalOwnedProcess`/`signalPid`
first and end the job at once only where nothing of it receives signals (a builtin). In browser-substrate (at
`kernel-step2`), its callers are the container worker's `abort` (`packages/node/src/cross-origin-container-worker.ts`,
Docker's kill, which also aborts the run with the signal) and the toolchain's run (`packages/node/src/tabnode-toolchain.ts`:
`stopOnKill`, which also aborts the run, and the cleanup of a run whose execution has settled, which holds no ports).
They need the named run to stop and `run()` to settle naming the signal, and the ports `stopProcess` releases
readable at once. `docker stop`'s grace and SIGKILL are not this door's: the substrate's Docker engine stops a
container as moby's `containerStop` does (`packages/runtime/src/docker-engine.ts`, `stop`: the stop signal or the host's
own graceful stop, then SIGKILL once its seconds have passed, 10 by default as moby's `defaultStopTimeout`), and its
host preparation's `stopMain` is the service owner's graceful stop (`packages/host-node/src/prepared-service.ts`), not
this door.

**Reference.** Node v24.21.0: `ChildProcess.prototype.kill` sends `'SIGTERM'` when no signal is given
(`lib/internal/child_process.js:534-546`), as `process.kill(pid)` does (`lib/internal/process/per_thread.js:254-279`).
The target's listeners for the signal run; with none its default action ends it. Linux records a process a signal
ended as `WIFSIGNALED` with that signal, and a shell reports it as `128 + n` (POSIX XCU 2.8.2), as moby reports a
container's (`ExitCode` 143 for SIGTERM); Node's `ChildProcess` reports it as exit code `null` and the signal. An ended
process stays a process until its parent reaps it (a zombie): `kill` of it succeeds and nothing of it runs. The
engine's guest `process.kill` of its own pid is that delivery: a listener runs, else the termination is recorded and
the run `exit`s `128 + n` (`shims/process.ts`, `kill`).

**Interface.** `stopProcess(token)` is `kill(pid, 'SIGTERM')` delivered to the named run (`__signalOwnedProcess`, raised
through the guest's own `process.kill` inside its run). Its default action reaches the run's `exit`, which ends the
process inside the delivery: its `exit` releases its servers, handles and timers at once (`__endOwnedProcess`, ADR-0011
§6). A guest with a SIGTERM handler keeps running, as in Node. Where nothing of the named run receives signals (no
guest is recorded under the token), the run ends now through the process's end release, as a job's `kill` ends a
builtin. It answers true when the name was a run or held ports.

**Result.** `run()` settles with the status a host reads from `waitpid`: `exitCode` `128 + n` and `signal` naming the
signal (`{ exitCode: 143, signal: 'SIGTERM' }`), the `RunResult` every run answers (`exitCode` is a number; a guest's
`ChildProcess` of such a run reports `null` and the signal, as Node's does). browser-substrate reads it so
(`shellStatus`).

**Completion.** The run's record and its pid stay until its end completes: its native teardown, which reports a throw
as the run's (ADR-0011 §6), then its parent's reap (ADR-0010 §2's table, rows 5 and 1), as a Linux zombie's pid stays
until its parent waits.

**Invariants.** `stopProcess` never ends a run that took the signal and handled it. A run that took the default action
has exited before `stopProcess` returns: its ports, handles and timers are gone (the exit is synchronous inside the
delivery). A second call before the reap reaches the ended process, which takes the signal and runs nothing: no
handler and no second end.

## 2. A program's stream handle calls it in its caller's guest context

**Purpose.** A TLS socket over a stream with no handle of its own (a JavaScript Duplex, an unconnected socket) runs that
stream as a libuv stream handle (`node-lib/binding/duplex_stream.ts`, `DuplexStreamHandle`), as Node's
`JSStreamSocket` does, and every call the handle makes into the program's stream runs in the guest context of the call
that caused it.

**Callers, by grep.** One constructor, `shims/tls.ts` (`new DuplexStreamHandle(socket, process)`, the process that made
the TLS socket). Its handle methods are called by the TLS wrap and by `LibuvStreamWrap`'s writers, readers and close:
`readStart`, `readStop`, `writeBuffer` (its `dispatchWrite`), `shutdown` and `close` (its `onCloseHandle`).

**Reference.** Node v24.21.0, `lib/internal/js_stream_socket.js:48-266` and `src/js_stream.cc`:
- A `data` chunk is `handle.readBuffer`, which emits the read synchronously inside the stream's own listener
  (`JSStream::ReadBuffer`, `js_stream.cc:167-195`); `end` is `emitEOF` (197-201). The stream is paused only by
  `readStop` (`stream.pause()`) and resumed only by `readStart` (`stream.resume()`, `js_stream_socket.js:115-123`), both
  called through `MakeCallback` from the reader's own call (`js_stream.cc:59-86`).
- `DoWrite` copies the buffers and calls JavaScript `onwrite` through `MakeCallback` inside the writer's call
  (`js_stream.cc:111-141`); `doWrite` corks, writes every buffer with `stream.write` and uncorks in that call, and holds
  the request (`kCurrentWriteRequest`) only after those calls, "because the `write()` calls could throw"
  (`js_stream_socket.js:174-203`); its completion is a turn later (`setImmediate` from the stream's write callback,
  `finishWrite`), an error's code `UV_<err.code>`, else `UV_EPIPE` (205-240).
- `doShutdown` with a write held keeps the request (`kPendingShutdownRequest`); `finishWrite` calls `doShutdown` with
  it after completing the write, inside that write's completion. A shutdown with no write held becomes
  `kCurrentShutdownRequest`, and `stream.end()` runs on a `process.nextTick` of the caller, its callback finishing the
  request (127-172). `finishWrite` and `finishShutdown` do nothing for a request no longer held (165-172, 227-232).
- `doClose` destroys the stream at once and finishes a held write and shutdown `UV_ECANCELED` a turn later (242-266);
  the stream's own `close` destroys the socket, which closes the handle (88-92).

**Interface.** `dispatchWrite` calls the stream's `write` once with a copy of the whole buffer, synchronously inside the
writer's call, so in the writer's guest context; its completion is the binding's `oncomplete` on the next turn, as the
engine's stream writes complete; a stream error's code is `UV_<code>`, else `UV_EPIPE`. A `data` chunk is delivered at
once inside the stream's `data` listener and `end` is EOF; `readStop` pauses the stream and `readStart` resumes it, in
the reader's call, and no chunk pauses it.

- **Requests are held from admission to their one answer.** The handle holds at most one write, one shutdown waiting
  on it and one current shutdown, Node's three slots. A write is held from its `write`'s return (a `write` that
  throws holds nothing, and its throw is the writer's) to its completion. A waiting shutdown is held until that
  write completes, and is then dispatched. A dispatched shutdown is held from its call, through its tick, to its
  `end` callback. `close`, and the stream's own `close`, take every request held and answer each `UV_ECANCELED` on
  the next turn, the write before the shutdowns. An answer that arrives for a request no longer held (a late write
  or `end` callback after a cancel) is ignored.
- **Each deferred call carries its context.** A shutdown with no write held queues the stream's `end` on the making
  process's `process.nextTick`, which carries the shutdown caller's context and its process (its frame, its uncaught
  report, its end), as Node's `doShutdown` does. A waiting shutdown is dispatched inside the context its write
  completed in, captured at the stream's write callback, as Node's `finishWrite` dispatches it from the write's
  completion; its tick then carries that context.

**Invariants.** No call into the stream is made from a binding task; each runs in the guest context of the call that
caused it; one write request is one `write` of the stream; every request held gets exactly one answer.

## Where the evidence stops

- **Read:** the Node v24.21.0 files named above; Tabnode's `index.ts`, `process-tokens.ts`, `shims/process.ts`,
  `shims/child_process.ts`, `shims/shell-jobs.ts`, `shims/tls.ts`, `node-lib/binding/duplex_stream.ts`,
  `stream_wrap.ts` and `uv.ts`; browser-substrate `kernel-step2`'s callers named in §1 and moby's `daemon/stop.go`
  (`containerStop`) and `daemon/config/config.go` (`defaultStopTimeout = 10`) at master `402d0a16f131`; browser-substrate
  `@volter/browser-runtime`'s `shellStatus`.
- **Not run.**
