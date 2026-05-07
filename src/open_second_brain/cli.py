from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import json as _json

from open_second_brain.config import default_config_path, discover_config, redact_mapping
from open_second_brain.doctor import doctor
from open_second_brain.event_log import append_event
from open_second_brain.init import bootstrap_vault
from open_second_brain.mcp import MCPServer, run_cli_command as run_mcp_server
from open_second_brain.uninstall import plan_uninstall, render_plan
from open_second_brain.vault import list_vault_pages, write_frontmatter


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="o2b", description="Open Second Brain CLI")
    subcommands = parser.add_subparsers(dest="command", required=True)

    status = subcommands.add_parser("status", help="Show Open Second Brain configuration status")
    status.add_argument("--config", type=Path, default=None, help="Config file path")
    status.add_argument("--vault", type=Path, default=None, help="Vault directory path")
    status.add_argument("--json", action="store_true", help="Output as JSON")

    init_cmd = subcommands.add_parser("init", help="Initialize a vault profile with required files")
    init_cmd.add_argument("--vault", type=Path, required=True, help="Vault directory path")
    init_cmd.add_argument("--name", default="Second Brain", help="Instance name (default: Second Brain)")
    init_cmd.add_argument("--force", action="store_true", help="Overwrite existing files")

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

    index_cmd = subcommands.add_parser("index", help="Regenerate the vault index from discovered pages")
    index_cmd.add_argument("--vault", type=Path, default=None, help="Vault directory path")

    mcp_cmd = subcommands.add_parser(
        "mcp",
        help="Run the optional MCP tool server (stdio JSON-RPC)",
        description=(
            "Start an MCP server over stdio that exposes Second Brain tools. "
            "Pair with Hermes ~/.hermes/config.yaml mcp_servers."
        ),
    )
    mcp_cmd.add_argument("--vault", type=Path, default=None, help="Vault directory path")
    mcp_cmd.add_argument("--config", type=Path, default=None, help="Config file path")
    mcp_cmd.add_argument("--repo", type=Path, default=None, help="Repository root for plugin checks")

    uninstall_cmd = subcommands.add_parser(
        "uninstall",
        help="Print an uninstall plan and (optionally) clean local config",
        description=(
            "Read-only by default. Prints the Hermes commands you must run yourself "
            "(this tool never touches ~/.hermes/config.yaml or the installed plugin). "
            "With --apply-local it may remove the machine-local Open Second Brain "
            "config directory only. Your vault, Daily/, AI Wiki/, and Markdown notes "
            "are never removed."
        ),
    )
    uninstall_cmd.add_argument("--config", type=Path, default=None, help="Config file path")
    uninstall_cmd.add_argument(
        "--apply-local",
        action="store_true",
        help=(
            "Remove the machine-local Open Second Brain config directory "
            "(typically ~/.config/open-second-brain). Hermes config and the vault "
            "are never touched."
        ),
    )

    tool_call_cmd = subcommands.add_parser(
        "tool-call",
        help="Invoke an MCP tool handler from the CLI and print JSON to stdout.",
    )
    tool_call_cmd.add_argument("--vault", type=Path, default=None, help="Vault directory path")
    tool_call_cmd.add_argument("tool_name", help="MCP tool name to invoke")
    tool_call_cmd.add_argument(
        "--tool-arg",
        action="append",
        default=[],
        dest="tool_args",
        help="Tool argument as key=value (repeatable)",
    )

    return parser


def command_status(args: argparse.Namespace) -> int:
    result = discover_config(args.config)
    if getattr(args, "json", False):
        output = {
            "config_path": str(result.path),
            "config_exists": result.exists,
        }
        if result.data:
            output["config_keys"] = sorted(result.data.keys())
        vault = getattr(args, "vault", None)
        if vault:
            output["vault"] = str(vault)
        print(json.dumps(output, indent=2, sort_keys=True))
    else:
        print(f"config_path: {result.path}")
        print(f"config_exists: {str(result.exists).lower()}")
        if result.data:
            print("config_keys:")
            for key in sorted(result.data):
                print(f"- {key}")
    return 0


def command_init(args: argparse.Namespace) -> int:
    vault = args.vault
    try:
        created = bootstrap_vault(vault, name=args.name, force=args.force)
    except OSError as exc:
        print(f"error: failed to initialize vault: {exc}", file=sys.stderr)
        return 1
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
    config = args.config or default_config_path()
    repo_root: Path | None = args.repo

    try:
        results = doctor(vault=vault, config=config, repo_root=repo_root)
    except OSError as exc:
        print(f"error: doctor failed: {exc}", file=sys.stderr)
        return 1
    all_ok = True
    for r in results:
        status = "OK" if r.ok else "FAIL"
        print(f"[{status}] {r.name}: {r.message}")
        if not r.ok:
            all_ok = False
    return 0 if all_ok else 1


def command_append_event(args: argparse.Namespace) -> int:
    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    try:
        path = append_event(vault, args.agent, args.message, date=args.date, time=args.time)
    except OSError as exc:
        print(f"error: failed to append event: {exc}", file=sys.stderr)
        return 1
    print(f"appended: {path}")
    return 0


def command_export_config(args: argparse.Namespace) -> int:
    result = discover_config(args.config)
    snapshot = {
        "config_path": str(result.path),
        "config_exists": result.exists,
        "config": redact_mapping(result.data),
    }
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"error: failed to export config: {exc}", file=sys.stderr)
        return 1
    print(f"exported: {args.output}")
    return 0


def command_index(args: argparse.Namespace) -> int:
    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    try:
        pages = list_vault_pages(vault)
    except OSError as exc:
        print(f"error: failed to list vault pages: {exc}", file=sys.stderr)
        return 1

    if not pages:
        print(f"no markdown pages found in vault: {vault}")
        return 0

    lines: list[str] = [
        f"# Vault Index",
        "",
        f"Auto-generated index of {len(pages)} pages.",
        "",
    ]
    for title, path, _ in pages:
        rel = path.relative_to(vault)
        lines.append(f"- [[{title}]]  `{rel}`")

    index_path = vault / "AI Wiki" / "index.md"
    try:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        write_frontmatter(index_path, {"title": "Index", "type": "index"}, "\n".join(lines))
    except OSError as exc:
        print(f"error: failed to write index: {exc}", file=sys.stderr)
        return 1

    print(f"index regenerated: {index_path} ({len(pages)} pages)")
    return 0


def command_mcp(args: argparse.Namespace) -> int:
    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    config = args.config or default_config_path()
    repo_root: Path | None = args.repo
    try:
        return run_mcp_server(vault=vault, config_path=config, repo_root=repo_root)
    except KeyboardInterrupt:
        return 0


def command_uninstall(args: argparse.Namespace) -> int:
    config = args.config or default_config_path()
    plan = plan_uninstall(config_path=config, apply_local=args.apply_local)
    sys.stdout.write(render_plan(plan))
    if plan.errors:
        return 1
    return 0


def command_tool_call(args: argparse.Namespace) -> int:
    """Bridge: invoke an MCP tool handler from the CLI and print JSON to stdout."""
    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    config = default_config_path()
    repo_root: Path | None = None

    server = MCPServer(vault=vault, config_path=config, repo_root=repo_root)

    tool_name = args.tool_name
    if tool_name not in server._tools:
        print(f"error: unknown tool: {tool_name}", file=sys.stderr)
        return 1

    # Parse --tool-arg key=value pairs into a dict
    arguments: dict[str, object] = {}
    for pair in args.tool_args:
        if "=" not in pair:
            print(f"error: --tool-arg must be key=value, got: {pair}", file=sys.stderr)
            return 1
        key, value = pair.split("=", 1)
        # Attempt JSON decode for non-string types (arrays, numbers, booleans)
        try:
            arguments[key] = _json.loads(value)
        except (_json.JSONDecodeError, ValueError):
            arguments[key] = value

    result = server._handle_tools_call({"name": tool_name, "arguments": arguments})
    print(_json.dumps(result, ensure_ascii=False, indent=2))
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
    if args.command == "index":
        return command_index(args)
    if args.command == "mcp":
        return command_mcp(args)
    if args.command == "uninstall":
        return command_uninstall(args)
    if args.command == "tool-call":
        return command_tool_call(args)
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
