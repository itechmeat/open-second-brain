from __future__ import annotations

import argparse
import os
from pathlib import Path

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
    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    path = append_event(vault, args.agent, args.message, date=args.date, time=args.time)
    print(f"appended: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
