#!/bin/sh
# Scope of the release: EVERYTHING merged since the last published GitHub
# release, up to the target commit, even when that spans several versions.
#
# Refuses (exit 1, `SCOPE: refused - <reason>`) when:
#   - the target is not on origin/main;
#   - the version in package.json at the target is not above the last release;
#   - that version already has a tag or a published release;
#   - the first CHANGELOG heading at the target is not that version;
#   - any version between the last release (exclusive) and the target
#     (inclusive) lacks its CHANGELOG heading or its compare link reference.
# On success writes scope.env, downloads the image canon (the source SVG of the
# most recent release that has one) and prints the scope for the draft node.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

refuse() {
  printf 'SCOPE: refused - %s\n' "$*"
  exit 1
}

cd "$(repo_root)"
load_context
git fetch --quiet --tags origin main || die "git fetch origin main --tags failed"
git cat-file -e "$OSB_TARGET_SHA^{commit}" 2>/dev/null || refuse "target $OSB_TARGET_SHA is not a known commit"
git merge-base --is-ancestor "$OSB_TARGET_SHA" origin/main || refuse "target $OSB_TARGET_SHA is not on origin/main"

version=$(git show "$OSB_TARGET_SHA:package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
tag="v$version"
prev_tag=$(gh release list --repo "$OSB_REPO" --exclude-drafts --exclude-pre-releases --limit 1 --json tagName -q '.[0].tagName // empty')
[ -n "$prev_tag" ] || die "no published release found on $OSB_REPO"
prev_version=${prev_tag#v}
git rev-parse --verify --quiet "refs/tags/$prev_tag" >/dev/null || die "tag $prev_tag of the last release is not in the local clone after fetching tags"
git merge-base --is-ancestor "$prev_tag" "$OSB_TARGET_SHA" || refuse "the last release $prev_tag is not an ancestor of the target"

if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  refuse "tag $tag already exists on origin: version $version is already tagged"
fi
existing=$(gh release view "$tag" --repo "$OSB_REPO" --json isDraft -q '.isDraft' 2>/dev/null || true)
[ "$existing" = false ] && refuse "release $tag is already published"

# Versions in scope and their CHANGELOG evidence, read at the target commit.
changelog=$(mktemp)
trap 'rm -f "$changelog"' EXIT
git show "$OSB_TARGET_SHA:CHANGELOG.md" >"$changelog"
versions=$(python3 - "$changelog" "$prev_version" "$version" "$OSB_REPO_URL" <<'PY'
import re, sys
path, prev, cur, url = sys.argv[1:]
text = open(path, encoding="utf-8").read()
key = lambda v: tuple(int(p) for p in v.split("."))
if key(cur) <= key(prev):
    print(f"REFUSE version {cur} in package.json is not above the last release {prev}")
    sys.exit(0)
headings = re.findall(r"^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?", text, re.M)
if not headings or headings[0][0] != cur:
    first = headings[0][0] if headings else "none"
    print(f"REFUSE the first CHANGELOG heading is [{first}], not [{cur}]")
    sys.exit(0)
listed = [v for v, _ in headings if re.fullmatch(r"\d+\.\d+\.\d+", v)]
in_scope = [v for v in listed if key(prev) < key(v) <= key(cur)]
refs = set(re.findall(r"^\[(\d+\.\d+\.\d+)\]: " + re.escape(url) + r"/compare/v[\d.]+\.\.\.v\1$", text, re.M))
missing = [v for v in in_scope if v not in refs]
if missing:
    print("REFUSE CHANGELOG link references missing for " + ", ".join(missing))
    sys.exit(0)
dates = {v: d for v, d in headings}
undated = [v for v in in_scope if not dates.get(v)]
if undated:
    print("REFUSE CHANGELOG headings without a date for " + ", ".join(undated))
    sys.exit(0)
print(" ".join(in_scope))
PY
)
case "$versions" in REFUSE*) refuse "${versions#REFUSE }" ;; esac
[ -n "$versions" ] || refuse "no CHANGELOG version between $prev_version and $version"

prs=$(git log --first-parent --format='%s' "$prev_tag..$OSB_TARGET_SHA" | sed -n 's/.*(#\([0-9][0-9]*\))$/\1/p' | tr '\n' ' ')

work="$STATE_DIR/$tag"
mkdir -p "$work/canon"
canon_tag=""
for t in $(gh release list --repo "$OSB_REPO" --exclude-drafts --limit 30 --json tagName -q '.[].tagName'); do
  name=$(gh release view "$t" --repo "$OSB_REPO" --json assets -q '[.assets[].name | select(endswith("-source.svg"))][0] // empty')
  if [ -n "$name" ]; then
    canon_tag=$t
    rm -f "$work/canon/"*.svg
    gh release download "$t" --repo "$OSB_REPO" --pattern "$name" --dir "$work/canon" --clobber ||
      die "cannot download $name from release $t"
    canon_svg="$work/canon/$name"
    break
  fi
done
[ -n "$canon_tag" ] || die "no recent release carries a -source.svg asset to take the image canon from"

cat >"$STATE_DIR/scope.env" <<EOF
OSB_VERSION=$version
OSB_TAG=$tag
OSB_PREV_TAG=$prev_tag
OSB_SCOPE_VERSIONS="$versions"
OSB_SCOPE_PRS="$prs"
OSB_WORK=$work
OSB_CANON_TAG=$canon_tag
OSB_CANON_SVG=$canon_svg
EOF

echo "SCOPE: ok"
echo "release: $tag at $OSB_TARGET_SHA (last published release: $prev_tag)"
echo "versions covered: $versions"
echo "merged PRs since $prev_tag: ${prs:-none}"
echo "work dir: $work"
echo "image canon: $canon_svg (from $canon_tag)"
