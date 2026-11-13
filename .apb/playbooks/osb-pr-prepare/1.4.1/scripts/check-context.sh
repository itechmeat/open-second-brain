#!/bin/sh
# success_check of `intake`: the recorded PR context is complete and true.
# apb runs every script through `sh`; re-exec under bash for pipefail.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
load_ctx

case " $OSB_KINDS " in *" $OSB_KIND "*) ;; *) die "OSB_KIND=$OSB_KIND is not one of: $OSB_KINDS" ;; esac
case " $OSB_RELEASES " in *" $OSB_RELEASE "*) ;; *) die "OSB_RELEASE=$OSB_RELEASE is not one of: $OSB_RELEASES" ;; esac

branch=$(git symbolic-ref --quiet --short HEAD) || die "HEAD is detached; the PR needs a branch"
[ "$branch" = "$OSB_BRANCH" ] || die "checked-out branch $branch differs from OSB_BRANCH=$OSB_BRANCH"
[ "$branch" != "$OSB_BASE" ] || die "the PR branch is the base branch $OSB_BASE"
git rev-parse --verify --quiet "origin/$OSB_BASE" >/dev/null || die "origin/$OSB_BASE does not exist; fetch it"
mb=$(git merge-base "origin/$OSB_BASE" HEAD) || die "no merge base between origin/$OSB_BASE and HEAD"
git diff --quiet "$mb" HEAD && die "the branch carries no change against origin/$OSB_BASE"
git diff --quiet || die "tracked files have unstaged changes; the intake commits the implementation first"
git diff --cached --quiet || die "the index holds staged, uncommitted changes"

echo "context ok: kind=$OSB_KIND release=$OSB_RELEASE base=$OSB_BASE branch=$OSB_BRANCH merge-base=$mb"
echo "commits: $(git rev-list --count "$mb"..HEAD), files: $(git diff --name-only "$mb" HEAD | wc -l)"
