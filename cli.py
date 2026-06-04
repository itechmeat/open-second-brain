"""Hermes CLI discovery shim.

Hermes' ``discover_plugin_cli_commands()`` performs a lightweight scan: it
imports ``<plugin_root>/cli.py`` as ``_hermes_user_memory.<name>.cli`` with
the synthetic parent packages pre-registered (hermes-agent PR #37366) and
WITHOUT executing the plugin's root ``__init__.py``. The implementation lives
in ``plugins/hermes/cli.py``; this shim re-exports it through the relative
path the registered parent shell resolves, so the documented
``hermes open-second-brain`` CLI subtree is discoverable before the provider
itself is loaded. The import stays SDK-free: ``plugins/hermes`` soft-imports
the Hermes ABC with a local fallback.
"""

from __future__ import annotations

from .plugins.hermes.cli import register_cli, run

__all__ = ["register_cli", "run"]
