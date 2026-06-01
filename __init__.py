"""Hermes plugin entrypoint for OpenSecondBrain.

Hermes installs Git plugins by cloning the repository and loading the repository
root as the plugin directory. The implementation lives in ``plugins/hermes`` so
it can also be used directly by runtimes that expect an adapter subdirectory.

TEMPORARY WORKAROUND (third import branch below)
------------------------------------------------
Hermes' external memory-provider loader (``plugins/memory/_load_provider_from_dir``)
imports this file under a synthetic package name ``_hermes_user_memory.<plugin>``
but never registers that parent namespace package. As a result ANY relative
import in an external (user-installed) provider fails with
``ModuleNotFoundError: No module named '_hermes_user_memory'`` — this affects a
flat single-directory layout too, not just our ``plugins/`` subpackage. Bundled
providers escape it only because they load as ``plugins.memory.<name>`` (that
parent IS registered). The file-path fallback below sidesteps the broken parent
chain so the provider loads.

This is a Hermes-core limitation, not a plugin bug. The correct fix is upstream
(``NousResearch/hermes-agent``): have the loader register the
``_hermes_user_memory`` parent namespace. REMOVE the third ``except`` branch once
that ships — the first two import branches are the real, native ones. The same
limitation blocks the ``hermes open-second-brain`` diagnostic CLI subcommand;
it will start working from the same upstream fix with no further changes here.
"""

from __future__ import annotations

try:
    # Normal package import: adapter-subdir runtimes and Hermes' general
    # plugin manager load the repo root as a package, so the implementation
    # subpackage resolves relatively.
    from .plugins.hermes import (
        OpenSecondBrainMemoryProvider,
        check_health,
        health,
        register,
    )
except ImportError:
    try:
        from plugins.hermes import (
            OpenSecondBrainMemoryProvider,
            check_health,
            health,
            register,
        )
    except ImportError:
        # === TEMPORARY WORKAROUND — remove with upstream Hermes loader fix ===
        # See the module docstring. Hermes' memory loader imports this file as
        # ``_hermes_user_memory.<plugin>`` without registering that parent
        # namespace, so the relative/absolute imports above raise
        # ``ModuleNotFoundError: No module named '_hermes_user_memory'``. Load
        # the implementation by file path under a collision-free package name;
        # ``submodule_search_locations`` lets its own relative imports
        # (``.provider``, ``._base``, …) resolve.
        import importlib.util as _ilu
        import os as _os
        import sys as _sys

        _impl_dir = _os.path.join(
            _os.path.dirname(_os.path.abspath(__file__)), "plugins", "hermes"
        )
        _pkg = "_osb_hermes_impl"
        _mod = _sys.modules.get(_pkg)
        if _mod is None:
            _spec = _ilu.spec_from_file_location(
                _pkg,
                _os.path.join(_impl_dir, "__init__.py"),
                submodule_search_locations=[_impl_dir],
            )
            _mod = _ilu.module_from_spec(_spec)
            _sys.modules[_pkg] = _mod
            _spec.loader.exec_module(_mod)
        OpenSecondBrainMemoryProvider = _mod.OpenSecondBrainMemoryProvider
        check_health = _mod.check_health
        health = _mod.health
        register = _mod.register

__all__ = ["OpenSecondBrainMemoryProvider", "check_health", "health", "register"]
