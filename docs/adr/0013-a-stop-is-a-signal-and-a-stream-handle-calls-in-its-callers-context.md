# ADR-0013: A process stop is a signal; a program's stream handle calls it in its caller's context

Status: Accepted

Date: 2026-11-06.

## 1. A process stop is a signal delivered to the process

**Purpose.** A host that stops a named run asks the process to end exactly as another process's `kill(pid)` asks it,
and the run settles as it ends: by the signal's default action, or by its own handler's `exit`.

**Callers, by grep.** In Tabnode, `container.stopProcess(token)` (`index.ts`) is a public door with no internal
caller. Its siblings already deliver signals first: `signalProcess` is `__signalOwnedProcess`; a job's `kill`
(`shims/child_process.ts`) and a shell job's `kill` (`shims/shell-jobs.ts`) call `__signalOwnedProcess`/`signalPid`
first and end the job at once only where nothing of it receives signals (a builtin). In browser-substrate (at
`kernel-step2`), its callers are the container worker's `abort` (`packages/node/src/cross-origin-container-worker.ts`,
Docker's kill, which also aborts the run with the signal) and the toolchain's run (`packages/node/src/tabnode-toolchain.ts`:
`stopOnKill`, which also aborts the run, and the cleanup of a run whose execution has settled, which holds no ports).
They need the named run to stop and `run()` to settle naming the signal, and what `stopProcess` answers (its ports,
its pid) readable at once. `docker stop`'s grace and SIGKILL are not this door's: the substrate's Docker engine stops a
container as moby's `containerStop` does (`packages/runtime/src/docker-engine.ts`, `stop`: the stop signal or the host's
own graceful stop, then SIGKILL once its seconds have passed, 10 by default as moby's `defaultStopTimeout`), and its
host preparation's `stopMain` is the service owner's graceful stop (`packages/host-node/src/prepared-service.ts`), not
this door.

**Reference.** Node v24.21.0: `ChildProcess.prototype.kill` sends `'SIGTERM'` when no signal is given
(`lib/internal/child_process.js:534-546`), as `process.kill(pid)` does (`lib/internal/process/per_thread.js:254-279`).
The target's listeners for the signal run; with none its default action ends it, and a process ended by a signal reports
exit code `null` and the signal (the engine's run result does: `__takeTermination` in `startRun`). The engine's guest
`process.kill` of its own pid is that delivery: a listener runs, else the termination is recorded and the run `exit`s
`128 + n` (`shims/process.ts`, `kill`).

**Interface.** `stopProcess(token)` is `kill(pid, 'SIGTERM')` delivered to the named run (`__signalOwnedProcess`, raised
through the guest's own `process.kill` inside its run): its default action reaches the run's `exit`, whose end releases
its servers, handles and timers, and `run()` settles with `exitCode: null, signal: 'SIGTERM'`; a guest with a SIGTERM
handler keeps running, as in Node. Where nothing of the named run receives signals (no guest is recorded under the
token), the run ends now through the process's end release, as a job's `kill` ends a builtin. It answers true when the
name was a run or held ports.

**Invariants.** `stopProcess` never ends a run that took the signal and handled it; a run that took the default action
has settled, its ports and pid gone, before `stopProcess` returns (the exit is synchronous inside the delivery); a second
call finds nothing to do.

**Deleted.** `stopProcess`'s own release-then-cancel sequence, now the signal, with the end release only for a run that
receives no signals.

## 2. A program's stream handle calls it in its caller's guest context

**Purpose.** A TLS socket over a stream with no handle of its own (a JavaScript Duplex, an unconnected socket) runs that
stream as a libuv stream handle (`node-lib/binding/duplex_stream.ts`, `DuplexStreamHandle`), as Node's
`JSStreamSocket` does, and every call the handle makes into the program's stream runs in the guest context of the call
that caused it.

**Callers, by grep.** One constructor, `shims/tls.ts` (`new DuplexStreamHandle(socket)`). Its handle methods are called
by the TLS wrap and by `LibuvStreamWrap`'s writers, readers and close: `readStart`, `readStop`, `writeBuffer` (its
`dispatchWrite`), `shutdown` and `close` (its `onCloseHandle`). Its calls into the stream were: `write` from a queued
binding task, with no guest bracket; `pause` in the constructor, on every `data` chunk and in `readStop`; `resume` from
a queued flush (the `flushInbound` override); `end` in `shutdown`; `destroy` in `onCloseHandle`.

**Reference.** Node v24.21.0, `lib/internal/js_stream_socket.js:48-262` and `src/js_stream.cc`:
- A `data` chunk is `handle.readBuffer`, which emits the read synchronously inside the stream's own listener
  (`JSStream::ReadBuffer`, `js_stream.cc:167-195`); `end` is `emitEOF` (197-201). The stream is paused only by
  `readStop` (`stream.pause()`) and resumed only by `readStart` (`stream.resume()`, `js_stream_socket.js:115-123`), both
  called through `MakeCallback` from the reader's own call (`js_stream.cc:59-86`).
- `DoWrite` copies the buffers and calls JavaScript `onwrite` through `MakeCallback` inside the writer's call
  (`js_stream.cc:111-141`); `doWrite` corks, writes every buffer with `stream.write` and uncorks in that call
  (`js_stream_socket.js:174-224`); its completion is a turn later (`setImmediate`, `finishWrite`), an error's code
  `UV_<err.code>`, else `UV_EPIPE`.
- `doShutdown` waits for a pending write, then `stream.end()` on a `process.nextTick` of the caller (125-160);
  `doClose` destroys the stream at once and finishes a pending write or shutdown `UV_ECANCELED` a turn later (241-262).

**Interface.** `dispatchWrite` calls the stream's `write` once with a copy of the whole buffer, synchronously inside the
writer's call, so in the writer's guest context; its completion is the binding's `oncomplete` on the next turn, as the
engine's stream writes complete; a stream error's code is `UV_<code>`, else `UV_EPIPE`. A `data` chunk is delivered at
once inside the stream's `data` listener and `end` is EOF; `readStop` pauses the stream and `readStart` resumes it, in
the reader's call, and no chunk pauses it. `shutdown` waits for a pending write, then defers the stream's `end` to a tick
of the caller's process. `close` destroys the stream at once and finishes a pending write or shutdown `UV_ECANCELED` on
the next turn; the stream's own `close` finishes a pending write `UV_ECANCELED`.

**Invariants.** No call into the stream is made from a binding task; each runs in the guest context of the call that
caused it; one write request is one `write` of the stream.

**Deleted.** The 64 KiB chunk loop and its `next` queued as a binding task (Node writes the whole buffer in the writer's
call); the pause on every `data` chunk and the `flushInbound` override that resumed from a queued flush; the
`UV_ECONNRESET` given for every write and stream error, now the stream error's own code.

## Where the evidence stops

- **Read:** the Node v24.21.0 files named above; Tabnode's `index.ts`, `process-tokens.ts`, `shims/process.ts`,
  `shims/child_process.ts`, `shims/shell-jobs.ts`, `shims/tls.ts`, `node-lib/binding/duplex_stream.ts`,
  `stream_wrap.ts` and `uv.ts`; browser-substrate `kernel-step2`'s callers named in §1 and moby's `daemon/stop.go`
  (`containerStop`) and `daemon/config/config.go` (`defaultStopTimeout = 10`) at master `402d0a16f131`.
- **Not run.**
