# Releasing

Main merges integrate source. Publication is a separate, explicitly authorized
act on `publish`, consuming an existing source-built tarball. No workflow runs
on main, tags or publish, and the publisher installs, builds and versions nothing.
This is the retained-output route in Browser Substrate ADR-0214/V1-08 and
ADR-0102; `scripts/release.sh` wraps its receipt command.

## Prepare and authorize the exact bytes

Prepare the chosen semver, lockfile, changelog and API documentation in an owned
source tree. Keep the fork's semver rule: a fix is a patch; an exported-surface
or prepared-format change is a minor release. Select a version beyond registry
versions and every retained receipt, including unknown uploads. A failed lookup
does not establish an unused version.

Build the library, declarations and required `dist/surface.json` from the
recorded source outside CI. Surface production retains its pinned Node 24.21.0
and its original native/public/probe inputs; an absent or failed surface is a
preparation failure. Generate `docs/api/` from the selected declarations. Keep
the original preparation/build evidence, notices and exact source identity.
The publisher consumes these outputs; it never reruns their producers.

Retain the exact `npm pack --ignore-scripts` archive and its version-1
`receipt.json` in an external directory. The receipt uses the same envelope as
Browser Substrate's retained-archive publisher, with one engine package:

```json
{
  "version": 1,
  "run": "12345",
  "source": "<full reviewed source commit>",
  "packages": [{
    "name": "@volter/tabnode",
    "version": "<selected version>",
    "archive": "volter-tabnode-<selected version>.tgz",
    "integrity": "sha512-<base64 digest of the exact tarball>",
    "status": "prepared"
  }]
}
```

Before publication, sweep that exact tarball with the required gitleaks rules,
custody values and `@volter/teams/redact`; retain the clean result against its
digest. Ask the manager to authorize the exact package, registry, npm distribution tag, source and
archive identity, including advancement of `publish` and its receipt commits.
Use the existing credential selected for that act. A custody-only credential
or missing sign-in is recorded as the exact required act; no new login or
credential setup is implicit in this procedure. Public website publication
remains a distinct authorization.

The archive/source receipt records identity and custody. It is not an npm/SLSA
attestation. Local publication does not claim GitHub OIDC provenance.

## Publish once, then compare

After authorization, select clean committed source on the separate `publish`
branch. Its source must match the reviewed build, apart from existing
`.github/releases/<run>.json` receipt commits. Advance it only to the authorized
source. Set the exact current remote publish head; the command refuses a changed
head and never fetches a replacement head or rebases older bytes onto new source.
The reviewed publisher can be invoked by absolute path from its own checkout
while the working directory remains that authorized publish source. This keeps
an existing archive's original source identity when only the publisher changes;
never restamp it with the publisher's newer commit.

```sh
export RELEASE_ARCHIVES=/absolute/path/to/retained-engine-archives
export RELEASE_SOURCE=<full-reviewed-source-commit>
export RELEASE_PUBLISH_HEAD=<full-current-remote-publish-commit>
export RELEASE_REGISTRY=https://registry.npmjs.org/
export RELEASE_DIST_TAG=latest
export RELEASE_AUTHORIZATION='<manager approval reference for this exact act>'
export RELEASE_KEYS_SWEEP='<clean exact-tarball sweep evidence reference>'
bash scripts/release.sh checkpoint
```

The references are retained pointers to the actual approval and clean sweep;
setting environment variables grants neither. Checkpoint records them and the
registry with the receipt. Preserve those references on later invocations.
Use each successful command's printed `Next RELEASE_PUBLISH_HEAD` for the next
invocation. Run publication tooling in the background and retain its PID/log.

```sh
bash scripts/release.sh publish
# Set RELEASE_PUBLISH_HEAD to the confirmed checkpoint printed above.
bash scripts/release.sh verify
```

Publication first checks accepted exact-byte receipts. Otherwise it makes one
registry observation and compares an existing tarball to the retained SHA-512
identity. Only a structured explicit absent-version response permits a new
upload; a missing credential, failed lookup or earlier unknown upload refuses.
The archive's metadata, declared entrypoints, notices and required surface must
be present. A private copy of the authenticated tarball is uploaded with scripts
disabled; no pack/build producer runs in the publication command.

The command durably records and checkpoints `uploading` before one npm request.
A successful request records `accepted`; a failed or interrupted request stays
`unknown` or `uploading`. Neither means registry availability. The command never
retries an attempted upload, even if a later lookup says the version is absent.
Keep that version reserved; verification can resolve its original exact bytes.

`verify` makes one comparison with the registry tarball under a nine-second
invocation budget. Absence, transient failure, conflict or budget exhaustion
leaves the command unsuccessful, with its original receipt state and observation
retained. Available identical gzip bytes become `verified`; unpacked equivalence
is insufficient. Invoke verification again later against the same archives;
do not rebuild or republish. A verification/checkpoint failure never authorizes
another upload.

Receipt saves flush before replacement. Each checkpoint creates one receipt-only
commit over the pinned publish head and attempts one compare-and-swap push.
Retain the private index, partials and checkpoint outcome records. An uncertain
push retains its exact candidate commit and expected parent; read the remote
head and that commit before selecting the next explicit head. Never automatically
retry the checkpoint or discard an unknown publication lock by PID or age.

Tags and GitHub release notes are separate closing acts naming the reviewed
source; they trigger no upload. Move the consumer pin only to the same verified
archive, and record its exact source and observed tab behavior. Archive equality
and registry availability establish no application acceptance.

There are no CI tests, merge gates or publication workflows. Any workflow
must actually finish within 60 seconds end to end;
a timeout, cancellation or skipped run is not successful compliance.
