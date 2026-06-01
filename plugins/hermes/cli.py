"""Optional ``hermes open-second-brain`` CLI subtree.

Hermes discovers ``register_cli`` by convention and only surfaces these
commands when the provider is active. They are read-only diagnostics over the
same config and provider the gateway uses - no deterministic logic here.
"""

from __future__ import annotations

from typing import Any

from . import config
from .provider import OpenSecondBrainMemoryProvider


def register_cli(subparser: Any) -> None:
    """Build the ``status`` / ``config`` argparse subtree."""
    subs = subparser.add_subparsers(dest="osb_command")
    subs.add_parser("status", help="Show the Open Second Brain memory provider status.")
    subs.add_parser("config", help="Show the effective Open Second Brain configuration.")
    subparser.set_defaults(func=run)


def run(args: Any) -> int:
    """Dispatch the selected subcommand. Returns a process exit code."""
    command = getattr(args, "osb_command", None)
    if command == "status":
        return _status()
    if command == "config":
        return _config()
    print("usage: hermes open-second-brain {status,config}")
    return 0


def _status() -> int:
    provider = OpenSecondBrainMemoryProvider()
    available = provider.is_available()
    print(f"provider:  {provider.name}")
    print(f"available: {available}")
    print(f"vault:     {config.resolve_vault() or '(unset)'}")
    return 0 if available else 1


def _config() -> int:
    print(f"config_path: {config.config_path()}")
    print(f"vault:       {config.resolve_vault() or '(unset)'}")
    print(f"agent_name:  {config.resolve_agent_name()}")
    print(f"timezone:    {config.resolve_timezone() or '(unset)'}")
    return 0
