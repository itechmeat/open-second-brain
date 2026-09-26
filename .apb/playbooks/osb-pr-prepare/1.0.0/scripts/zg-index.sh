#!/bin/sh
# Idempotent: makes sure the workspace has a ready zg (zvec-grep) index built
# with a LOCAL embedding model. A missing index is created, an existing one is
# refreshed incrementally and keeps its stored model (the env default only
# applies to a new index). No remote provider, no credential, no daemon
# (`--mode direct`). The index lives in <root>/.zvec-grep, which the OSB
# .gitignore lists, so neither git nor oxfmt sees it.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cd "$(repo_root)"
command -v zg >/dev/null 2>&1 || die "zg is not on PATH"
git check-ignore -q .zvec-grep/ || die ".zvec-grep/ is not ignored: add it to the repository .gitignore"

export ZVEC_GREP_EMBEDDING="$OSB_ZG_MODEL"
export ZVEC_GREP_DEVICE=cpu
zg index --mode direct 2>&1
zg status --mode direct --check-ready 2>&1
echo "ZG-INDEX: ready"
