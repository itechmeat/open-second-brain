#!/usr/bin/env python3
"""Propagate the version from ``pyproject.toml`` to runtime manifests.

The single source of truth for the Open Second Brain version is the
``[project] version`` field in ``pyproject.toml``. Python code resolves it
dynamically (see ``src/open_second_brain/__init__.py``).

Manifests consumed by external runtimes (Hermes, OpenClaw, Claude Code,
Codex, npm) are read raw without templating, so they have to carry a copy
of the version on disk. This script propagates the canonical value into
every such file. It is idempotent: rerunning when nothing changed exits
cleanly with no writes.

Files NOT touched by design:

  - ``CHANGELOG.md`` — historical record, edited by hand on release.
  - ``install.md`` — install commands MUST NOT pin a specific version
    (``@vX.Y.Z``); they always pull the latest from the default branch.
  - ``docs/architecture.md`` — same rule as ``install.md`` for example
    commands inside the doc.
  - ``tests/`` — fixtures may reference specific historical versions.

Usage::

    python3 scripts/sync-version.py                  # write changes
    python3 scripts/sync-version.py --check          # exit 1 if any drift
"""

from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------

# Files where ``version: "X.Y.Z"`` appears once, on its own line (YAML).
YAML_TARGETS: tuple[str, ...] = (
    "plugin.yaml",
    "plugins/hermes/plugin.yaml",
)

# Files where ``"version": "X.Y.Z"`` appears once at the top level (JSON).
# We do NOT round-trip through ``json.loads``/``json.dumps`` because that
# rewrites whitespace, key order, and trailing newlines. Regex replacement
# preserves the file byte-for-byte except for the version string itself.
JSON_TARGETS: tuple[str, ...] = (
    "package.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "openclaw.plugin.json",
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_YAML_RE = re.compile(r'^(version:\s*)"[^"]*"', re.MULTILINE)
_JSON_RE = re.compile(r'("version"\s*:\s*)"[^"]*"')


def canonical_version() -> str:
    pyproject = ROOT / "pyproject.toml"
    with pyproject.open("rb") as fh:
        data = tomllib.load(fh)
    project = data.get("project") or {}
    version = project.get("version")
    if not isinstance(version, str) or not version:
        raise SystemExit(f"{pyproject} is missing [project].version")
    return version


def _replace(text: str, regex: re.Pattern[str], version: str) -> str:
    return regex.sub(rf'\g<1>"{version}"', text, count=1)


def update_file(path: Path, regex: re.Pattern[str], version: str, *, write: bool) -> tuple[bool, bool]:
    """Return ``(matched, would_change)``.

    ``matched`` — the regex found a version line in this file at all.
    ``would_change`` — the current value differs from ``version``.
    """
    text = path.read_text(encoding="utf-8")
    new = _replace(text, regex, version)
    if not regex.search(text):
        return False, False
    if new == text:
        return True, False
    if write:
        path.write_text(new, encoding="utf-8")
    return True, True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit 1 if any manifest drifts from pyproject.toml; do not write.",
    )
    args = parser.parse_args(argv)

    version = canonical_version()
    print(f"canonical version: {version}")

    drifted: list[str] = []
    for rel in YAML_TARGETS:
        path = ROOT / rel
        matched, would_change = update_file(path, _YAML_RE, version, write=not args.check)
        if not matched:
            print(f"  WARN no version line in {rel}", file=sys.stderr)
            continue
        if would_change:
            drifted.append(rel)
            print(f"  {'DRIFT' if args.check else 'wrote'}: {rel}")
        else:
            print(f"  ok:    {rel}")

    for rel in JSON_TARGETS:
        path = ROOT / rel
        matched, would_change = update_file(path, _JSON_RE, version, write=not args.check)
        if not matched:
            print(f"  WARN no version line in {rel}", file=sys.stderr)
            continue
        if would_change:
            drifted.append(rel)
            print(f"  {'DRIFT' if args.check else 'wrote'}: {rel}")
        else:
            print(f"  ok:    {rel}")

    if args.check and drifted:
        print(
            f"\n{len(drifted)} file(s) out of sync with pyproject.toml; "
            "run scripts/sync-version.py to fix.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
