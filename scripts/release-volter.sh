#!/bin/bash
# Cuts a release the substrate depends on by tag: merges main into the
# `release` branch, builds the library, commits dist/, tags v0.2.14-volter.<n>
# and pushes. dist/ is ignored on main and tracked on release only.
#
#   bash scripts/release-volter.sh <n>
set -e
n="${1:?release number}"
tag="v0.2.14-volter.$n"
git diff --quiet || { echo "working tree not clean"; exit 1; }
git fetch -q origin
git checkout -q -B release origin/release 2>/dev/null || git checkout -q -b release
git merge -q --no-edit main
# The version is the tag. Every release through .65 read 0.2.14-volter.0, so
# `npm ls` could not tell one tag from another and the substrate's guard could
# only test for the word `volter`; from .66 the number is the release's, in
# package.json and the lock, committed beside dist/.
npm version --no-git-tag-version "0.2.14-volter.$n" > /dev/null
git add package.json package-lock.json
npm run build:lib > /tmp/tabnode-release-build.log 2>&1 || { tail -20 /tmp/tabnode-release-build.log; exit 1; }
# The whole build: the entry files and every declaration they re-export
# from, the shims' and the runtime's, without which a consumer's typecheck
# sees the engine's types as empty.
git add -f dist
git commit -q -m "release $tag: built dist" || true
git tag -a "$tag" -m "$tag"
# Two pushes, not one. `git push origin release "$tag"` reports one result for
# both refs: measured 2026-09-20, the branch push had been rejected as
# non-fast-forward since .31 while the tag push succeeded, so origin/release
# sat at .30 for five releases and nothing said so. Under `set -e` the branch
# goes first, and a rejected branch stops the release before a tag exists.
git push -q origin release
git push -q origin "$tag"
# Back to wherever this started. A plain `git checkout main` fails when another
# worktree holds main, and the release is already pushed by then.
git checkout -q - 2>/dev/null || true
echo "$tag"
