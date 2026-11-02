# ADR-0007: Dispatch script interpreters after shell resolution

Status: Proposed.

Card: VO-3806 `t_c656e6fd`, V1-02 `t_b67e1a68`; independent PR17 finding F6.
Substrate Articles 6 and 9. Proposed 2026-11-01.

## Cause and supplier boundary

Linux executes an executable script through its shebang interpreter. The engine delegates shell parsing,
function/builtin precedence, expansion, executable permissions, PATH lookup and command hashing to `just-bash`.
Its `src/interpreter/subshell-group.ts` `executeUserScript` reads the resolved executable, removes its shebang,
and parses the rest as shell. It does not dispatch the named interpreter.

The engine's current `src/shims/package-bins.ts` tries to compensate by rewriting a complete syntax tree before
execution. That freezes the pathname using the initial cwd/PATH. With `/a/tool` and `/b/tool` present,
`export PATH=/b:$PATH; tool` can run `/a/tool`; `cd sub; tool` can select a parent directory's relative PATH entry.
Expanding the transform's exceptions cannot restore execution-time resolution. A filesystem `readFile` hook is
also insufficient: the supplier uses the same read for script execution, `source`, and input redirection.

The installed supplier's public `BashOptions`, custom-command and transform APIs expose no script-execution
callback. Its private interpreter is not exported. The correction belongs in the supplier's source, at
`Interpreter.executeUserScript` after its own command resolution and before its script reader/parser. There is
no package-specific rule and no change to vendored Node JavaScript.

Source receipt, read directly from npm's publication provenance and the supplier repository:

| Item | Exact source |
|---|---|
| Current dependency | npm `just-bash` 2.14.5 |
| Repository | <https://github.com/vercel-labs/just-bash> |
| Source commit | `2bbbfaf8cc769109361ba29b55f5647a43988b14` |
| Package root at that commit | `packages/just-bash/` |
| Registry tarball | <https://registry.npmjs.org/just-bash/-/just-bash-2.14.5.tgz> |
| Registry integrity | `sha512-MCBGnRlDeZ/MM7mcw+ZuSGFMBsggajrmKz6e/hrOAN7syvVZkjiY+Vh2wyCwN/CdcnAX5SxbiQB51n5nrQuX+g==` |
| Provenance | <https://registry.npmjs.org/-/npm/v1/attestations/just-bash@2.14.5> |
| Supplier licence | Apache-2.0; preserve its licence, notices and modification notices |

The npm provenance resolves that source commit; npm's package metadata supplies no `gitHead`. On this reading,
the `volter-ai` organization has no existing `just-bash` fork. No installed bundle has been edited.

## Decision and component owners

Maintain the small generic correction in a Volter-owned source fork, proposed repository
`volter-ai/just-bash`, starting at the exact supplier commit above. Retain upstream's source and licence history;
record the source diff and upstream base in its changelog. The source fork, rather than a transform of installed
or minified output, owns the extension. The unchanged upstream dependency remains selected until that source
and its distribution have completed the sequence below.

The supplier exposes this additive public contract, using its existing public `CommandContext` and `ExecResult`:

```ts
type ScriptExecutor = (
  resolvedPath: string,
  args: string[],
  context: CommandContext,
) => Promise<ExecResult | undefined>;

interface BashOptions {
  scriptExecutor?: ScriptExecutor;
}
```

An absent callback or an `undefined` result proceeds to the existing `executeUserScript` reader/parser. A returned
result is the script's result. A thrown error follows the supplier's existing external-command error handling;
execution-limit and security errors retain their existing propagation. Callback dispatch stays inside the same
defense context as an ordinary custom command; this contract grants no new trusted-command bypass.

Responsibilities are explicit:

| Owner | Change and retained responsibility |
|---|---|
| Supplier `src/types.ts`, `src/index.ts`, browser entry | Define and export `ScriptExecutor`; retain one public contract in both distributions. |
| Supplier `src/Bash.ts` | Store the optional callback and pass it to every interpreter, including nested `exec`. |
| Supplier interpreter options/context | Carry the callback without altering parsing, lookup, state ownership or hash behavior. |
| Supplier command-context construction | Extract the existing external-command context builder into one shared helper; retain live cwd/env, exported env, effective stdin, signal, limits, descriptor and defense fields. |
| Supplier `Interpreter.executeUserScript` | Offer the already-resolved script to the callback, then call the original script executor on `undefined`. The callback is never called for `source`, redirection, a function or a builtin. |
| Engine `src/shims/executable-header.ts` | Read at most 256 bytes through the explicitly selected tree's descriptor owner and classify the Node shebang. It owns neither PATH lookup nor launch policy. |
| Engine `src/shims/package-bins.ts` | Replace the AST transform with an execution-time callback. Accept only the plain Node forms it can execute without inventing argument or env parsing. Resolve the selected script's real path on the same tree. |
| Engine `src/shims/child_process.ts` | Supply the callback when constructing the tree's shell; call the existing `launchNode` with that tree, current context cwd/env/stdin and current run token. Reuse the launch policy of the registered `node` command. |
| Engine package metadata/lock | Select the exact reviewed supplier release only after its authorised distribution exists; continue using ordinary `just-bash` import names through an npm alias. |
| Substrate | Consume one reproducible engine/supplier closure and record the browser product proof. It does not patch either dependency. |

The callback does not recursively invoke shell text or look up `node` through the user's functions/PATH. The
shebang's interpreter is implemented by the engine's existing Node launch owner, with literal script arguments.
The shell has already chosen which executable to run using its normal function/builtin/executable precedence,
current PATH, cwd and command-hash policy. Registered commands keep the supplier's existing resolution behavior.
No copied filesystem, alternate command registry or parallel process owner is introduced.

## Distribution and integration sequence

1. Review this plan on the engine's work branch. F6 remains open. Commit the independent bounded-header,
   diagnostic and ADR-0003 corrections separately; they do not establish F6's completion.
2. Create the owned source fork at the recorded supplier base, implement the generic callback and keep its source
   receipt. Name the card/task and served articles in each source commit. Open its source PR and record its exact
   head. Do not mutate installed `node_modules`, upstream's registry tarball or a consumer bundle.
3. Prepare a candidate supplier package from that exact source head, including Node/browser entry points,
   declarations, licences and the normal dependency closure. Proposed name/version is
   `@volter/just-bash@2.14.5-volter.0`; the exact packed bytes, digest, source head and recipe become the release
   receipt. Use that source-built archive for local engine integration and product proof, recording its unpublished
   status. Preparation and proof are local; publication remains a separate act.
4. Sweep the exact retained supplier tarball with gitleaks' rules, custody values and `@volter/teams/redact`,
   resolving every hit before requesting the manager's explicit npm publication authorisation for that exact
   package and source. Preserve existing sign-ins. If custody must perform the act, name that exact package/head/tarball on the card
   and continue the engine's source work. No publication branch, tag or release dispatch moves before permission.
5. Replace the AST route with the callback in the engine source. Build the candidate from the complete exact
   source/archive closure and record the product proof below. After the supplier source review and authorised
   publication, pin the engine dependency as `"just-bash": "npm:@volter/just-bash@2.14.5-volter.0"`, retaining its
   registry integrity in the lockfile. The ready engine PR and final candidate must consume that exact publication;
   compare it with the source-built candidate before carrying any proof forward.
6. Merge only reviewed exact heads. Engine/substrate publication is a separate act with its own explicit
   authorisation and exact release-source receipt. A main merge does not advance `publish`.

The proposed supplier name/version is an integration target. Source preparation and local integration use
explicit candidate receipts; final distribution requires its exact reviewed publication. F6 stays open until its
implementation and product observations pass review. Unrecognized shebangs and unsupported Node shebang options
return `undefined` to retain the supplier's existing script behavior. Supporting additional interpreters or
argument forms requires their own implemented launch policy, rather than package-name recognition.

## Existing decisions and owner instructions

| Existing decision | Disposition |
|---|---|
| Constitution: “The engine is corrected only toward Node, at source.” | Complies: the source correction restores script interpreter dispatch for every executable of the accepted form. |
| Constitution: “The engine answers builtins, never packages.” | Complies: only the shebang is classified; no package or framework identity is read. |
| Constitution: “A builtin is Node's own file unless Node's own is native.” | Complies: no new builtin and no vendored Node JavaScript change. |
| ADR-0006: “A file Node writes is the file Bash reads, with no second VFS and no boot-time copy.” | Complies: classification and launch use the same explicit tree the shell received. |
| ADR-0003: “TCP type-of-service returns UV_ENOTSUP because virtual streams have no IP packet headers.” | Unchanged; the independent F8 fix restores that refusal. |
| Owner: “Main never publishes.” and “request explicit publication authorization before creating or advancing the separate `publish` branch, dispatching publication, or publishing.” | Complies: source preparation/review is separate from supplier, engine and substrate publication. |
| Repository: “Do not run incidental tests, suites, typechecks, lints, probes, or reviews during development.” | Complies: this plan is based on source reading. No such checks were run; product proof is performed for the ready PR as the card expressly requires. |
| Card: “Keep the owner's screen his own.” | Complies: the substrate's proof is headless/hidden or inside the card's World, in its one controlled browser tab. |
| Substrate ADR-0214: release the runnable artifact before remix | Complies: this is an engine dependency required by the existing runnable-artifact scope, with no remix or automatic artifact creation. |

No owner-locked decision is contradicted or amended by this proposal.

## Proof through the substrate's existing shell door

The root implementer records the exact engine and supplier source/distribution identities on the take. In the
substrate's real terminal/child-process door, use ordinary executable Node scripts in two directories to observe:

- `export PATH=/b:$PATH; tool` selects `/b/tool`; a relative `node_modules/.bin` entry selects the file under the
  directory reached by an earlier `cd`.
- Function and builtin precedence, non-executable files, PATH assignments on one command, a computed command
  name and an explicit executable path follow the supplier's ordinary resolution before interpreter dispatch.
- The selected Node script receives literal argv, current cwd/env/stdin and the existing process owner's
  cancellation/exit behavior. A shell script that invokes it reaches the same callback.
- `source` and input redirection read the original bytes of the same file. Ordinary shell scripts still run in
  the original executor. Unsupported shebang forms retain the stated fallback.

These observations are retained as product clips and stills on the card, and do not establish wider shell or
Node compatibility. No proof or supplier build has been run for this plan.
