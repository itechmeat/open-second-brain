#!/bin/sh
# success_check of `push_pr` (and of the fix nodes that push): the PR recorded
# in pr.env is open, not merged, targets the base branch, and its head is
# exactly the local HEAD, which the remote branch also carries.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
load_ctx
load_pr

head=$(git rev-parse HEAD)
git diff --quiet && git diff --cached --quiet || die "uncommitted tracked changes: commit and push them"
remote=$(git ls-remote origin "refs/heads/$OSB_BRANCH" | cut -f1)
[ "$remote" = "$head" ] || die "origin/$OSB_BRANCH is '${remote:-absent}', local HEAD is $head: push"

info=$(gh pr view "$OSB_PR_NUMBER" --json state,headRefOid,baseRefName,headRefName,url \
  -q '[.state,.headRefOid,.baseRefName,.headRefName,.url]|@tsv') || die "gh pr view $OSB_PR_NUMBER failed"
IFS=$'\t' read -r state pr_head pr_base pr_branch url <<<"$info"
[ "$state" = OPEN ] || die "PR #$OSB_PR_NUMBER is $state, expected OPEN (this playbook never merges)"
[ "$pr_base" = "$OSB_BASE" ] || die "PR #$OSB_PR_NUMBER targets $pr_base, expected $OSB_BASE"
[ "$pr_branch" = "$OSB_BRANCH" ] || die "PR #$OSB_PR_NUMBER is from $pr_branch, expected $OSB_BRANCH"
[ "$pr_head" = "$head" ] || die "PR #$OSB_PR_NUMBER head is $pr_head, local HEAD is $head"
auto=$(gh pr view "$OSB_PR_NUMBER" --json autoMergeRequest -q '.autoMergeRequest != null')
[ "$auto" = false ] || die "PR #$OSB_PR_NUMBER has auto-merge armed; merging is the operator's call: gh pr merge --disable-auto $OSB_PR_NUMBER"
echo "PR ok: #$OSB_PR_NUMBER $url open on $OSB_BASE at $head"
