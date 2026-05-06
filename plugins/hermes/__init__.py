"""Hermes adapter skeleton for Open Second Brain.

v0 intentionally avoids deep runtime behavior. Future versions may register
Hermes hooks for configuration checks, status reporting, and explicit event
logging integrations.
"""

from __future__ import annotations

from typing import Any


def register(ctx: Any) -> None:
    """Register the Hermes plugin.

    The v0 skeleton is intentionally a no-op. It exists so the package shape is
    visible while the CLI/config contract is designed.
    """
    return None
