from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from open_second_brain.config import discover_config, redact_mapping
from open_second_brain.doctor import doctor
from open_second_brain.event_log import append_event
from open_second_brain.init import bootstrap_vault


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="o2b", description="Open Second Brain CLI")
    subcommands = parser.add_subparsers(dest="command", required=True)

    status = subcommands.add_parser("status", help="Show Open Second Brain configuration status")
    status.add_argument("--config", type=Path, default=None, help="Config file path")

    init = subcommands.add_parser("init", help="Initialize a vault profile with required files")
    init.add_argument("--vault", type=Path, required=True, help="Vault directory path")
    init.add_argument("--name", default="Second Brain", help="Instance name (default: Second Brain)")
    init.add_argument("--force", action="store_true", help="Overwrite existing files")

    doctor_cmd = subcommands.add_parser("doctor", help="Run health checks on vault, config, and plugins")
    doctor_cmd.add_argument("--vault", type=Path, default=None, help="Vault directory path")
    doctor_cmd.add_argument("--config", type=Path, default=None, help="Config file path")
    doctor_cmd.add_argument("--repo", type=Path, default=None, help="Repository root for plugin checks")

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


def command_init(args: argparse.Namespace) -> int:
    vault = args.vault
    created = bootstrap_vault(vault, name=args.name, force=args.force)
    if not created:
        print(f"vault already initialized: {vault}")
        print("use --force to overwrite existing files")
        return 0
    print(f"initialized vault: {vault}")
    for path in created:
        print(f"  created: {path}")
    return 0


def command_doctor(args: argparse.Namespace) -> int:
    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    config: Path | None = args.config
    repo_root: Path | None = args.repo

    results = doctor(vault=vault, config=config, repo_root=repo_root)
    all_ok = True
    for r in results:
        status = "OK" if r.ok else "FAIL"
        print(f"[{status}] {r.name}: {r.message}")
        if not r.ok:
            all_ok = False
    return 0 if all_ok else 1


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
    if args.command == "init":
        return command_init(args)
    if args.command == "doctor":
        return command_doctor(args)
    if args.command == "append-event":
        return command_append_event(args)
    if args.command == "export-config":
        return command_export_config(args)
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
