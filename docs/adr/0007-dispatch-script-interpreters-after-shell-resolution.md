# ADR-0007: Dispatch script interpreters after shell resolution

Status: Superseded for current work by Substrate ADR-0215 and its Step 3.

Card: VO-3806 `t_c656e6fd`, V1-02 `t_b67e1a68`; independent PR17 finding F6.
Substrate Articles 6 and 9. Proposed 2026-11-01.

## Current disposition

The accepted [Substrate ADR-0215](https://github.com/volter-ai/browser-substrate/blob/07f317f3/docs/adr/0215-the-v1-target-shape.md)
and [Step 3](https://github.com/volter-ai/browser-substrate/blob/07f317f3/ROADMAP.md#step-3-the-five-references-run-from-main-with-nothing-overlaid)
define the current shell direction. Step 3 first runs the five references from reviewed main. It records legacy
just-bash behavior rather than completing the shell contract, unless a correction is needed to meet that step's
application bar.

The engine uses upstream `just-bash` 2.14.5. When an embedding supplies the existing executable/shell host, that host
owns non-Node executable selection and execution. This route requires no supplier fork or supplier publication.
Executable selection in the legacy BrowserShell fallback remains a gap for Step 3's contract reading.

ADR-0215's final target is catalog GNU Bash and BusyBox through the kernel; this disposition does not claim
that target is implemented or that shell compatibility is complete. Its Python lane is Pyodide.
