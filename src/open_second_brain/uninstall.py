"""Read-only uninstall planner for Open Second Brain.

The uninstall helper does NOT manage the Hermes plugin install or
MCP registration; those are owned by Hermes. It also never touches the
user's vault. By default it is a dry-run that prints the plan and the
exact Hermes commands the user should run themselves.

When invoked with ``--apply-local`` it may delete the machine-local
Open Second Brain config directory (typically ``~/.config/open-second-brain``).
Anything outside that single directory is left untouched.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from open_second_brain.config import discover_config

PLUGIN_NAME = "open-second-brain"

HERMES_COMMANDS: tuple[str, ...] = (
    f"hermes mcp remove {PLUGIN_NAME}",
    f"hermes plugins remove {PLUGIN_NAME}",
    "hermes gateway restart",
)

SAFE_CONFIG_DIR_NAMES: frozenset[str] = frozenset({"open-second-brain", "open_second_brain"})


@dataclass(frozen=True)
class UninstallPlan:
    """Computed plan for an uninstall invocation."""

    config_path: Path
    config_exists: bool
    config_dir: Path
    config_dir_exists: bool
    config_dir_entries: tuple[Path, ...]
    vault_path: Path | None
    apply_local: bool
    hermes_commands: tuple[str, ...] = HERMES_COMMANDS
    removed_paths: tuple[Path, ...] = field(default_factory=tuple)
    skipped_paths: tuple[tuple[Path, str], ...] = field(default_factory=tuple)
    errors: tuple[tuple[Path, str], ...] = field(default_factory=tuple)


def _is_safe_local_config_dir(target: Path) -> tuple[bool, str]:
    """Return ``(safe, reason)`` for ``target`` as a deletion candidate.

    Only a directory whose final name is one of the well-known Open Second
    Brain config dir names is eligible. The directory must also live outside
    any Hermes config tree to keep us strictly off Hermes-owned state.
    """

    if target.name not in SAFE_CONFIG_DIR_NAMES:
        return False, (
            f"directory name '{target.name}' is not a recognized Open Second Brain "
            "config directory; refusing to remove"
        )

    parts_lower = {part.lower() for part in target.parts}
    if ".hermes" in parts_lower or "hermes" in parts_lower:
        return False, "config directory is inside a Hermes-owned path; refusing to remove"

    if (target / ".git").exists():
        return False, "config directory looks like a git repository; refusing to remove"

    return True, ""


def _vault_path_from_config(data: dict[str, str]) -> Path | None:
    for key in ("vault_path", "vault", "vault_dir", "path"):
        value = data.get(key)
        if value:
            return Path(value).expanduser()
    return None


def _list_entries(directory: Path) -> tuple[Path, ...]:
    if not directory.is_dir():
        return ()
    try:
        return tuple(sorted(directory.iterdir()))
    except OSError:
        return ()


def plan_uninstall(
    *,
    config_path: Path,
    apply_local: bool = False,
) -> UninstallPlan:
    """Compute (and optionally apply-local) an uninstall plan.

    The plan never modifies the Hermes config, the installed plugin
    directory, or the user's vault. With ``apply_local=True`` it may
    remove the machine-local config directory if and only if it passes
    :func:`_is_safe_local_config_dir`.
    """

    discovery = discover_config(config_path)
    cfg_dir = discovery.path.parent
    cfg_dir_exists = cfg_dir.is_dir()
    entries = _list_entries(cfg_dir)
    vault_path = _vault_path_from_config(discovery.data)

    removed: list[Path] = []
    skipped: list[tuple[Path, str]] = []
    errors: list[tuple[Path, str]] = []

    if apply_local:
        if not cfg_dir_exists:
            skipped.append((cfg_dir, "config directory does not exist"))
        else:
            safe, reason = _is_safe_local_config_dir(cfg_dir)
            if not safe:
                skipped.append((cfg_dir, reason))
            else:
                try:
                    shutil.rmtree(cfg_dir)
                    removed.append(cfg_dir)
                except OSError as exc:
                    errors.append((cfg_dir, str(exc)))

    return UninstallPlan(
        config_path=discovery.path,
        config_exists=discovery.exists,
        config_dir=cfg_dir,
        config_dir_exists=cfg_dir_exists,
        config_dir_entries=entries,
        vault_path=vault_path,
        apply_local=apply_local,
        removed_paths=tuple(removed),
        skipped_paths=tuple(skipped),
        errors=tuple(errors),
    )


def render_plan(plan: UninstallPlan) -> str:
    """Render an :class:`UninstallPlan` as plain text for the CLI."""

    lines: list[str] = []
    title = "Open Second Brain — Uninstall plan"
    lines.append(title)
    lines.append("=" * len(title))
    lines.append("")

    mode = "apply-local (machine-local config directory may be removed)" if plan.apply_local else "dry-run (read-only)"
    lines.append(f"Mode: {mode}")
    lines.append("")

    lines.append("Local config:")
    config_state = "exists" if plan.config_exists else "missing"
    lines.append(f"  config file: {plan.config_path} ({config_state})")
    if plan.config_dir_exists:
        entry_count = len(plan.config_dir_entries)
        lines.append(f"  config dir:  {plan.config_dir} ({entry_count} entr{'y' if entry_count == 1 else 'ies'})")
        for entry in plan.config_dir_entries:
            suffix = "/" if entry.is_dir() else ""
            lines.append(f"    - {entry.name}{suffix}")
    else:
        lines.append(f"  config dir:  {plan.config_dir} (missing)")
    lines.append("")

    lines.append("Hermes integration (run these yourself; this tool will not):")
    for cmd in plan.hermes_commands:
        lines.append(f"  $ {cmd}")
    lines.append("")
    lines.append("  Hermes owns plugin installation and MCP registration. Open Second")
    lines.append("  Brain never edits ~/.hermes/config.yaml on your behalf.")
    lines.append("")

    lines.append("Vault (NEVER removed by this tool):")
    if plan.vault_path is not None:
        lines.append(f"  {plan.vault_path}")
    else:
        lines.append("  (no vault path recorded in config; check your runtime settings)")
    lines.append("  Your Markdown notes, Daily/, and AI Wiki/ stay exactly as they are.")
    lines.append("")

    if plan.apply_local:
        lines.append("Apply-local results:")
        if plan.removed_paths:
            for path in plan.removed_paths:
                lines.append(f"  removed: {path}")
        if plan.skipped_paths:
            for path, reason in plan.skipped_paths:
                lines.append(f"  skipped: {path} — {reason}")
        if plan.errors:
            for path, reason in plan.errors:
                lines.append(f"  error:   {path} — {reason}")
        if not (plan.removed_paths or plan.skipped_paths or plan.errors):
            lines.append("  (nothing to do)")
        lines.append("")
    else:
        lines.append("Next steps:")
        lines.append("  1. Run the Hermes commands above to deregister the MCP server and plugin.")
        lines.append("  2. Re-run with --apply-local to remove the machine-local config directory.")
        lines.append("  3. Delete the vault yourself if and only if you really want to lose your notes.")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def iter_hermes_commands() -> Iterable[str]:
    """Public iterator over the Hermes commands the user should run."""

    return iter(HERMES_COMMANDS)
