#!/bin/sh
# OSB's own QA gates, as the CI `validate` job runs them
# (.github/workflows/ci.yml), in the same order and with the same toolchain
# pins: Bun 1.4.0 (cached release binary) and Python 3.11 (uv). Every step
# runs even after a failure, so one pass shows the whole picture; the full
# log of each step lands in <git-dir>/osb-pr-prepare/qa-logs/<step>.log and
# only the tail of a failing step is printed.
#
# Known environment-only test failures: a test named in
# <git-dir>/osb-pr-prepare/known-test-failures.txt (one exact `bun test` name
# per line) does not fail the gate. Only `qa_fix` adds a name there, and only
# after proving the same test fails on the merge base in this environment.
#
# The CI `windows` job cannot run here; CI covers it after the push.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -uo pipefail
. "$(dirname "$0")/lib.sh"

root=$(repo_root)
cd "$root"
load_ctx
command -v bun >/dev/null 2>&1 || die "bun is not on PATH"
use_ci_bun
py=$(ci_python)

logs="$CTX_DIR/qa-logs"
rm -rf "$logs"
mkdir -p "$logs"
known="$CTX_DIR/known-test-failures.txt"
test_home=$(mktemp -d "${TMPDIR:-/tmp}/osb-qa-home.XXXXXX")
bundle=$(mktemp "${TMPDIR:-/tmp}/osb-openclaw-rebuild.XXXXXX.js")
trap 'rm -rf "$test_home" "$bundle"' EXIT
TAIL_LINES=80
failed=()

step() {
  # step <name> <command...>: runs one gate, records PASS/FAIL.
  name=$1
  shift
  if "$@" >"$logs/$name.log" 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name (log: $logs/$name.log)"
    tail -n "$TAIL_LINES" "$logs/$name.log" | sed 's/^/    /'
    failed+=("$name")
  fi
}

report_only() {
  name=$1
  shift
  "$@" >"$logs/$name.log" 2>&1
  echo "INFO $name (report-only, exit $?; log: $logs/$name.log)"
}

openclaw_bundle_in_sync() {
  bun build src/openclaw/index.ts --outfile "$bundle" --target=node --format=esm \
    --external openclaw/plugin-sdk/plugin-entry &&
    diff -q "$bundle" openclaw/index.js
}

bun_test() {
  # Throwaway HOME, as the project's test discipline requires.
  HOME="$test_home" bun test >"$logs/bun-test.raw" 2>&1
  rc=$?
  cat "$logs/bun-test.raw"
  [ "$rc" -eq 0 ] && return 0
  sed -n 's/^(fail) \(.*\) \[[0-9.]*m\{0,1\}s\]$/\1/p; t; s/^(fail) \(.*\)$/\1/p' "$logs/bun-test.raw" |
    LC_ALL=C sort -u >"$logs/bun-test.failed"
  [ -s "$logs/bun-test.failed" ] || {
    echo "bun test exited $rc without a (fail) line: a crash, not a test failure"
    return 1
  }
  if [ -f "$known" ]; then
    unknown=$(LC_ALL=C sort -u "$known" | LC_ALL=C comm -23 "$logs/bun-test.failed" -)
  else
    unknown=$(cat "$logs/bun-test.failed")
  fi
  if [ -z "$unknown" ]; then
    echo "only known environment-only failures failed:"
    sed 's/^/  known: /' "$logs/bun-test.failed"
    return 0
  fi
  echo "failing tests not on the known list:"
  printf '%s\n' "$unknown" | sed 's/^/  /'
  return 1
}

python_tests() {
  PATH="$root/scripts:$PATH" HOME="$test_home" "$py" -m unittest discover -s tests/python -v
}

anti_drift_ran() {
  (
    cd tests/python &&
      PATH="$root/scripts:$PATH" HOME="$test_home" "$py" -m unittest test_static_schemas -v >"$logs/anti-drift.raw" 2>&1
    cat "$logs/anti-drift.raw"
    grep -q "test_static_schemas_match_live_tools_list" "$logs/anti-drift.raw" || exit 1
    if grep -qE 'test_static_schemas_match_live_tools_list.* \.\.\. skipped' "$logs/anti-drift.raw"; then
      echo "anti-drift skipped itself; the live server was not reachable"
      exit 1
    fi
  )
}

echo "QA gates for $OSB_BRANCH ($(git rev-parse --short HEAD)), Bun $(bun --version), $("$py" --version)"
step install bun install --frozen-lockfile
step sync-version bun run sync-version:check
step sync-plugin-mirrors bun run sync-plugin-mirrors:check
step openclaw-bundle openclaw_bundle_in_sync
step link-ratchet bun run link-ratchet:check
report_only check-paths bun run check:paths
step fmt bun run fmt:check
step lint bun run lint
step typecheck bun run typecheck
step bun-test bun_test
step python-tests python_tests
step anti-drift anti_drift_ran
step python-compile "$py" -m compileall -q plugins/hermes
step hermes-scan bun run check:hermes-scan

if [ "${#failed[@]}" -eq 0 ]; then
  echo "QA-GATE: green"
  exit 0
fi
echo "QA-GATE: red (${failed[*]})"
exit 1
