#!/bin/sh
# Stages the rendered draft as a DRAFT GitHub release, so the operator gate
# shows the title, body and animated GIF exactly as they will publish. A draft
# is visible to repository maintainers only and creates no tag. Created with
# `gh release create --draft --target <sha> --notes-file`; a re-stage after a
# revision updates the same draft and replaces its assets.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
load_scope
w="$OSB_WORK"
title=$(head -n1 "$w/title.txt")
slug=$(tr -d '[:space:]' <"$w/slug.txt")
base="$OSB_TAG-$slug"
assets=("$w/assets/$base.gif" "$w/assets/$base.png" "$w/assets/$base-source@2x.png" "$w/assets/$base-source.svg")
for a in "${assets[@]}"; do [ -s "$a" ] || die "$a is missing: the render node did not produce it"; done

state=$(gh release view "$OSB_TAG" --repo "$OSB_REPO" --json isDraft -q '.isDraft' 2>/dev/null || echo absent)
case "$state" in
  false) die "release $OSB_TAG is already published; nothing is staged over a public release" ;;
  true)
    gh release edit "$OSB_TAG" --repo "$OSB_REPO" --draft --target "$OSB_TARGET_SHA" \
      --title "$title" --notes-file "$w/body.md" >/dev/null || die "gh release edit of the draft failed"
    want=$(printf '%s\n' "${assets[@]##*/}")
    for old in $(gh release view "$OSB_TAG" --repo "$OSB_REPO" --json assets -q '.assets[].name'); do
      grep -qxF "$old" <<<"$want" || gh release delete-asset "$OSB_TAG" "$old" --repo "$OSB_REPO" --yes >/dev/null
    done
    gh release upload "$OSB_TAG" "${assets[@]}" --repo "$OSB_REPO" --clobber >/dev/null || die "asset upload to the draft failed"
    ;;
  absent)
    gh release create "$OSB_TAG" "${assets[@]}" --repo "$OSB_REPO" --draft --target "$OSB_TARGET_SHA" \
      --title "$title" --notes-file "$w/body.md" >/dev/null || die "gh release create --draft failed"
    ;;
esac

info=$(gh release view "$OSB_TAG" --repo "$OSB_REPO" --json isDraft,name,targetCommitish,url,assets \
  -q '[(.isDraft|tostring), .name, .targetCommitish, .url, ([.assets[].name]|sort|join(","))]|@tsv')
IFS=$'\t' read -r is_draft name target url names <<<"$info"
[ "$is_draft" = true ] || die "the staged release is not a draft"
[ "$name" = "$title" ] || die "the draft title is '$name', expected '$title'"
[ "$target" = "$OSB_TARGET_SHA" ] || die "the draft targets '$target', expected $OSB_TARGET_SHA"
expected=$(printf '%s\n' "${assets[@]##*/}" | sort | paste -sd, -)
[ "$names" = "$expected" ] || die "the draft assets are '$names', expected '$expected'"
if git ls-remote --exit-code --tags origin "refs/tags/$OSB_TAG" >/dev/null 2>&1; then
  die "tag $OSB_TAG appeared on origin while staging; stop and inspect"
fi

echo "STAGED: $url"
echo "title: $title"
echo "target: $OSB_TARGET_SHA"
echo "assets: $names"
echo "local copies: $w/assets/"
