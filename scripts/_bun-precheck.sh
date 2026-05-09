#!/usr/bin/env bash
# Sourced by scripts/o2b and scripts/vault-log to verify Bun is present
# and meets the declared minimum version (>=1.1.0, mirrored against
# `engines.bun` in package.json).
#
# Side effects: writes a clear error to stderr and exits the calling
# script if Bun is missing, unparseable, or older than the minimum.
# No-op on success.

# shellcheck shell=bash
set -euo pipefail

MIN_BUN_MAJOR=1
MIN_BUN_MINOR=1
MIN_BUN_PATCH=0

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
