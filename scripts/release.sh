#!/bin/bash
# Cuts a release from main: the changelog must already have the version's
# section; the version is set, committed and tagged v<version>, and pushed.
# .github/workflows/publish.yml then builds the tag, publishes @volter/tabnode
# to npm with provenance, and makes the GitHub release from the changelog's
# section. Nothing here needs a credential.
#
#   bash scripts/release.sh 0.3.1
set -e
v="${1:?version, e.g. 0.3.1}"
git diff --quiet && git diff --cached --quiet || { echo "working tree not clean"; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "a release is cut from main"; exit 1; }
grep -q "^## v$v " CHANGELOG.md || { echo "CHANGELOG.md has no '## v$v' section"; exit 1; }
npm run docs:api > /tmp/tabnode-release-docs.log 2>&1 || { tail -20 /tmp/tabnode-release-docs.log; exit 1; }
git add docs/api
[ "$(node -p "require('./package.json').version")" = "$v" ] || npm version --no-git-tag-version "$v" > /dev/null
git add package.json package-lock.json
git commit -q -m "release v$v" || true
git tag -a "v$v" -m "v$v"
# Two pushes: one push of both refs reports one result, and a rejected
# branch would otherwise leave a tag whose commit is not on main.
git push -q origin main
git push -q origin "v$v"
echo "v$v"
