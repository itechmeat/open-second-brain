"""Hermes plugin entrypoint for Open Second Brain.

Hermes installs Git plugins by cloning the repository and treating the
repository root as the plugin directory, so this file is the entry the gateway
loads first. The ``OpenSecondBrainMemoryProvider`` implementation and its
``register``/health surface live in ``plugins/hermes``; this module re-exports
them through an ordinary relative import.

The relative import is the whole integration. Hermes' external memory-provider
loader imports a user-installed plugin as ``_hermes_user_memory.<name>`` and
registers that synthetic parent namespace in ``sys.modules`` before executing
the plugin (hermes-agent PR #37366), so a provider written with plain relative
imports - including an implementation nested behind the ``plugins/`` namespace
directory - resolves without any loader workaround on the plugin side. The
``OpenSecondBrainMemoryProvider`` name appearing in this file also keeps
Hermes' text-scan discovery heuristic recognising it as a memory provider.
"""

from __future__ import annotations

from .plugins.hermes import (
    OpenSecondBrainMemoryProvider,
    check_health,
    health,
    register,
    register_cli,
)

__all__ = [
    "OpenSecondBrainMemoryProvider",
    "check_health",
    "health",
    "register",
    "register_cli",
]
