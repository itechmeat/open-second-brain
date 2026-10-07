#!/bin/sh
# success_check of `docs_version`: the version and CHANGELOG state match what
# the change kind decided (CLAUDE.md "Versioning").
#
# Release-bearing PR (OSB_RELEASE major|minor|patch):
#   - package.json carries the expected bump of the base version;
#   - the first `## [` heading of CHANGELOG.md is `## [X.Y.Z] - YYYY-MM-DD`
#     (no `[Unreleased]` left above it);
#   - the `[X.Y.Z]: .../compare/vPREV...vX.Y.Z` link reference exists;
#   - `sync-version --check` passes and everything is committed.
# No-release PR (OSB_RELEASE none): package.json still carries the base version.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
load_ctx

prev=$(git show "origin/$OSB_BASE:package.json" | json_version)
now=$(json_version <package.json)

if [ "$OSB_RELEASE" = none ]; then
  [ "$now" = "$prev" ] || die "kind $OSB_KIND ships no release, but package.json moved $prev -> $now"
  echo "release check ok: no release, version stays $now"
  exit 0
fi

expected=$(python3 - "$prev" "$OSB_RELEASE" <<'PY'
import sys
major, minor, patch = (int(p) for p in sys.argv[1].split("."))
bump = sys.argv[2]
if bump == "major":
    major, minor, patch = major + 1, 0, 0
elif bump == "minor":
    minor, patch = minor + 1, 0
else:
    patch += 1
print(f"{major}.{minor}.{patch}")
PY
)
[ "$now" = "$expected" ] || die "package.json is $now; a $OSB_RELEASE bump of $prev is $expected"

first=$(grep -m1 -E '^## \[' CHANGELOG.md || true)
printf '%s\n' "$first" | grep -qE "^## \[$expected\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" ||
  die "the first CHANGELOG heading is '$first', expected '## [$expected] - <date>'"
grep -qE "^\[$expected\]: https://github\.com/itechmeat/open-second-brain/compare/v$prev\.\.\.v$expected\$" CHANGELOG.md ||
  die "CHANGELOG.md lacks the link reference [$expected]: https://github.com/itechmeat/open-second-brain/compare/v$prev...v$expected"

bun run scripts/sync-version.ts --check >/dev/null 2>&1 || die "sync-version --check fails: run bun run scripts/sync-version.ts"
git diff --quiet && git diff --cached --quiet || die "version or CHANGELOG changes are not committed"
echo "release check ok: $prev -> $expected ($OSB_RELEASE), CHANGELOG heading and link reference present"
