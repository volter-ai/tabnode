# Objective proof scope: Node v24.21.0

The immutable behavior denominator is
[`node24-test-files.json`](node24-test-files.json): **4,569 exact paths**, 4,543
in `test/parallel` and 26 in `test/wasi`, from nodejs/node commit
`955266bfdd854cd280dffd47548673914484e4c0` (tag `v24.21.0`). The file was
extracted from that commit's complete Git tree. It includes `.js` and `.mjs`
test programs and every module, including modules the engine cannot load.
The runner verifies both the checkout commit and its exact file list; a
missing, extra, or duplicate file is an enumeration error, not a smaller
successful denominator. Auxiliary `testcfg.py`, status files and the WASI
Makefile are not test programs. Module-hooks measurements are supplementary
and do not replace either required directory.

## One baseline, four completion counts

`measure` uses a production bundle and real Node **24.21.0** as its host.
It records four counts, all of which must reach zero:

| Count | Objective evidence | Completion |
|---|---|---|
| Unresolved native reads | AST inventory of `internalBinding` and hand-bound internal reads, with every unresolved dynamic flow named | zero |
| Unclassified native entries | Every inventory entry classified IMPLEMENTED with source/behavioral evidence, or REFUSING with an exact error and linked limitation | zero |
| Unattributed test failures | Every file in the immutable list, with exit code, signal, timeout, full stderr | zero |
| Unattributed public differences | Recursive real Node / engine export graphs: members, prototypes, types, arity, shared references; unobserved accessors remain open | zero |

`native-surface.mjs` records unsupported data flow instead of claiming the
native surface is complete. `native-classifications.json` records exact
entry classifications; existence of a JavaScript function alone does not
establish its behavior. The first baseline has no preaccepted classifications.
`public-surface.mjs` constructs its denominator from real Node independently
of engine success. Missing engine modules retain every enumerable reference
member. Cycles and aliases are represented as graph references, not a
recursion-depth cutoff. Accessor descriptors are recorded without invoking
possibly stateful getters; their return types remain unmeasured/open.

## Capability ledger

`measurement/CAPABILITIES.md` and `capabilities.json` are generated from the
same evidence as the counts. Every row is **done**, **doing**, **todo**, or
**won't do**. Passing tests establish their exercised behavior; matching
public rows establish their shape. These are separate rows, not one global
claim that a function is behaviorally complete because its name exists.
`parity-work.json` identifies exact rows currently being worked on.

A limitation is declared once in [`../LIMITATIONS.md`](../LIMITATIONS.md),
with Node's behavior, the unavailable browser API or retained measurement,
exact test/native/public entries, and an observed failure signature per test.
No globs, generic absent-module exemptions, prose-only remainder claims, or
subjective scores are counted. An independent non-author check of limitation
evidence remains required by the brief; it is not a scored test. An overturned
entry stops exempting its rows.

The finalized scope count is available only after native enumeration and the
real Node public reference have no unresolved discovery. Until then, the
ledger explicitly prints `Scope enumeration finalized: no`; undiscovered
members are not counted as zero. Test failures and public mismatches can still
be measured while enumeration is incomplete.

## Reproduce the workflow

    git clone --filter=blob:none --no-checkout https://github.com/nodejs/node.git ../node-tests
    git -C ../node-tests sparse-checkout set test/common test/parallel test/fixtures test/wasi test/module-hooks test/es-module
    git -C ../node-tests checkout v24.21.0
    npm ci
    npm run build:lib
    node scripts/native-surface.mjs --out measurement/native.json
    node scripts/public-surface.mjs --out measurement/public.json
    node scripts/node-tests.mjs --tests ../node-tests --all --report-json measurement/results.json
    node scripts/node-test-report.mjs --out measurement
    node scripts/capability-ledger.mjs --out measurement

The workflow uploads the full ledger, raw results and graphs, and prints the
passing, failing-named and failing-unnamed lists plus per-module counts. The
headline is the unnamed failure count. It retains four completion counts and
the four ledger states; it does not gate publishing.

The runner uses four concurrent isolated guests and an 8,000 ms per-file
limit, recorded with each measurement. A timeout remains a failure. The host
filesystem mounts fixtures into `/workspace/app`; each guest has a private
virtual write layer. The host binary and the engine are separate public
snapshot processes, so engine global changes cannot contaminate the reference.

## Diagnostic subsets and browser qualification

    node scripts/node-tests.mjs --tests ../node-tests --match test-net- --list-failures
    node scripts/node-tests.mjs --tests ../node-tests --dir test/wasi --match test-

A subset is never the full number. `--prelude` is diagnostic only; `--all`
refuses it and refuses narrowed directory/prefix options. The historical
`diagnostic-prelude.cjs` cannot exempt or turn a failing test into a measured
pass. Measurements here execute the engine in host Node with a browser-shaped
window installed after import. They do **not** prove execution in an actual
browser tab, the substrate's worker transport, or unrestricted native Node
behavior. Those claims require their own objective browser evidence.

After downloading a complete workflow artifact, reconcile its generated
coverage blocks using `node scripts/node-test-report.mjs --out <artifact>
--update-docs --commit <measured-sha>`. README and BUILTINS use the same
limitations source as the measurement, rather than a second exception list.
