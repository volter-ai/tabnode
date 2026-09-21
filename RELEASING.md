# Releasing

A release is a tag `v<version>` on `main`, and the npm package `@volter/tabnode` at that version, published by this repository's `publish` workflow from the tag with provenance. No maintainer holds a publish token; npm trusts the workflow.

1. `CHANGELOG.md` gets its `## v<version> — <date>` section on `main`. A release whose section is missing is refused by the script, since it would be described nowhere.
2. `bash scripts/release.sh <version>` on a clean `main`: it regenerates `docs/api/`, sets the version in `package.json` and the lock, commits, tags, and pushes `main` and the tag.
3. The workflow builds the tag, checks the version is the tag, publishes with `--provenance`, and creates the GitHub release with the changelog's section as its notes. `npm view @volter/tabnode@<version>` says when it is there.
4. The consumer moves its pin to the version and records what the tab gained.

The version is semver over the fork's own line, which began at `0.3.0`: a patch bump for a fix, a minor bump when the exported surface changes. The `dist/` directory is never committed; what npm serves is what the workflow built from the tag.
