from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from open_second_brain.config import discover_config, redact_mapping
from open_second_brain.event_log import append_event


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="asb", description="Open Second Brain CLI")
    subcommands = parser.add_subparsers(dest="command", required=True)

    status = subcommands.add_parser("status", help="Show Open Second Brain configuration status")
    status.add_argument("--config", type=Path, default=None, help="Config file path")

    append = subcommands.add_parser("append-event", help="Append an event to the configured event log backend")
    append.add_argument("message", help="Single-line event message")
    append.add_argument("--vault", type=Path, default=None, help="Vault directory")
    append.add_argument("--as", dest="agent", default=os.environ.get("VAULT_AGENT_NAME", "agent"), help="Agent name")
    append.add_argument("--date", default=None, help="Event date as YYYY.MM.DD")
    append.add_argument("--time", default=None, help="Event time as HH:MM")

    export = subcommands.add_parser("export-config", help="Write a redacted config snapshot")
    export.add_argument("--config", type=Path, default=None, help="Config file path")
    export.add_argument("--output", type=Path, required=True, help="Output JSON file")

    return parser


def command_status(args: argparse.Namespace) -> int:
    result = discover_config(args.config)
    print(f"config_path: {result.path}")
    print(f"config_exists: {str(result.exists).lower()}")
    if result.data:
        print("config_keys:")
        for key in sorted(result.data):
            print(f"- {key}")
    return 0


def command_append_event(args: argparse.Namespace) -> int:
    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    path = append_event(vault, args.agent, args.message, date=args.date, time=args.time)
    print(f"appended: {path}")
    return 0


def command_export_config(args: argparse.Namespace) -> int:
    result = discover_config(args.config)
    snapshot = {
        "config_path": str(result.path),
        "config_exists": result.exists,
        "config": redact_mapping(result.data),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"exported: {args.output}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "status":
        return command_status(args)
    if args.command == "append-event":
        return command_append_event(args)
    if args.command == "export-config":
        return command_export_config(args)
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
