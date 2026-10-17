# Known limitations of Node 24 in a browser realm

This is the single source for named exceptions in the measurement. An absent
implementation is an open defect, not evidence of a browser constraint.
No failures have been exempted yet. Historical remainder descriptions in
`BUILTINS.md` do not exempt any Node 24 test.

Each limitation is a fenced `json` object with `id`, `kind` (`harness` or
`platform`), `nodeBehavior`, `reason`, `evidence` (source URLs or a retained
measurement), `tests` (exact paths from `scripts/node24-test-files.json`),
`failureIncludes` (an observed error signature for each named test),
`nativeEntries`, and `publicEntries`. No globs or module-wide exemptions.
Native refusals also name `errorCode`. A match applies only to the observed
failure, so a different defect in the same file remains open.

Every entry needs an independent non-author review answering whether the
behavior can be implemented in a browser. A `review` records `reviewer`,
`verdict` (`confirmed` or `overturned`), and `evidence`. Pending review is
printed separately and prevents a completion claim; overturned entries do
not exempt anything.

The workflow's `measurement/coverage.md` generates the exceptions statement
from this file and the four measured counts. `README.md` and `BUILTINS.md`
carry the same generated block after a measured result is reconciled.
