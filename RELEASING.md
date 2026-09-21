# Releasing

A release is a tag `v<version>` on `main`, and the npm package `@volter/tabnode` at that version, published by this repository's `publish` workflow from the tag with provenance.

The workflow authenticates with the repository secret `NPM_TOKEN`, a granular token that expires 2026-12-20, until npm's trusted publisher is confirmed for it. Confirming is one command by a session signed in with the account's own second factor, which a bypass token may not do:

    npm trust github @volter/tabnode --file publish.yml --repo volter-ai/tabnode --allow-publish

After that the secret is deleted, the `NODE_AUTH_TOKEN` line leaves the workflow, and no publish credential exists anywhere.

1. `CHANGELOG.md` gets its `## v<version> — <date>` section on `main`. A release whose section is missing is refused by the script, since it would be described nowhere.
2. `bash scripts/release.sh <version>` on a clean `main`: it regenerates `docs/api/`, sets the version in `package.json` and the lock, commits, tags, and pushes `main` and the tag.
3. The workflow builds the tag, checks the version is the tag, publishes with `--provenance`, and creates the GitHub release with the changelog's section as its notes. `npm view @volter/tabnode@<version>` says when it is there.
4. The consumer moves its pin to the version and records what the tab gained.

The version is semver over the fork's own line, which began at `0.3.0`: a patch bump for a fix, a minor bump when the exported surface changes. The `dist/` directory is never committed; what npm serves is what the workflow built from the tag.
