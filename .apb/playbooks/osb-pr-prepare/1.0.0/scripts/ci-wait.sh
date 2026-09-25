#!/bin/sh
# Waits for the PR's checks on the current head with ONE blocking command,
# `gh pr checks --watch` (no polling loop of our own), then prints the verdict.
# The checks include CodeRabbit's status, so a green result also means the bot
# review has finished (or was skipped).
#
# Before the watch, the script makes sure the CI workflow run for THIS head
# commit exists. Right after a push, `gh pr checks` can still show the previous
# commit's finished checks and would return at once with a stale verdict. That
# registration wait is bounded (REGISTRATION_TRIES x REGISTRATION_SLEEP) and
# ends as soon as GitHub lists the run.
#
# Exit 0 green, 1 red (failed-job logs follow), 2 setup error.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

REGISTRATION_TRIES=18
REGISTRATION_SLEEP=10
WATCH_TIMEOUT=6000 # the windows job alone has taken 45 minutes on a slow runner
WATCH_INTERVAL=60  # gh's own refresh period while it blocks
LOG_TAIL=250
CI_WORKFLOW=ci.yml

cd "$(repo_root)"
load_ctx
load_pr

head=$(git rev-parse HEAD)
pr_head=$(gh pr view "$OSB_PR_NUMBER" --json headRefOid -q .headRefOid)
[ "$pr_head" = "$head" ] || die "PR #$OSB_PR_NUMBER head $pr_head is not local HEAD $head: push first"

run_id=""
for _ in $(seq "$REGISTRATION_TRIES"); do
  run_id=$(gh run list --commit "$head" --workflow "$CI_WORKFLOW" --limit 1 --json databaseId -q '.[0].databaseId // empty')
  [ -n "$run_id" ] && break
  sleep "$REGISTRATION_SLEEP"
done
[ -n "$run_id" ] || die "no $CI_WORKFLOW run registered for $head after $((REGISTRATION_TRIES * REGISTRATION_SLEEP))s"

set +e
timeout "$WATCH_TIMEOUT" gh pr checks "$OSB_PR_NUMBER" --watch --fail-fast --interval "$WATCH_INTERVAL" >/dev/null 2>&1
rc=$?
set -e
echo "checks for PR #$OSB_PR_NUMBER at $head (CI run $run_id):"
gh pr checks "$OSB_PR_NUMBER" 2>&1 || true

if [ "$rc" -eq 0 ]; then
  echo "CI-GATE: green"
  exit 0
fi
if [ "$rc" -eq 124 ]; then
  echo "CI-GATE: red (checks still pending after ${WATCH_TIMEOUT}s)"
  exit 1
fi
echo "CI-GATE: red"
# Per failed job, not `--log-failed` on the run: with --fail-fast the run may
# still be in progress (the windows job), and a run-level log is refused then.
for job in $(gh run view "$run_id" --json jobs -q '.jobs[] | select(.conclusion == "failure") | .databaseId'); do
  echo "--- failed job $job of run $run_id (log tail) ---"
  gh run view --job "$job" --log 2>&1 | tail -n "$LOG_TAIL" || true
done
exit 1
