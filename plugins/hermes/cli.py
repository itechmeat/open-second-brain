"""Optional ``hermes open-second-brain`` CLI subtree.

Hermes discovers ``register_cli`` by convention and only surfaces these
commands when the provider is active. They are read-only diagnostics over the
same config and provider the gateway uses - no deterministic logic here.
"""

from __future__ import annotations

import sys
from typing import Any

from . import config
from .provider import OpenSecondBrainMemoryProvider

# Exit code for a diagnostic that could not read the configuration it exists to
# report on. Distinct from 1, which means "read it fine, and it says not ready".
_EXIT_UNREADABLE_CONFIG = 2


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


def _report_unreadable(exc: config.ConfigReadError) -> int:
    """Render an unreadable configuration as the diagnostic it is.

    ``is_available`` refuses rather than answering ``False`` when the config
    cannot be read, because there is no third value in the host's badge
    contract. That refusal is correct there and useless here: these two
    commands are what an operator is asked to run when the badge is already
    wrong, so a traceback would bury the one line that names the remedy. The
    error carries its own remediation text; print that and nothing else, and
    exit on a code that separates "could not read" from "read it, not ready".
    """
    print(f"error: {exc}", file=sys.stderr)
    return _EXIT_UNREADABLE_CONFIG


def _status() -> int:
    provider = OpenSecondBrainMemoryProvider()
    try:
        available = provider.is_available()
        vault = config.resolve_vault()
    except config.ConfigReadError as exc:
        print(f"provider:  {provider.name}")
        print(f"available: (unreadable configuration)")
        return _report_unreadable(exc)
    print(f"provider:  {provider.name}")
    print(f"available: {available}")
    print(f"vault:     {vault or '(unset)'}")
    return 0 if available else 1


def _config() -> int:
    # The config path is resolved from the environment alone and is printable
    # even when the file behind it is not, which is exactly the case an
    # operator needs to see: the path this process looked at.
    print(f"config_path: {config.config_path()}")
    try:
        vault = config.resolve_vault()
        agent_name = config.resolve_agent_name()
        timezone = config.resolve_timezone()
    except config.ConfigReadError as exc:
        return _report_unreadable(exc)
    print(f"vault:       {vault or '(unset)'}")
    print(f"agent_name:  {agent_name}")
    print(f"timezone:    {timezone or '(unset)'}")
    return 0
