#!/bin/sh
# Steps 1-3 of the dev quality cycle (skill dev-quality-cycle): OpenCodeReview
# on the claude-code provider, the read-only Codex review and Claude Code's
# /security-review, through the skill's own runner `scripts/cycle.sh`. The
# skill owns the commands, flags, effort levels and failure detection; this
# script only picks the range and records where the run folder is.
#
# Range: what the cycle has not reviewed yet, never what was merely pushed. The
# cycle_review and final_fix nodes record the head the cycle reviewed in
# <git-dir>/osb-pr-prepare/cycle-reviewed as "<branch> <sha>". When that record
# names this branch and its sha is an ancestor of HEAD, the range is <sha>..HEAD;
# otherwise it is the whole branch against origin/<base>. The runner exits 4
# when the range is empty (HEAD already reviewed).
#
# The skill lives in $DEV_QUALITY_CYCLE_DIR, default ~/.agents/skills/dev-quality-cycle.
#
# Output: the runner's log, then one marker line
#   `CYCLE-RUN: ok|failed|resumable|nothing-new exit=<n> summary=<path>`
# Exit 0 for every marker: the cycle_review node reads the outputs and decides.
# Exit 2: setup error (`ERROR:`), which no code change can fix.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -uo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
load_ctx

skill="${DEV_QUALITY_CYCLE_DIR:-$HOME/.agents/skills/dev-quality-cycle}"
runner="$skill/scripts/cycle.sh"
[ -x "$runner" ] || die "the dev-quality-cycle skill runner is missing: $runner"

git rev-parse -q --verify "origin/$OSB_BASE^{commit}" >/dev/null ||
  die "origin/$OSB_BASE is unknown: fetch it first"
range_args=(--base "origin/$OSB_BASE")
reviewed_file="$CTX_DIR/cycle-reviewed"
if [ -s "$reviewed_file" ]; then
  read -r reviewed_branch reviewed_sha <"$reviewed_file"
  if [ "$reviewed_branch" = "$OSB_BRANCH" ] && [ -n "${reviewed_sha:-}" ] &&
    git merge-base --is-ancestor "$reviewed_sha" HEAD 2>/dev/null; then
    range_args=(--range "$reviewed_sha..HEAD")
  fi
fi

# What the change is for: OCR --background-file and the Codex prompt.
intent="$CTX_DIR/cycle-intent.md"
{
  printf 'Open Second Brain change of kind %s on branch %s against %s.\n' "$OSB_KIND" "$OSB_BRANCH" "$OSB_BASE"
  printf 'Commits:\n'
  git log --no-merges --format='- %s' "origin/$OSB_BASE..HEAD"
} >"$intent"

log="$CTX_DIR/cycle-run.log"
"$runner" "${range_args[@]}" --context-file "$intent" --exclude 'bun.lock,uv.lock' . >"$log" 2>&1
rc=$?
cat "$log"
summary=$(sed -n 's/^Summary: //p' "$log" | tail -1)
case "$rc" in
  0) status=ok ;;
  1) status=failed ;;
  3) status=resumable ;;
  4) status=nothing-new ;;
  *) die "the cycle runner exited $rc (usage or setup error); see $log" ;;
esac
echo "CYCLE-RUN: $status exit=$rc summary=${summary:-none}"
exit 0
