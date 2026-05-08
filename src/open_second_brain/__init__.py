"""Open Second Brain core package."""

from __future__ import annotations


def _resolve_version() -> str:
    """Resolve the package version from a single source of truth.

    Order of resolution:

    1. ``pyproject.toml`` reachable from the source file. Preferred because
       editable installs (``pip install -e .``) snapshot ``dist-info`` at
       install time and go stale on every version bump until reinstall.
       Reading the live ``pyproject.toml`` keeps the runtime version in
       sync with the working tree without forcing a reinstall step.
    2. Installed package metadata via ``importlib.metadata``. Used when
       the package was installed from a wheel and no source tree is
       reachable (no ``pyproject.toml`` next to the code).
    3. A safe sentinel (``"0.0.0+unknown"``) so callers never crash on a
       missing version — surfaces clearly in logs / status checks.

    Other files that carry a copy of the version (manifests, package.json,
    install commands) are kept in sync by ``scripts/sync-version.py``,
    which reads the same ``pyproject.toml``.
    """
    try:
        import tomllib
        from pathlib import Path
    except ImportError:
        tomllib = None  # type: ignore[assignment]
        Path = None  # type: ignore[assignment]

    if tomllib is not None and Path is not None:
        here = Path(__file__).resolve()
        for parent in here.parents:
            candidate = parent / "pyproject.toml"
            if not candidate.is_file():
                continue
            try:
                with candidate.open("rb") as fh:
                    data = tomllib.load(fh)
            except (OSError, ValueError):
                break
            project = data.get("project") or {}
            if project.get("name") != "open-second-brain":
                # A pyproject.toml exists but it's for a different project
                # (e.g. when this package is vendored into another repo).
                # Don't claim somebody else's version — fall through.
                break
            value = project.get("version")
            if isinstance(value, str) and value:
                return value
            break

    try:
        from importlib.metadata import version as _pkg_version

        return _pkg_version("open-second-brain")
    except Exception:
        return "0.0.0+unknown"


__version__ = _resolve_version()

__all__ = ["__version__"]
