"""Hermes plugin entrypoint for OpenSecondBrain.

Hermes installs Git plugins by cloning the repository and loading the repository
root as the plugin directory. The implementation lives in ``plugins/hermes`` so
it can also be used directly by runtimes that expect an adapter subdirectory.
"""

from __future__ import annotations

from .plugins.hermes import check_health, health, register

__all__ = ["check_health", "health", "register"]
