#!/usr/bin/env bash
# Writes `code=true|false` to $GITHUB_OUTPUT: false only for a pull request
# whose every changed file is prose that nothing ships (docs/ and Markdown
# outside skills/, hooks/ and plugins/). Anything else - a push, any code,
# test, script, skill, hook, plugin, manifest or workflow change, or a diff
# that cannot be read - is true, so a doubtful case runs the full gate.
#
# Needs a checkout of the pull_request merge commit with fetch-depth 2: its
# first parent is the base tip, so HEAD^1..HEAD is exactly the PR's change.
# A root README, LICENSE or SECURITY edit also changes its copy under
# plugins/codex/, so it counts as code.
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"

if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]; then
  echo "code=true" >> "$out"
  exit 0
fi

if ! changed=$(git diff --name-only HEAD^1 HEAD) || [ -z "$changed" ]; then
  echo "code=true" >> "$out"
  exit 0
fi

printf '%s\n' "$changed"

prose='^(docs/.*|[^/]+\.md|(\.github|tests|src|scripts)/.*\.md)$'
if printf '%s\n' "$changed" | grep -qvE "$prose"; then
  echo "code=true" >> "$out"
else
  echo "code=false" >> "$out"
fi
