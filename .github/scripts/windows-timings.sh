#!/usr/bin/env bash
# Refreshes .github/windows-test-timings.json, the per-file durations the
# Windows shards split the suite by, from what a CI run measured.
#
# Usage: .github/scripts/windows-timings.sh [run-id]
#
# Every Windows shard uploads the durations of the files it ran as the
# artifact `windows-timings-<shard>`. This downloads them from the given run
# (default: the latest successful CI run on main), lays them over the
# committed file, and drops entries for test files that no longer exist.
# A file missing from the committed timings still runs: Bun gives it a
# default weight, so a stale file costs balance, never coverage.
#
# Needs `gh` (authenticated) and `jq`. Run from the repository root, then
# commit the result.
set -euo pipefail

timings=.github/windows-test-timings.json
run="${1:-}"

if [ -z "$run" ]; then
  run=$(gh run list --workflow ci.yml --branch main --event push --status success \
    --limit 1 --json databaseId --jq '.[0].databaseId')
fi
[ -n "$run" ] || { echo "no CI run to read timings from" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

gh run download "$run" --pattern 'windows-timings-*' --dir "$tmp"
mapfile -t shards < <(find "$tmp" -name '*.json' | sort)
[ "${#shards[@]}" -gt 0 ] || { echo "run $run has no windows-timings artifacts" >&2; exit 1; }

git ls-files 'tests/*.test.ts' | jq -R . | jq -s . > "$tmp/present.json"

# Later inputs win, so the measured values replace the committed ones. Keys
# are normalised to forward slashes in case a Windows shard wrote its own.
jq -s --slurpfile present "$tmp/present.json" '
  (reduce .[] as $t ({}; . + (($t.files // {}) | with_entries(.key |= gsub("\\\\"; "/"))))) as $all
  | ($present[0] | map({ (.): true }) | add // {}) as $keep
  | { version: 1,
      files: ($all | with_entries(select($keep[.key])) | to_entries | sort_by(.key) | from_entries) }
' "$timings" "${shards[@]}" > "$tmp/merged.json"

mv "$tmp/merged.json" "$timings"
echo "updated $timings from run $run ($(jq '.files | length' "$timings") files, ${#shards[@]} shards)"
