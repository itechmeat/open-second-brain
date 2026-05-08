"""Install (and optionally remove) CLI symlinks for o2b and vault-log.

After ``hermes plugins install`` (or ``pip install``), the ``o2b`` and
``vault-log`` entry-points may not be on PATH. This module creates
symlinks from ``~/.local/bin/o2b`` → ``scripts/o2b`` (and the same for
vault-log) so the bare commands work immediately.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

CLI_SCRIPTS: tuple[str, ...] = ("o2b", "vault-log")


@dataclass(frozen=True)
class InstallResult:
    """Outcome of an install-cli run."""

    bindir: Path
    outcomes: tuple[tuple[str, str], ...]
    errors: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class UninstallResult:
    """Outcome of a remove-cli run."""

    bindir: Path
    outcomes: tuple[tuple[str, str], ...]
    errors: tuple[str, ...] = field(default_factory=tuple)


def _repo_root() -> Path:
    """Return the repository root (two directories above this module)."""
    return Path(__file__).resolve().parent.parent.parent


def _scripts_dir() -> Path:
    """Return the ``scripts/`` directory inside the repo root."""
    return _repo_root() / "scripts"


def _find_script(name: str) -> Path | None:
    """Return the absolute path to a script, or ``None`` if it is missing."""
    script = _scripts_dir() / name
    if script.is_file():
        return script.resolve()
    return None


def _is_valid_symlink(link: Path, target: Path) -> bool:
    """Return ``True`` when *link* points to *target*."""
    try:
        return link.resolve() == target.resolve()
    except OSError:
        return False


def install_cli(bindir: Path | None = None) -> InstallResult:
    """Create (or verify) symlinks for o2b and vault-log.

    Args:
        bindir: Target directory. Defaults to ``~/.local/bin``.

    Returns an :class:`InstallResult`.
    """
    if bindir is None:
        bindir = Path.home() / ".local" / "bin"

    bindir.mkdir(parents=True, exist_ok=True)

    outcomes: list[tuple[str, str]] = []
    errors: list[str] = []

    for name in CLI_SCRIPTS:
        link = bindir / name
        source = _find_script(name)

        if source is None:
            msg = f"error: script 'scripts/{name}' not found in {_scripts_dir()}"
            outcomes.append((name, msg))
            errors.append(msg)
            continue

        if link.is_symlink():
            if _is_valid_symlink(link, source):
                outcomes.append((name, f"exists: {link} → {source}"))
            else:
                existing_target = "unknown"
                try:
                    existing_target = str(link.readlink())
                except OSError:
                    pass
                msg = f"warning: {link} already points to {existing_target}, not overwriting"
                outcomes.append((name, msg))
        elif link.exists():
            msg = f"warning: {link} exists and is not a symlink, not overwriting"
            outcomes.append((name, msg))
        else:
            try:
                link.symlink_to(source)
                outcomes.append((name, f"created: {link} → {source}"))
            except OSError as exc:
                msg = f"error: could not create symlink {link}: {exc}"
                outcomes.append((name, msg))
                errors.append(msg)

    return InstallResult(
        bindir=bindir,
        outcomes=tuple(outcomes),
        errors=tuple(errors),
    )


def uninstall_cli(bindir: Path | None = None) -> UninstallResult:
    """Remove the symlinks created by :func:`install_cli`.

    Only removes a symlink when it points into the ``scripts/`` directory
    of **this** repository (to avoid removing unrelated symlinks that happen
    to share the same name).

    Args:
        bindir: Directory with the symlinks. Defaults to ``~/.local/bin``.

    Returns an :class:`UninstallResult`.
    """
    if bindir is None:
        bindir = Path.home() / ".local" / "bin"

    repo_scripts = _scripts_dir()
    outcomes: list[tuple[str, str]] = []
    errors: list[str] = []

    for name in CLI_SCRIPTS:
        link = bindir / name

        if not link.is_symlink():
            if link.exists():
                msg = f"skipped: {link} is not a symlink — refusing to remove"
                outcomes.append((name, msg))
            else:
                outcomes.append((name, f"skipped: {link} does not exist"))
            continue

        # Resolve the target of the symlink
        try:
            target = link.resolve()
        except OSError as exc:
            msg = f"error: cannot resolve {link}: {exc}"
            outcomes.append((name, msg))
            errors.append(msg)
            continue

        # Only remove if the target is inside our scripts/ directory
        try:
            target.relative_to(repo_scripts)
        except ValueError:
            msg = f"skipped: {link} → {target} is outside this repo's scripts/ — refusing to remove"
            outcomes.append((name, msg))
            continue

        try:
            link.unlink()
            outcomes.append((name, f"removed: {link}"))
        except OSError as exc:
            msg = f"error: cannot unlink {link}: {exc}"
            outcomes.append((name, msg))
            errors.append(msg)

    return UninstallResult(
        bindir=bindir,
        outcomes=tuple(outcomes),
        errors=tuple(errors),
    )


def render_install_result(result: InstallResult) -> str:
    """Render an :class:`InstallResult` as plain text."""
    lines: list[str] = []
    lines.append(f"o2b install-cli — {result.bindir}")
    lines.append("-" * 40)
    for name, msg in result.outcomes:
        lines.append(f"  {name}: {msg}")
    if result.errors:
        lines.append("")
        lines.append(f"{len(result.errors)} error(s).")
    return "\n".join(lines).rstrip() + "\n"


def render_uninstall_result(result: UninstallResult) -> str:
    """Render an :class:`UninstallResult` as plain text."""
    lines: list[str] = []
    lines.append(f"o2b uninstall --remove-cli — {result.bindir}")
    lines.append("-" * 40)
    for name, msg in result.outcomes:
        lines.append(f"  {name}: {msg}")
    if result.errors:
        lines.append("")
        lines.append(f"{len(result.errors)} error(s).")
    return "\n".join(lines).rstrip() + "\n"
