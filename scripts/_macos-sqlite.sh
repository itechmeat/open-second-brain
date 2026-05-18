#!/usr/bin/env bash
# Sourced by scripts/o2b after _bun-precheck.sh.
#
# Apple ships /usr/lib/libsqlite3.dylib with the build flag
# SQLITE_OMIT_LOAD_EXTENSION enabled. bun:sqlite resolves the
# system library by default, so `db.loadExtension(...)` — which
# the sqlite-vec optional dependency uses for semantic search —
# fails with "This build of sqlite3 does not support dynamic
# extension loading".
#
# Homebrew's sqlite formula is built WITH extension loading.
# Setting DYLD_LIBRARY_PATH to the Homebrew lib dir makes the
# dynamic loader pick that build before the system one.
#
# Side effects: exports DYLD_LIBRARY_PATH when (and only when):
#   1. uname -s is Darwin
#   2. DYLD_LIBRARY_PATH is not already set by the caller
#   3. one of the known Homebrew lib prefixes exists on disk
#
# Otherwise no-op. The wrapper continues regardless. Hosts
# without `brew install sqlite` see `o2b search check` report
# `vec_extension: unavailable`, plus the actionable
# recommendation block added in v0.10.5.
#
# Test seams (undocumented in user-facing help):
#   O2B_MACOS_FORCE_PLATFORM        — override `uname -s` ("Darwin" | "Linux")
#   O2B_MACOS_SQLITE_PREFIXES_OVERRIDE — colon-separated prefix list

# shellcheck shell=bash

_o2b_macos_platform=""
if [[ -n "${O2B_MACOS_FORCE_PLATFORM-}" ]]; then
  _o2b_macos_platform="${O2B_MACOS_FORCE_PLATFORM}"
else
  _o2b_macos_platform="$(uname -s 2>/dev/null || echo "")"
fi

if [[ "${_o2b_macos_platform}" != "Darwin" ]]; then
  unset _o2b_macos_platform
  return 0 2>/dev/null || true
fi

# Honour caller-configured DYLD_LIBRARY_PATH verbatim. The user
# may have a tuned path (e.g. testing a custom SQLite build);
# clobbering would be surprising.
if [[ -n "${DYLD_LIBRARY_PATH-}" ]]; then
  unset _o2b_macos_platform
  return 0 2>/dev/null || true
fi

if [[ -n "${O2B_MACOS_SQLITE_PREFIXES_OVERRIDE-}" ]]; then
  IFS=':' read -r -a _o2b_macos_prefixes <<< "${O2B_MACOS_SQLITE_PREFIXES_OVERRIDE}"
else
  _o2b_macos_prefixes=(
    "/opt/homebrew/opt/sqlite/lib"  # Apple Silicon
    "/usr/local/opt/sqlite/lib"     # Intel
  )
fi

for _o2b_macos_prefix in "${_o2b_macos_prefixes[@]}"; do
  if [[ -d "${_o2b_macos_prefix}" ]]; then
    export DYLD_LIBRARY_PATH="${_o2b_macos_prefix}"
    break
  fi
done

unset _o2b_macos_platform _o2b_macos_prefixes _o2b_macos_prefix
