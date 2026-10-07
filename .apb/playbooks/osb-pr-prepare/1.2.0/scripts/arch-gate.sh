#!/bin/sh
# Architecture gate: code-ranker in baseline mode. The merge base with
# origin/<base> is analyzed as the baseline and the committed HEAD as the
# candidate (both from `git archive`, so untracked files and local tool
# directories never enter the graph); only violations the branch introduces
# fail the gate. Pre-existing debt on the base is not this PR's to fix.
#
# Exit 0: no new violation. Exit 1: new violations (the output starts with
# `ARCH-GATE: violations`, followed by code-ranker's fix prompt). Exit 2: the
# tool itself failed (`ERROR:`), which no code change in the branch can fix.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

root=$(repo_root)
cd "$root"
load_ctx
command -v code-ranker >/dev/null 2>&1 || die "code-ranker is not on PATH"

mb=$(git merge-base "origin/$OSB_BASE" HEAD) || die "no merge base with origin/$OSB_BASE"
work=$(mktemp -d "${TMPDIR:-/tmp}/osb-arch-gate.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/base" "$work/head"
git archive "$mb" | tar -x -C "$work/base"
git archive HEAD | tar -x -C "$work/head"

# Explicit plugins so base and head are analyzed with the same languages.
plugins=(--plugins ts --plugins python --plugins md)
cd "$work" # code-ranker writes its default HTML viewer under the cwd
code-ranker report base "${plugins[@]}" --output.mode quiet \
  --output.json.path "$work/base.json" --output.html.path "$work/base.html" >/dev/null 2>"$work/report.err" ||
  die "code-ranker report on the merge base failed: $(cat "$work/report.err")"

set +e
code-ranker check head "${plugins[@]}" --baseline "$work/base.json" \
  --output-format prompt --output.mode summary >"$work/check.out" 2>&1
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  cat "$work/check.out"
  echo "ARCH-GATE: pass (no new violation against $mb)"
  exit 0
fi
if grep -q 'new violation(s) vs baseline' "$work/check.out"; then
  echo "ARCH-GATE: violations (new against merge base $mb)"
  sed "s#$work/##g" "$work/check.out"
  exit 1
fi
cat "$work/check.out"
die "code-ranker check failed without a violation verdict (exit $rc)"
