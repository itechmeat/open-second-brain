from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from open_second_brain.config import resolve_timezone, resolve_vault
from open_second_brain.event_log import append_event


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vault-log", description="Append an Open Second Brain event log entry")
    parser.add_argument("message", help="Single-line event message")
    parser.add_argument("--as", dest="agent", default=os.environ.get("VAULT_AGENT_NAME", "agent"), help="Agent name")
    parser.add_argument("--vault", type=Path, default=None, help="Vault directory")
    parser.add_argument("--date", default=None, help="Event date as YYYY.MM.DD")
    parser.add_argument("--time", default=None, help="Event time as HH:MM")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # Resolution order: --vault → VAULT_DIR env → persisted plugin
    # config (`vault` field, written by `o2b init`). If none is set,
    # fail closed rather than silently fall back to the current working
    # directory — that fallback used to send write invocations into
    # ``$(pwd)/Daily/...`` instead of the user's actual vault.
    vault = args.vault or resolve_vault()
    if vault is None:
        print(
            "error: no vault configured. Pass --vault <path> explicitly, "
            "set VAULT_DIR in the environment, or run "
            "`o2b init --vault <path> ...` first to persist a default.",
            file=sys.stderr,
        )
        return 1
    tz = resolve_timezone()
    path = append_event(Path(vault), args.agent, args.message, date=args.date, time=args.time, tz=tz)
    # Always print the absolute path so the user sees immediately if
    # the entry landed in an unexpected place.
    print(f"appended: {Path(path).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
