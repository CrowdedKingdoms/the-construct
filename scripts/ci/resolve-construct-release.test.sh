#!/usr/bin/env bash
# Proves resolve-construct-release.sh refuses and accepts, against a real git repository with
# real branches. Both directions: a gate that always fails passes every refusal test.
#
# The containment case is the way the defect happens: a commit on `dev` that has not reached
# `prod`, tagged `construct/prod/vX.Y.Z`.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/resolve-construct-release.sh"
[ -x "$SCRIPT" ] || { echo "not executable: $SCRIPT" >&2; exit 1; }

# The script falls back to these, so a test that left them set would depend on where it ran.
unset GITHUB_OUTPUT GITHUB_REF GITHUB_SHA

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   $1"; }
no() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }

expect_refusal() {
  local name=$1 ref=$2 sha=$3 want=$4 out rc
  out=$("$SCRIPT" "$ref" "$sha" 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    no "$name: expected refusal, got exit 0 and: $out"
  elif ! grep -qF -- "$want" <<<"$out"; then
    no "$name: refused (good) but message lacks '$want': $out"
  else
    ok "$name"
  fi
}

expect_accept() {
  local name=$1 ref=$2 sha=$3 tier=$4 version=$5 out rc
  out=$("$SCRIPT" "$ref" "$sha" 2>&1)
  rc=$?
  if [ $rc -ne 0 ]; then
    no "$name: expected acceptance, got exit $rc and: $out"
  elif ! grep -qx -- "tier=$tier" <<<"$out" || ! grep -qx -- "version=$version" <<<"$out"; then
    no "$name: accepted but not as $tier $version: $out"
  else
    ok "$name"
  fi
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A bare remote plus a clone, so the script's fetch is a real fetch.
git init --quiet --bare "$WORK/remote.git"
git clone --quiet "$WORK/remote.git" "$WORK/repo" 2>/dev/null
cd "$WORK/repo"
git config user.email ci@example.com
git config user.name CI
git config commit.gpgsign false

commit() { echo "$1" >>log.txt; git add log.txt; git commit --quiet -m "$1"; git rev-parse HEAD; }

BASE=$(commit base)
git branch -M prod
git push --quiet origin prod
git checkout --quiet -b test
git push --quiet origin test
git checkout --quiet -b dev
DEV_ONLY=$(commit dev-only)
git push --quiet origin dev

echo "resolve-construct-release.sh"
expect_accept "dev tag on a dev commit" "refs/tags/construct/dev/v0.2.0" "$DEV_ONLY" dev v0.2.0
expect_accept "prod tag on a prod commit" "refs/tags/construct/prod/v0.2.0" "$BASE" prod v0.2.0
expect_refusal "prod tag on a dev-only commit" "refs/tags/construct/prod/v0.2.0" "$DEV_ONLY" "NOT contained in origin/prod"
expect_refusal "repository tag" "refs/tags/dev/v0.8.4" "$DEV_ONLY" "is a repository tag"
expect_refusal "unknown tier" "refs/tags/construct/staging/v0.2.0" "$DEV_ONLY" "not one of dev, test, prod"
expect_refusal "pre-release version" "refs/tags/construct/dev/v0.2.0-rc.1" "$DEV_ONLY" "expected vMAJOR.MINOR.PATCH"
expect_refusal "branch ref" "refs/heads/dev" "$DEV_ONLY" "is a branch, not a tag"
expect_refusal "empty ref" "" "$DEV_ONLY" "no tag ref given"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
