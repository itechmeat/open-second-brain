#!/bin/sh
# Publishes the approved draft. Irreversible and public: runs only after the
# operator's `approve` at the gate. Re-checks that the target is still on
# origin/main and that the draft is the one staged, publishes it (GitHub
# creates the tag at the target commit), then verifies the tag points at the
# exact commit, the release is public and every asset downloads with its
# local size.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
load_scope
git fetch --quiet origin main || die "git fetch origin main failed"
git merge-base --is-ancestor "$OSB_TARGET_SHA" origin/main || die "target $OSB_TARGET_SHA is no longer on origin/main"

state=$(gh release view "$OSB_TAG" --repo "$OSB_REPO" --json isDraft,targetCommitish -q '[(.isDraft|tostring),.targetCommitish]|@tsv' 2>/dev/null) ||
  die "no draft release $OSB_TAG to publish: the stage node did not run or the draft was deleted"
IFS=$'\t' read -r is_draft target <<<"$state"
[ "$is_draft" = true ] || die "release $OSB_TAG is already published"
[ "$target" = "$OSB_TARGET_SHA" ] || die "the draft targets $target, expected $OSB_TARGET_SHA"

gh release edit "$OSB_TAG" --repo "$OSB_REPO" --draft=false --latest >/dev/null || die "publishing $OSB_TAG failed"

tag_sha=$(git ls-remote --tags origin "refs/tags/$OSB_TAG^{}" | cut -f1)
[ -n "$tag_sha" ] || tag_sha=$(git ls-remote --tags origin "refs/tags/$OSB_TAG" | cut -f1)
[ "$tag_sha" = "$OSB_TARGET_SHA" ] || die "tag $OSB_TAG points at '${tag_sha:-nothing}', expected $OSB_TARGET_SHA"

info=$(gh release view "$OSB_TAG" --repo "$OSB_REPO" --json isDraft,url -q '[(.isDraft|tostring),.url]|@tsv')
IFS=$'\t' read -r is_draft url <<<"$info"
[ "$is_draft" = false ] || die "release $OSB_TAG is still a draft after publishing"

bad=0
while IFS=$'\t' read -r name dl size; do
  local_file="$OSB_WORK/assets/$name"
  got=$(curl -sfL -o /dev/null -w '%{http_code} %{size_download}' "$dl" || echo "failed 0")
  want_size=$(stat -c %s "$local_file" 2>/dev/null || echo "?")
  if [ "$got" = "200 $want_size" ] && [ "$size" = "$want_size" ]; then
    echo "asset ok: $name ($size bytes)"
  else
    echo "asset BAD: $name: download '$got', listed $size, local $want_size"
    bad=1
  fi
done < <(gh release view "$OSB_TAG" --repo "$OSB_REPO" --json assets -q '.assets[] | [.name, .url, (.size|tostring)] | @tsv')
[ "$bad" -eq 0 ] || die "release $OSB_TAG is published but an asset does not download intact; fix the asset by hand"

echo "RELEASE: $url"
echo "tag: $OSB_TAG -> $OSB_TARGET_SHA"
echo "covers: $OSB_SCOPE_VERSIONS (PRs: $OSB_SCOPE_PRS)"
