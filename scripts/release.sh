#!/usr/bin/env bash
# One-shot release script. Drives the whole flow:
#
#   1. Bump version in package.json
#   2. Commit the bump
#   3. Tag v<version> and push (triggers GH Actions to build + upload binaries)
#   4. Wait for the release workflow to finish on the remote
#   5. Update Formula/stash.rb with the new urls + sha256s
#   6. Commit + push the formula
#
# After this, anyone on `brew tap SectorOPS/Stash` can run
#   brew update && brew upgrade stash
# to pick up the new version.
#
# Usage:
#   scripts/release.sh 0.2.0
#   scripts/release.sh patch    # 0.1.0 -> 0.1.1
#   scripts/release.sh minor    # 0.1.0 -> 0.2.0
#   scripts/release.sh major    # 0.1.0 -> 1.0.0
#
# Env:
#   SKIP_PUSH=1   skip pushing the tag / formula commit (dry run)
#   SKIP_WAIT=1   skip waiting for GH Actions (use if you've already built)

set -euo pipefail

ROOT="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required tool: $1" >&2
    exit 1
  }
}

need jq
need git
need gh

ARG="${1:?usage: $0 <new-version | patch | minor | major>}"

CURRENT=$(jq -r .version package.json)
case "$ARG" in
  patch|minor|major)
    NEW=$(node -e "
      const v='${CURRENT}'.split('.').map(Number);
      const k='$ARG';
      if(k==='major'){v[0]++;v[1]=0;v[2]=0;}
      else if(k==='minor'){v[1]++;v[2]=0;}
      else{v[2]++;}
      console.log(v.join('.'));
    ")
    ;;
  *)
    NEW="$ARG"
    ;;
esac

echo "==> releasing ${CURRENT} -> ${NEW}"

# Refuse to release on a dirty tree.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash first." >&2
  exit 1
fi

# 1. Bump version (no-op if it already matches — covers first releases
#    where package.json was edited manually).
if [ "$NEW" != "$CURRENT" ]; then
  tmp=$(mktemp)
  jq --arg v "$NEW" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
  git add package.json
  git commit -m "Release ${NEW}"
else
  echo "    package.json already at ${NEW}; skipping bump commit"
fi

# 3. Tag + push
git tag "v${NEW}"
if [ -z "${SKIP_PUSH:-}" ]; then
  git push origin HEAD
  git push origin "v${NEW}"
else
  echo "(SKIP_PUSH=1) tag created locally; skipping push"
fi

# 4. Wait for GH Actions
if [ -z "${SKIP_WAIT:-}" ] && [ -z "${SKIP_PUSH:-}" ]; then
  echo "==> waiting for release workflow to finish…"
  # Give Actions a moment to register the tag push.
  sleep 5
  gh run watch --exit-status \
    --workflow release.yml \
    --branch "v${NEW}" \
    || {
      echo "Release workflow failed — fix it before continuing." >&2
      exit 1
    }
fi

# 5. Update formula (pulls sha256s from the release)
scripts/update-formula.sh "${NEW}"

# 6. Commit + push the formula
git add Formula/stash.rb
git commit -m "Formula: bump to ${NEW}"
if [ -z "${SKIP_PUSH:-}" ]; then
  git push origin HEAD
fi

echo
echo "✓ Released v${NEW}"
echo "  Users can now: brew update && brew upgrade stash"
