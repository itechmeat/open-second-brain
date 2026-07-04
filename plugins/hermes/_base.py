"""Soft import of the Hermes ``MemoryProvider`` ABC with a local fallback.

``agent.memory_provider.MemoryProvider`` only exists inside a Hermes install.
This repository's CI (and any non-Hermes runtime) has no such module, so the
provider must still import and be testable. We import the real ABC when it is
present and otherwise expose a minimal stand-in base with no-op optional hooks,
mirroring the defensive pattern the rest of the Hermes shim already uses.

The stand-in deliberately does not enforce the abstract surface: the concrete
provider overrides every required method, and a faithful no-op base keeps the
provider importable and unit-testable without Hermes.

The stand-in class is defined unconditionally (as ``_FallbackMemoryProviderBase``)
and exposed via ``MemoryProvider`` regardless of whether the Hermes ABC is
available: when Hermes is present, ``MemoryProvider`` aliases the real ABC; when
it is not, ``MemoryProvider`` aliases the stand-in. Tests that pin the stand-in's
no-op contract import ``_FallbackMemoryProviderBase`` directly so they hold in
both environments (CI without Hermes, and a real install with Hermes).
"""

from __future__ import annotations

from typing import Any


class _FallbackMemoryProviderBase:
    """Minimal stand-in for the Hermes ``MemoryProvider`` ABC.

    Optional lifecycle hooks default to no-ops so a subclass that does not
    override one can still be driven by a Hermes-shaped harness without
    raising. Required methods are intentionally absent here; the concrete
    provider supplies them.
    """

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "", **_kwargs: Any) -> str:
        return ""

    def queue_prefetch(self, query: str, **_kwargs: Any) -> None:
        return None

    def sync_turn(
        self,
        user: str,
        assistant: str,
        *,
        session_id: str = "",
        messages: list | None = None,
        **_kwargs: Any,
    ) -> None:
        return None

    def on_session_end(self, messages: list, **_kwargs: Any) -> None:
        return None

    def on_pre_compress(self, messages: list, **_kwargs: Any) -> None:
        return None

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        **_kwargs: Any,
    ) -> None:
        return None

    def shutdown(self) -> None:
        return None


try:  # pragma: no cover - exercised only inside a Hermes install
    from agent.memory_provider import MemoryProvider as _HermesMemoryProvider

    MemoryProvider: type = _HermesMemoryProvider
    HAS_HERMES_ABC = True
except Exception:  # noqa: BLE001 - any import failure means "not in Hermes"
    MemoryProvider = _FallbackMemoryProviderBase
    HAS_HERMES_ABC = False


__all__ = ["MemoryProvider", "_FallbackMemoryProviderBase", "HAS_HERMES_ABC"]
