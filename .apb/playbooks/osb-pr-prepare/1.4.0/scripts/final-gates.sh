#!/bin/sh
# Final gates before the push: the QA gates (qa-gates.sh) and the
# architecture gate (arch-gate.sh) again, after the OpenCodeReview pass may
# have committed fixes. When HEAD is still the commit the QA gates last
# passed on, nothing changed since the green QA and architecture gates (the
# architecture gate runs after the QA gates and any fix it needed moves
# HEAD), so the re-run is skipped.
#
# Exit 0: both green, or skipped (`FINAL-GATES: pass`). Exit 1: a red gate
# (`FINAL-GATES: red`, followed by the markers and output of the red gates).
# Exit 2: a setup or tool error (`ERROR:`), which no code change can fix.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -uo pipefail
here=$(dirname "$0")
. "$here/lib.sh"

cd "$(repo_root)"
load_ctx

head=$(git rev-parse HEAD)
green="$CTX_DIR/qa-green-head"
if [ -f "$green" ] && [ "$(cat "$green")" = "$head" ]; then
  echo "FINAL-GATES: pass (HEAD $head unchanged since the green QA and architecture gates)"
  exit 0
fi

qa_out=$(sh "$here/qa-gates.sh" 2>&1)
qa_rc=$?
arch_out=$(sh "$here/arch-gate.sh" 2>&1)
arch_rc=$?

if [ "$qa_rc" -eq 0 ] && [ "$arch_rc" -eq 0 ]; then
  printf '%s\n%s\n' "$qa_out" "$arch_out"
  echo "FINAL-GATES: pass (QA and architecture gates green at $head)"
  exit 0
fi
if [ "$qa_rc" -eq 2 ] || [ "$arch_rc" -eq 2 ]; then
  printf '%s\n%s\n' "$qa_out" "$arch_out"
  die "a gate could not run (qa exit $qa_rc, arch exit $arch_rc)"
fi
echo "FINAL-GATES: red (qa exit $qa_rc, arch exit $arch_rc)"
printf '%s\n%s\n' "$qa_out" "$arch_out"
exit 1
