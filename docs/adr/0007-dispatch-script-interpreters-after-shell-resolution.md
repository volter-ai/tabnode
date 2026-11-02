# ADR-0007: Dispatch script interpreters after shell resolution

Status: Superseded for current work by Substrate ADR-0215 and its Step 3.

Card: VO-3806 `t_c656e6fd`, V1-02 `t_b67e1a68`; independent PR17 finding F6.
Substrate Articles 6 and 9. Proposed 2026-11-01.

## Current disposition

The accepted [Substrate ADR-0215](https://github.com/volter-ai/browser-substrate/blob/07f317f3/docs/adr/0215-the-v1-target-shape.md)
sets the shell contract for [Step 3](https://github.com/volter-ai/browser-substrate/blob/07f317f3/ROADMAP.md#step-3-the-five-references-run-from-main-with-nothing-overlaid).
The current Step 3 ruling on VO-3806 (manager event 167471) requires the image's selected real GNU Bash and
BusyBox on WALI now. Image CMD and shebang execution, and Node
operations requesting a shell (`child_process.exec` and `spawn` with `shell: true`), belong to the supplied host
through the kernel's process and descriptor doors.

The host resolves a program when it executes, using the shell's live PATH and cwd. It carries the selected
program's literal argv, cwd, environment, stdio, status, cancellation and limits through those existing owners.
A missing selected program refuses; no JavaScript shell fallback answers it. This is the current Step 3
requirement, including the F6 executable-selection obligation.

The engine archive still bundles upstream `just-bash` 2.14.5. That dependency is a contract difference; it does
not authorize its use for Step 3 commands. The host-owned route needs no supplier fork or supplier publication.
The Python lane is Pyodide.
