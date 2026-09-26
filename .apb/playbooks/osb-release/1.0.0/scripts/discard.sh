#!/bin/sh
# Operator chose `abort`: delete the staged DRAFT (never a published release)
# and confirm no tag was created. Nothing public changes.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
load_scope
state=$(gh release view "$OSB_TAG" --repo "$OSB_REPO" --json isDraft -q '.isDraft' 2>/dev/null || echo absent)
case "$state" in
  true) gh release delete "$OSB_TAG" --repo "$OSB_REPO" --yes >/dev/null || die "deleting the draft $OSB_TAG failed" ;;
  false) die "release $OSB_TAG is published; abort does not delete a public release" ;;
  absent) ;;
esac
if git ls-remote --exit-code --tags origin "refs/tags/$OSB_TAG" >/dev/null 2>&1; then
  die "tag $OSB_TAG exists on origin; it was not created by this run's draft - inspect it by hand"
fi
echo "DISCARDED: draft $OSB_TAG removed, no tag, local work kept in $OSB_WORK"
