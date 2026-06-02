"""Hermes plugin entrypoint for Open Second Brain.

Hermes installs Git plugins by cloning the repository and treating the
repository root as the plugin directory, so this file is the entry the gateway
loads first. The ``OpenSecondBrainMemoryProvider`` implementation and its
``register``/health surface live in ``plugins/hermes``.

Self-bootstrap loading
----------------------
This entrypoint loads the implementation package from ``plugins/hermes`` by
file path under a private, collision-free package name, with
``submodule_search_locations`` set so the implementation's own relative imports
(``from . import config``, ``from ._base import ...``) resolve against it. This
is the plugin's single, intentional, host-agnostic load path.

Owning the bootstrap is deliberate. A host runtime that imports the plugin
under a synthetic package without also registering that parent namespace cannot
load a provider written with ordinary relative or absolute imports -- the first
relative import raises ``ModuleNotFoundError`` for the missing parent. Hermes'
external memory-provider loader behaves exactly this way today (it imports
user-installed plugins as ``_hermes_user_memory.<name>`` without registering
``_hermes_user_memory``). Bootstrapping our own package sidesteps that entirely
and stays valid whether or not the host registers the parent, so the
implementation keeps its small single-responsibility modules instead of being
collapsed into one file to dodge the loader. ``OpenSecondBrainMemoryProvider``
is referenced below so Hermes' text-scan discovery heuristic still recognises
this file as a memory provider.
"""

from __future__ import annotations

import importlib.util as _importlib_util
import os as _os
import sys as _sys

_IMPL_DIR = _os.path.join(
    _os.path.dirname(_os.path.abspath(__file__)), "plugins", "hermes"
)
_IMPL_PKG = "_osb_hermes_impl"


def _load_impl():
    """Import ``plugins/hermes`` by file path under a private package name.

    Idempotent: a second import in the same process reuses the cached module,
    so a host that loads this entrypoint more than once gets one implementation.
    """
    module = _sys.modules.get(_IMPL_PKG)
    if module is not None:
        return module
    spec = _importlib_util.spec_from_file_location(
        _IMPL_PKG,
        _os.path.join(_IMPL_DIR, "__init__.py"),
        submodule_search_locations=[_IMPL_DIR],
    )
    module = _importlib_util.module_from_spec(spec)
    _sys.modules[_IMPL_PKG] = module
    spec.loader.exec_module(module)
    return module


_impl = _load_impl()

OpenSecondBrainMemoryProvider = _impl.OpenSecondBrainMemoryProvider
check_health = _impl.check_health
health = _impl.health
register = _impl.register
register_cli = _impl.register_cli

__all__ = [
    "OpenSecondBrainMemoryProvider",
    "check_health",
    "health",
    "register",
    "register_cli",
]
