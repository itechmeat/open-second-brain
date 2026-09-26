# Shared helpers for the osb-release script nodes. Sourced, never run.
#
# apb hands a script node no parameters, so the per-run facts travel in files
# under the git directory, which git never tracks:
#
#   $(git rev-parse --git-path osb-release)/context.env   OSB_TARGET_SHA, by `intake`
#   $(git rev-parse --git-path osb-release)/scope.env     version, tags, work dir, by `scope`
#   <work dir> = $(git rev-parse --git-path osb-release)/vX.Y.Z/
#     title.txt, body.md, slug.txt, vX.Y.Z-<slug>-source.svg   by `draft`
#     canon/<previous image release>-source.svg                 by `scope`
#     assets/                                                   by `render`
#
# A missing file is an explicit error naming the node that should have
# written it.

OSB_REPO=itechmeat/open-second-brain
OSB_REPO_URL="https://github.com/$OSB_REPO"
# The rasterizer the published images were made with (sharp 0.34.5).
OSB_SHARP_VERSION=0.34.5
# Static ffmpeg used when none is on PATH: johnvansickle's release build 7.0.2,
# pinned by checksum because that URL always serves the newest release.
OSB_FFMPEG_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
OSB_FFMPEG_SHA256=abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67
OSB_FFMPEG_DIR_NAME=ffmpeg-7.0.2-amd64-static
# Image canon (release-image-style.md): canvas and the smallest legible font.
OSB_IMAGE_WIDTH=1640
OSB_IMAGE_HEIGHT=1240
OSB_MIN_FONT_PX=17

die() {
  printf 'ERROR: %s\n' "$*"
  exit 2
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "not inside a git work tree"
}

state_dir() {
  git rev-parse --path-format=absolute --git-path osb-release
}

load_context() {
  STATE_DIR=$(state_dir)
  [ -f "$STATE_DIR/context.env" ] ||
    die "$STATE_DIR/context.env is missing: the intake node did not record the target"
  # shellcheck disable=SC1091
  . "$STATE_DIR/context.env"
  [[ "${OSB_TARGET_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "OSB_TARGET_SHA='${OSB_TARGET_SHA:-}' is not a full commit sha"
}

load_scope() {
  load_context
  [ -f "$STATE_DIR/scope.env" ] || die "$STATE_DIR/scope.env is missing: the scope node did not run"
  # shellcheck disable=SC1091
  . "$STATE_DIR/scope.env"
}

cache_dir() {
  printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/osb-release"
}

# Prints the ffmpeg to use: one on PATH, else the pinned static build, fetched
# once into the cache (no sudo). A checksum mismatch is a named failure: the
# upstream build moved and must be verified before the pin is updated.
ensure_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    command -v ffmpeg
    return 0
  fi
  [ "$(uname -m)" = x86_64 ] || die "no ffmpeg on PATH and no pinned static build for $(uname -m)"
  dir="$(cache_dir)/$OSB_FFMPEG_DIR_NAME"
  if [ ! -x "$dir/ffmpeg" ]; then
    mkdir -p "$(cache_dir)"
    archive="$(cache_dir)/ffmpeg-static.tar.xz"
    curl -fsSL -o "$archive" "$OSB_FFMPEG_URL" || die "ffmpeg download failed: $OSB_FFMPEG_URL"
    got=$(sha256sum "$archive" | cut -d' ' -f1)
    [ "$got" = "$OSB_FFMPEG_SHA256" ] ||
      die "ffmpeg archive checksum $got is not the pinned $OSB_FFMPEG_SHA256: the upstream release build changed; verify it and update the pin in lib.sh"
    tar -xJf "$archive" -C "$(cache_dir)" || die "cannot unpack $archive"
    [ -x "$dir/ffmpeg" ] || die "the ffmpeg archive did not contain $OSB_FFMPEG_DIR_NAME/ffmpeg"
  fi
  printf '%s\n' "$dir/ffmpeg"
}

# Installs the pinned sharp into the cache once and places render.ts beside it.
# Prints the directory to run `bun render.ts` in.
ensure_sharp() {
  here=$1
  dir="$(cache_dir)/render-sharp-$OSB_SHARP_VERSION"
  mkdir -p "$dir"
  if [ ! -f "$dir/node_modules/sharp/package.json" ]; then
    [ -f "$dir/package.json" ] || printf '{ "private": true }\n' >"$dir/package.json"
    (cd "$dir" && bun add "sharp@$OSB_SHARP_VERSION" >/dev/null 2>&1) ||
      die "bun add sharp@$OSB_SHARP_VERSION failed in $dir"
  fi
  got=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$dir/node_modules/sharp/package.json")
  [ "$got" = "$OSB_SHARP_VERSION" ] || die "$dir holds sharp $got, expected $OSB_SHARP_VERSION"
  cp "$here/render.ts" "$dir/render.ts"
  printf '%s\n' "$dir"
}
