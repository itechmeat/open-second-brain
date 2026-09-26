# Shared helpers for the osb-pr-prepare script nodes. Sourced, never run.
#
# apb hands a script node no parameters and no environment of its own, so the
# per-run facts (base branch, change kind, release bump, PR number) travel in
# files under the repository's git directory, which git never tracks:
#
#   $(git rev-parse --git-path osb-pr-prepare)/context.env   written by `intake`
#   $(git rev-parse --git-path osb-pr-prepare)/pr.env        written by `push_pr`
#   $(git rev-parse --git-path osb-pr-prepare)/known-test-failures.txt
#                                                            written by `qa_fix`
#
# A missing file is an explicit error naming the node that should have written
# it, never a silent default.

# The CI toolchain pin (.github/workflows/ci.yml, `bun-version`).
OSB_CI_BUN_VERSION=1.4.0
# The CI Python pin (.github/workflows/ci.yml, `python-version`).
OSB_CI_PYTHON_VERSION=3.11
# The only local embedding model the zg index uses: no remote provider, no key.
OSB_ZG_MODEL=local/potion-code-16m-v2
OSB_KINDS="feature fix refactor chore docs deps"
OSB_RELEASES="major minor patch none"

die() {
  printf 'ERROR: %s\n' "$*"
  exit 2
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "not inside a git work tree"
}

ctx_dir() {
  git rev-parse --path-format=absolute --git-path osb-pr-prepare
}

load_ctx() {
  CTX_DIR=$(ctx_dir)
  [ -f "$CTX_DIR/context.env" ] ||
    die "$CTX_DIR/context.env is missing: the intake node did not record the PR context"
  # shellcheck disable=SC1091
  . "$CTX_DIR/context.env"
  for v in OSB_BASE OSB_KIND OSB_RELEASE OSB_BRANCH; do
    eval "val=\${$v:-}"
    [ -n "$val" ] || die "$v is not set in $CTX_DIR/context.env"
  done
}

load_pr() {
  [ -f "$CTX_DIR/pr.env" ] ||
    die "$CTX_DIR/pr.env is missing: the push_pr node did not record the PR number"
  # shellcheck disable=SC1091
  . "$CTX_DIR/pr.env"
  [ -n "${OSB_PR_NUMBER:-}" ] || die "OSB_PR_NUMBER is not set in $CTX_DIR/pr.env"
}

json_version() {
  # Reads the "version" field of a package.json given on stdin.
  python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
}

# Puts the CI-pinned Bun first on PATH. The Linux release zip is cached under
# ~/.cache/osb-pr-prepare; the download happens once and needs no sudo. Local
# Bun (1.4.x newer than the pin) bundles openclaw/index.js differently, so the
# bundle-in-sync gate is only meaningful with the pinned build.
use_ci_bun() {
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/osb-pr-prepare/bun-$OSB_CI_BUN_VERSION"
  case "$(uname -m)" in
    x86_64) asset=bun-linux-x64 ;;
    aarch64 | arm64) asset=bun-linux-aarch64 ;;
    *) die "no Bun $OSB_CI_BUN_VERSION release asset known for $(uname -m)" ;;
  esac
  bin="$cache/$asset/bun"
  if [ ! -x "$bin" ]; then
    mkdir -p "$cache"
    url="https://github.com/oven-sh/bun/releases/download/bun-v$OSB_CI_BUN_VERSION/$asset.zip"
    curl -fsSL -o "$cache/$asset.zip" "$url" || die "download failed: $url"
    python3 -m zipfile -e "$cache/$asset.zip" "$cache" || die "unzip failed: $cache/$asset.zip"
    chmod +x "$bin"
  fi
  got=$("$bin" --version) || die "cached Bun at $bin does not run"
  [ "$got" = "$OSB_CI_BUN_VERSION" ] || die "cached Bun at $bin reports $got, expected $OSB_CI_BUN_VERSION"
  PATH="$(dirname "$bin"):$PATH"
  export PATH
}

# Prints the interpreter path of the CI-pinned Python, installing it through uv
# (user-level, no sudo) when missing.
ci_python() {
  command -v uv >/dev/null 2>&1 || die "uv is not on PATH; it provides Python $OSB_CI_PYTHON_VERSION"
  uv python find "$OSB_CI_PYTHON_VERSION" 2>/dev/null && return 0
  uv python install "$OSB_CI_PYTHON_VERSION" >/dev/null 2>&1 ||
    die "uv could not install Python $OSB_CI_PYTHON_VERSION"
  uv python find "$OSB_CI_PYTHON_VERSION"
}
