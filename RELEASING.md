# Releasing

Every push to `main` is released: a tag `v<version>` on `main`, and the npm package `@volter/tabnode` at that version, published by this repository's `publish` workflow with provenance.

The workflow authenticates with the repository secret `NPM_TOKEN`, a granular token that expires 2026-12-20, until npm's trusted publisher is confirmed for it. Confirming is one command by a session signed in with the account's own second factor, which a bypass token may not do:

    npm trust github @volter/tabnode --file publish.yml --repo volter-ai/tabnode --allow-publish

After that the secret is deleted, the `NODE_AUTH_TOKEN` line leaves the workflow, and no publish credential exists anywhere.

1. A change lands on `main` with its entry under `## Unreleased` in `CHANGELOG.md`.
2. The workflow moves the version to its next patch, turns `## Unreleased` into that version's `## v<version> — <date>` section, regenerates `docs/api/`, builds, publishes with `--provenance`, commits `release v<version>` to `main`, tags it, and creates the GitHub release with the section as its notes (or the commits since the last tag, when the section is empty). `npm view @volter/tabnode@<version>` says when it is there.
3. A minor release (the exported surface changed) is cut by hand: `bash scripts/release.sh <version>` on a clean `main`, with the version's changelog section already written; the workflow publishes that version as it is.
4. The consumer moves its pin to the version and records what the tab gained.

The workflow builds `dist/surface.json` before it publishes (`npm run build:surface`, under Node 24.21.0, which the comparison with Node's own surface requires). That is a choice: every release, a patch included, now depends on those four scripts passing, and the package always carries a surface measured from the code it ships. When one fails the release stops before npm: nothing is published, `main` has the change and no version for it. Fix the script or the engine and push; the next push releases. Do not skip the step to get a release out: a package without the file is read by its consumers as "packed without build:surface", not as an empty surface.

The version is semver over the fork's own line, which began at `0.3.0`: a patch bump for a fix, a minor bump when the exported surface changes. The `dist/` directory is never committed; what npm serves is what the workflow built from `main`.
