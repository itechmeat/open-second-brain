#!/usr/bin/env bash
# Sourced by scripts/o2b, scripts/o2b-mcp, scripts/o2b-aider, scripts/vault-log
# and scripts/test to verify Bun is present and meets the declared minimum
# version (>=1.1.0, mirrored against `engines.bun` in package.json), and to
# bootstrap the checkout's dependency tree when a marketplace replacement
# removed it (see the block at the bottom).
#
# Side effects: writes a clear error to stderr and exits the calling
# script if Bun is missing, unparseable, or older than the minimum.
# If the checkout's node_modules is missing, runs one
# `bun install --frozen-lockfile` before returning. No-op on success
# when the dependency tree is present.

# shellcheck shell=bash
set -euo pipefail

MIN_BUN_MAJOR=1
MIN_BUN_MINOR=1
MIN_BUN_PATCH=0

# A caller launched with a minimal inherited PATH (a Hermes gateway spawns
# its plugins that way) can miss a Bun that is installed and one directory
# away. Adopt the standard install location before deciding it is absent.
if ! command -v bun >/dev/null 2>&1 && [[ -x "${HOME:-}/.bun/bin/bun" ]]; then
  PATH="${HOME}/.bun/bin${PATH:+:${PATH}}"
  export PATH
fi

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<EOS
error: 'bun' is not on PATH.

Open Second Brain v0.7+ runs on the Bun JavaScript runtime (>=${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.${MIN_BUN_PATCH}). Install it with:

  curl -fsSL https://bun.sh/install | bash

Then re-open your shell, or source the rc file your shell uses
(e.g. ~/.bashrc, ~/.zshrc) so ~/.bun/bin lands on PATH.
EOS
  exit 127
fi

_BUN_PRECHECK_VERSION=$(bun --version 2>/dev/null | tr -d '\r' | head -n1)
if ! [[ "$_BUN_PRECHECK_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  echo "error: could not parse 'bun --version' output: '${_BUN_PRECHECK_VERSION}'" >&2
  exit 1
fi
_BUN_MAJOR="${BASH_REMATCH[1]}"
_BUN_MINOR="${BASH_REMATCH[2]}"
_BUN_PATCH="${BASH_REMATCH[3]}"

if (( _BUN_MAJOR < MIN_BUN_MAJOR )) \
  || ( (( _BUN_MAJOR == MIN_BUN_MAJOR )) && (( _BUN_MINOR < MIN_BUN_MINOR )) ) \
  || ( (( _BUN_MAJOR == MIN_BUN_MAJOR )) && (( _BUN_MINOR == MIN_BUN_MINOR )) && (( _BUN_PATCH < MIN_BUN_PATCH )) ); then
  cat >&2 <<EOS
error: bun ${_BUN_PRECHECK_VERSION} is older than the required ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.${MIN_BUN_PATCH}.

Upgrade with:

  bun upgrade
EOS
  exit 1
fi

# ── Dependency bootstrap ────────────────────────────────────────────────────
# A marketplace add/upgrade (`codex plugin marketplace add|upgrade`) replaces
# this checkout wholesale, so node_modules can arrive missing even though
# package.json and bun.lock ship with the tree. The CLI then cannot start
# (`Cannot find package 'proper-lockfile'`, the one runtime dependency), and
# `o2b install-cli` cannot repair anything because it runs through the same
# import. Probe for that package with one file stat - no Bun startup - and
# run the documented install once when it is missing. The common case
# (node_modules present) pays the stat and nothing more.
#
# The root is the checkout the launcher belongs to. Launchers export
# REPO_ROOT before sourcing this file; anything else (scripts/test) falls
# back to the parent of this script's own scripts/ directory, derived with
# parameter expansion so no external utility is needed - the isolated-PATH
# environments this precheck is tested in ship none beyond cat, tr and head.
# Pure-bash suffix strip: <root>/scripts/_bun-precheck.sh -> <root>.
#
# Test/CI seam (undocumented in user-facing help), following
# _macos-sqlite.sh: O2B_SKIP_DEP_BOOTSTRAP=1 skips the install for callers
# that manage node_modules themselves.
_BUN_PRECHECK_DEPS_ROOT=${REPO_ROOT:-}
if [[ -z "$_BUN_PRECHECK_DEPS_ROOT" ]]; then
  _BUN_PRECHECK_DEPS_ROOT=$(cd -- "${BASH_SOURCE[0]%/*}/.." 2>/dev/null && pwd || true)
fi
if [[ -n "$_BUN_PRECHECK_DEPS_ROOT" ]] && [[ -z "${O2B_SKIP_DEP_BOOTSTRAP:-}" ]] \
  && [[ ! -f "${_BUN_PRECHECK_DEPS_ROOT}/node_modules/proper-lockfile/package.json" ]]; then
  echo "o2b: dependency tree missing in this checkout; running 'bun install --frozen-lockfile'..." >&2
  # stdout goes to stderr: the MCP launchers serve JSON-RPC on stdout, and
  # bun's install report must never interleave with it.
  if ! (cd -- "$_BUN_PRECHECK_DEPS_ROOT" && bun install --frozen-lockfile 1>&2); then
    cat >&2 <<EOS
error: the Open Second Brain checkout at ${_BUN_PRECHECK_DEPS_ROOT} has no dependency tree and the automatic
'bun install --frozen-lockfile' failed. Run that command inside the checkout yourself (plain
'bun install' if the lockfile is out of sync), then retry. See install/codex.md and docs/updating.md.
EOS
    exit 1
  fi
fi
unset _BUN_PRECHECK_DEPS_ROOT _BUN_PRECHECK_VERSION _BUN_MAJOR _BUN_MINOR _BUN_PATCH
