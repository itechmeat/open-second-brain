#!/bin/sh
# Validates the draft deterministically and renders the release image the way
# every image since v1.0.0 was made (release-image-style.md, "Export"):
#   sharp  source.svg -> <tag>-<slug>-source@2x.png  (3280x2480)
#   sharp  source.svg -> <tag>-<slug>.png            (1640x1240, cursor on)
#   sharp  two frames (cursor on / cursor off) -> ffmpeg palettegen/paletteuse
#          -> <tag>-<slug>.gif (2 frames, 600 ms each, infinite loop)
#
# Exit 0 `RENDER: ok`; exit 1 `RENDER: invalid - ...` (the draft must change);
# exit 2 `ERROR:` (the toolchain is unavailable: a named failure, never a fake
# image). The draft node may run this script itself before it finishes.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"

problems=()
invalid() { problems+=("$*"); }

cd "$(repo_root)"
load_scope
command -v bun >/dev/null 2>&1 || die "bun is not on PATH"

w="$OSB_WORK"
[ -f "$w/slug.txt" ] || die "$w/slug.txt is missing: the draft node did not write it"
slug=$(tr -d '[:space:]' <"$w/slug.txt")
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || invalid "slug '$slug' is not kebab-case"
base="$OSB_TAG-$slug"
src="$w/$base-source.svg"

# Title and body.
title=$(head -n1 "$w/title.txt" 2>/dev/null || true)
[[ "$title" =~ ^$OSB_TAG\ -\ [^[:space:]].*$ ]] || invalid "title.txt must be '$OSB_TAG - <Tagline>', got '$title'"
[[ "$title" == *"Open Second Brain"* ]] && invalid "the title must not repeat the project name"
body="$w/body.md"
if [ -f "$body" ]; then
  head -n1 "$body" | grep -qE "^## Open Second Brain $OSB_TAG - " ||
    invalid "body.md must open with '## Open Second Brain $OSB_TAG - <Tagline>'"
  grep -qF "$OSB_REPO_URL/releases/download/$OSB_TAG/$base.gif" "$body" ||
    invalid "body.md does not embed $OSB_REPO_URL/releases/download/$OSB_TAG/$base.gif"
  grep -q '^### What ships' "$body" || invalid "body.md has no '### What ships' section"
  grep -q '—' "$body" && invalid "body.md uses an em dash; the house separator is ' - '"
else
  invalid "body.md is missing"
fi

# SVG against the canon: everything up to the header comment (root element,
# defs with the logo, mask and arrow markers, window chrome) must equal the
# canon source with only the version in the window title changed.
if [ -f "$src" ]; then
  python3 - "$OSB_CANON_SVG" "$src" "$OSB_TAG" "$OSB_MIN_FONT_PX" "$OSB_IMAGE_WIDTH" "$OSB_IMAGE_HEIGHT" >"$w/svg-check.txt" <<'PY' || true
import re, sys
canon_path, src_path, tag, min_px, width, height = sys.argv[1:]
canon, src = open(canon_path, encoding="utf-8").read(), open(src_path, encoding="utf-8").read()
MARK = "<!-- header"
out = []
if MARK not in canon:
    out.append(f"canon {canon_path} has no '{MARK}' marker")
elif MARK not in src:
    out.append(f"the SVG has no '{MARK}' marker after the chrome")
else:
    title_re = re.compile(r"o2b - open-second-brain - v\d+\.\d+\.\d+")
    want = title_re.sub(f"o2b - open-second-brain - {tag}", canon.split(MARK)[0])
    if src.split(MARK)[0] != want:
        out.append("the root element, <defs> or window chrome differ from the canon; copy them verbatim and change only the version in the window title")
if f'viewBox="0 0 {width} {height}"' not in src:
    out.append(f"viewBox must be 0 0 {width} {height}")
if not re.search(r'<rect id="cursor"[^>]*>', src):
    out.append('no <rect id="cursor"> for the blinking frame')
sizes = [float(s) for s in re.findall(r'font-size="([\d.]+)"', src)]
sizes += [float(s) for s in re.findall(r'font-size:\s*([\d.]+)px', src)]
small = sorted({s for s in sizes if s < float(min_px)})
if small:
    out.append(f"font sizes below {min_px}px: {small}")
if tag not in src.split(MARK)[-1]:
    out.append(f"the header does not show {tag}")
print("\n".join(out))
PY
  while IFS= read -r line; do [ -n "$line" ] && invalid "svg: $line"; done <"$w/svg-check.txt"
else
  invalid "$src is missing"
fi

if [ "${#problems[@]}" -gt 0 ]; then
  echo "RENDER: invalid - ${#problems[@]} problem(s)"
  printf -- '- %s\n' "${problems[@]}"
  exit 1
fi

# Toolchain (cached, no sudo); a failure here is exit 2, never a fake image.
ffmpeg=$(ensure_ffmpeg)
ffprobe="$(dirname "$ffmpeg")/ffprobe"
[ -x "$ffprobe" ] || ffprobe=$(command -v ffprobe) || die "ffprobe not found beside $ffmpeg"
sharp_dir=$(ensure_sharp "$here")

out="$w/assets"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
rm -rf "$out"
mkdir -p "$out"
cp "$src" "$out/$base-source.svg"
cp "$src" "$tmp/frame1.svg"
sed -E 's#(<rect id="cursor"[^>]*)>#\1 opacity="0">#' "$src" >"$tmp/frame2.svg"
render() { (cd "$sharp_dir" && bun render.ts "$1" "$2" "$3") || die "sharp render of $1 failed"; }
render "$out/$base-source.svg" "$out/$base-source@2x.png" 2
render "$tmp/frame1.svg" "$out/$base.png" 1
render "$tmp/frame1.svg" "$tmp/frame1.png" 1
render "$tmp/frame2.svg" "$tmp/frame2.png" 1
"$ffmpeg" -loglevel error -y -framerate 5/3 -i "$tmp/frame%d.png" \
  -vf "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=none" \
  -loop 0 "$out/$base.gif" || die "ffmpeg GIF encoding failed"

probe() { "$ffprobe" -v error -count_frames -select_streams v:0 \
  -show_entries stream=width,height,nb_read_frames -of csv=p=0 "$1"; }
check() { # check <file> <expected "w,h[,frames]">
  got=$(probe "$1")
  [ "$got" = "$2" ] || die "$(basename "$1") probes as '$got', expected '$2'"
}
check "$out/$base-source@2x.png" "$((OSB_IMAGE_WIDTH * 2)),$((OSB_IMAGE_HEIGHT * 2)),1"
check "$out/$base.png" "$OSB_IMAGE_WIDTH,$OSB_IMAGE_HEIGHT,1"
check "$out/$base.gif" "$OSB_IMAGE_WIDTH,$OSB_IMAGE_HEIGHT,2"
cmp -s "$tmp/frame1.png" "$tmp/frame2.png" && die "the two GIF frames are identical: the cursor did not toggle"

echo "RENDER: ok"
ls -l "$out" | sed 1d
echo "ffmpeg: $("$ffmpeg" -version | head -n1)"
echo "sharp: $OSB_SHARP_VERSION ($sharp_dir)"
