#!/usr/bin/env bash
# Resolve the tier and version of a @crowdedkingdoms/construct release tag, and REFUSE when
# the tagged commit is not contained in that tier's branch.
#
# Package tags are `construct/dev/v0.2.0`, `construct/test/v0.2.0`, `construct/prod/v0.2.0`.
# They carry the `construct/` prefix because this repository's own `<tier>/vX.Y.Z` tags
# version the-construct as a whole (`test/v0.8.4` is "the-construct 0.8.4 on test"), and the
# framework package has its own version line in packages/construct/package.json.
#
# The rules are CrowdyJS's (scripts/ci/resolve-release-tier.sh there): the tier is a prefix,
# never a suffix, because `v0.2.0-dev` is a semver pre-release; and the tag's COMMIT must be
# reachable from the tier's branch, because git never attached a tag to a branch and a tag
# pushed from a feature branch would otherwise publish as that tier. It fails loudly rather
# than skipping: a skipped release looks the same as one nobody cut.
#
# Usage (CI):   scripts/ci/resolve-construct-release.sh              # reads GITHUB_REF / GITHUB_SHA
# Usage (test): scripts/ci/resolve-construct-release.sh <ref> <sha>
#
# Needs the full history (actions/checkout `fetch-depth: 0`), or the merge-base is missing
# and a valid tag is refused.
#
# Writes `tier` and `version` to $GITHUB_OUTPUT when set, and always prints them as
# `tier=<t>` / `version=<v>` on stdout.
set -euo pipefail

REF=${1-${GITHUB_REF:-}}
SHA=${2-${GITHUB_SHA:-}}
REMOTE=${RELEASE_TIER_REMOTE:-origin}

die() {
  echo "::error::$*" >&2
  exit 1
}

[ -n "$REF" ] || die "no tag ref given (argument 1, or GITHUB_REF)"
[ -n "$SHA" ] || die "no commit given (argument 2, or GITHUB_SHA)"

case "$REF" in
  refs/tags/*) tag=${REF#refs/tags/} ;;
  refs/heads/*) die "$REF is a branch, not a tag: the package is released from tags only" ;;
  *) tag=$REF ;;
esac

case "$tag" in
  construct/*/*) rest=${tag#construct/}; tier=${rest%%/*}; version=${rest#*/} ;;
  */v*) die "tag '$tag' is a repository tag; the package is released by construct/<dev|test|prod>/vX.Y.Z" ;;
  *) die "tag '$tag' is not a package tag; expected construct/<dev|test|prod>/vX.Y.Z" ;;
esac

case "$tier" in
  dev | test | prod) ;;
  *) die "tag '$tag' names environment '$tier', which is not one of dev, test, prod" ;;
esac

[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "tag '$tag' has version '$version'; expected vMAJOR.MINOR.PATCH with no suffix"

git fetch --no-tags "$REMOTE" "+refs/heads/${tier}:refs/remotes/${REMOTE}/${tier}" >/dev/null 2>&1 \
  || die "cannot fetch branch '${tier}' from '${REMOTE}': the branch this tag names does not exist"

git merge-base --is-ancestor "$SHA" "refs/remotes/${REMOTE}/${tier}" || die \
  "tag '$tag' points at commit ${SHA}, which is NOT contained in ${REMOTE}/${tier}. Merge the commit into '${tier}' first, then re-tag."

echo "tier=$tier"
echo "version=$version"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "tier=$tier"
    echo "version=$version"
  } >>"$GITHUB_OUTPUT"
fi
