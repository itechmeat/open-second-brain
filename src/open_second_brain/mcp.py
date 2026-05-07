"""Optional Model Context Protocol (MCP) server for Open Second Brain.

This module implements a stdio JSON-RPC 2.0 server that exposes deterministic
Second Brain operations as MCP tools. It is dependency-free and uses the
``2025-06-18`` MCP protocol version, which the current Hermes Agent runtime
discovers and registers like any other ``mcp_servers`` entry in
``~/.hermes/config.yaml`` (see ``docs/mcp.md``).

The CLI is the baseline: every tool here delegates to the same core helpers
(``config``, ``doctor``, ``event_log``, ``vault``) used by the ``o2b`` command,
so behavior stays consistent across runtimes.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, IO

from open_second_brain.config import default_config_path, discover_config, redact_mapping
from open_second_brain.doctor import doctor
from open_second_brain.event_log import append_event, validate_event_time
from open_second_brain.vault import list_vault_pages, parse_frontmatter, write_frontmatter

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "open-second-brain"
SERVER_VERSION = "0.5.2"
JSONRPC_VERSION = "2.0"

# JSON-RPC 2.0 error codes used by the MCP server.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

_SLUG_INVALID = re.compile(r"[^a-z0-9]+")
_SLUG_MAX_LEN = 64


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[["MCPServer", dict[str, Any]], dict[str, Any]]

    def to_listing(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


def slugify(value: str) -> str:
    lowered = value.strip().lower()
    slug = _SLUG_INVALID.sub("-", lowered).strip("-")
    if not slug:
        slug = "note"
    return slug[:_SLUG_MAX_LEN].rstrip("-") or "note"


def _vault_relpath(target: Path, vault: Path) -> str:
    try:
        return str(target.resolve().relative_to(vault.resolve()))
    except ValueError:
        return str(target)


def _ensure_inside_vault(target: Path, vault: Path) -> Path:
    resolved_target = target.resolve()
    resolved_vault = vault.resolve()
    try:
        resolved_target.relative_to(resolved_vault)
    except ValueError as exc:
        raise ValueError(f"path escapes vault: {target}") from exc
    return resolved_target


class MCPError(Exception):
    """Protocol-level error returned as a JSON-RPC error response."""

    def __init__(self, code: int, message: str, data: Any | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class MCPServer:
    """JSON-RPC 2.0 MCP server exposing Second Brain operations as tools."""

    def __init__(
        self,
        *,
        vault: Path,
        config_path: Path | None = None,
        repo_root: Path | None = None,
    ) -> None:
        self.vault = vault
        self.config_path = config_path
        self.repo_root = repo_root
        self._initialized = False
        self._tools: dict[str, ToolDefinition] = {tool.name: tool for tool in _build_tool_table()}

    # ── JSON-RPC dispatch ────────────────────────────────────────────────

    def handle_request(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """Process one JSON-RPC request or notification.

        Returns a JSON-RPC response dict, or ``None`` for notifications.
        """

        if not isinstance(request, dict):
            return self._error_response(None, INVALID_REQUEST, "request must be an object")
        if request.get("jsonrpc") != JSONRPC_VERSION:
            return self._error_response(request.get("id"), INVALID_REQUEST, "unsupported jsonrpc version")

        method = request.get("method")
        if not isinstance(method, str):
            return self._error_response(request.get("id"), INVALID_REQUEST, "method must be a string")

        params = request.get("params") or {}
        request_id = request.get("id")
        is_notification = "id" not in request

        try:
            if method == "initialize":
                result = self._handle_initialize(params)
            elif method == "notifications/initialized":
                self._initialized = True
                return None
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = self._handle_tools_list()
            elif method == "tools/call":
                result = self._handle_tools_call(params)
            elif method.startswith("notifications/"):
                return None
            else:
                raise MCPError(METHOD_NOT_FOUND, f"unknown method: {method}")
        except MCPError as exc:
            if is_notification:
                return None
            return self._error_response(request_id, exc.code, exc.message, exc.data)
        except Exception as exc:  # noqa: BLE001 — last-resort safety net for stdio loop
            if is_notification:
                return None
            return self._error_response(request_id, INTERNAL_ERROR, f"internal error: {exc}")

        if is_notification:
            return None
        return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": result}

    # ── Method handlers ──────────────────────────────────────────────────

    def _handle_initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        client_version = params.get("protocolVersion")
        negotiated = client_version if isinstance(client_version, str) else PROTOCOL_VERSION
        return {
            "protocolVersion": negotiated,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": (
                "Open Second Brain MCP server. Tools are deterministic wrappers around the o2b CLI. "
                "Use second_brain_status before writes, vault_health to verify the vault, "
                "second_brain_query to look up notes, second_brain_capture to add wiki pages, "
                "and event_log_append for daily operational events."
            ),
        }

    def _handle_tools_list(self) -> dict[str, Any]:
        return {"tools": [tool.to_listing() for tool in self._tools.values()]}

    def _handle_tools_call(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str):
            raise MCPError(INVALID_PARAMS, "tools/call requires a string name")
        tool = self._tools.get(name)
        if tool is None:
            raise MCPError(METHOD_NOT_FOUND, f"unknown tool: {name}")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise MCPError(INVALID_PARAMS, "tools/call arguments must be an object")
        try:
            structured = tool.handler(self, arguments)
        except MCPError:
            raise
        except (ValueError, TypeError) as exc:
            return _tool_error(str(exc))
        except OSError as exc:
            return _tool_error(f"filesystem error: {exc}")
        return _tool_result(structured)

    # ── Helpers ──────────────────────────────────────────────────────────

    def _error_response(
        self,
        request_id: Any,
        code: int,
        message: str,
        data: Any | None = None,
    ) -> dict[str, Any]:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "error": error}


# ── Tool implementations ─────────────────────────────────────────────────


def _tool_result(structured: dict[str, Any]) -> dict[str, Any]:
    text = json.dumps(structured, ensure_ascii=False, sort_keys=True, indent=2)
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": structured,
        "isError": False,
    }


def _tool_error(message: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    }


def _coerce_str(arguments: dict[str, Any], key: str, *, required: bool = True, default: str | None = None) -> str | None:
    value = arguments.get(key)
    if value is None:
        if required:
            raise MCPError(INVALID_PARAMS, f"missing required argument: {key}")
        return default
    if not isinstance(value, str):
        raise MCPError(INVALID_PARAMS, f"argument {key!r} must be a string")
    return value


def _coerce_str_list(arguments: dict[str, Any], key: str) -> list[str]:
    value = arguments.get(key)
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise MCPError(INVALID_PARAMS, f"argument {key!r} must be a list of strings")
    return value


def _coerce_int(arguments: dict[str, Any], key: str, *, default: int, minimum: int, maximum: int) -> int:
    value = arguments.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise MCPError(INVALID_PARAMS, f"argument {key!r} must be an integer")
    if value < minimum or value > maximum:
        raise MCPError(INVALID_PARAMS, f"argument {key!r} must be between {minimum} and {maximum}")
    return value


def _tool_second_brain_status(server: MCPServer, _arguments: dict[str, Any]) -> dict[str, Any]:
    discovery = discover_config(server.config_path)
    vault_exists = server.vault.is_dir()
    config_keys = sorted(discovery.data.keys())
    return {
        "config_path": str(discovery.path),
        "config_exists": discovery.exists,
        "config_keys": config_keys,
        "config": redact_mapping(discovery.data),
        "vault_path": str(server.vault),
        "vault_exists": vault_exists,
    }


def _tool_second_brain_query(server: MCPServer, arguments: dict[str, Any]) -> dict[str, Any]:
    if not server.vault.is_dir():
        raise MCPError(INVALID_PARAMS, f"vault directory missing: {server.vault}")

    pattern = _coerce_str(arguments, "pattern", required=False)
    limit = _coerce_int(arguments, "limit", default=50, minimum=1, maximum=500)

    pages = list_vault_pages(server.vault)
    needle = pattern.lower() if pattern else None
    matched: list[dict[str, Any]] = []
    for title, path, meta in pages:
        if needle is not None and needle not in title.lower():
            continue
        matched.append(
            {
                "title": title,
                "path": _vault_relpath(path, server.vault),
                "metadata": meta,
            }
        )
        if len(matched) >= limit:
            break

    return {
        "vault_path": str(server.vault),
        "total_pages": len(pages),
        "returned": len(matched),
        "limit": limit,
        "pattern": pattern,
        "pages": matched,
    }


def _tool_second_brain_capture(server: MCPServer, arguments: dict[str, Any]) -> dict[str, Any]:
    if not server.vault.is_dir():
        raise MCPError(INVALID_PARAMS, f"vault directory missing: {server.vault}")

    title = _coerce_str(arguments, "title")
    content = _coerce_str(arguments, "content")
    tags = _coerce_str_list(arguments, "tags")
    overwrite = bool(arguments.get("overwrite", False))
    assert title is not None  # required=True
    assert content is not None  # required=True

    if not title.strip():
        raise MCPError(INVALID_PARAMS, "title must not be empty")
    if not content.strip():
        raise MCPError(INVALID_PARAMS, "content must not be empty")

    notes_dir = server.vault / "AI Wiki" / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)

    slug = slugify(title)
    target = notes_dir / f"{slug}.md"
    _ensure_inside_vault(target, server.vault)

    note_existed = target.exists()
    if note_existed and not overwrite:
        raise ValueError(f"note already exists: {_vault_relpath(target, server.vault)}")

    metadata: dict[str, Any] = {
        "title": title,
        "type": "note",
        "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if tags:
        metadata["tags"] = list(tags)

    write_frontmatter(target, metadata, content.strip())

    return {
        "path": _vault_relpath(target, server.vault),
        "absolute_path": str(target.resolve()),
        "slug": slug,
        "overwritten": note_existed and overwrite,
    }


def _tool_event_log_append(server: MCPServer, arguments: dict[str, Any]) -> dict[str, Any]:
    message = _coerce_str(arguments, "message")
    agent = _coerce_str(
        arguments,
        "agent",
        required=False,
        default=os.environ.get("VAULT_AGENT_NAME", "agent"),
    )
    date = _coerce_str(arguments, "date", required=False)
    time = _coerce_str(arguments, "time", required=False)
    assert message is not None  # required=True

    if time is not None:
        validate_event_time(time)

    effective_agent = agent or "agent"
    path = append_event(server.vault, effective_agent, message, date=date, time=time)

    return {
        "path": _vault_relpath(path, server.vault),
        "absolute_path": str(path.resolve()),
        "agent": effective_agent,
        "date": date,
        "time": time,
    }


def _tool_vault_health(server: MCPServer, arguments: dict[str, Any]) -> dict[str, Any]:
    repo_arg = _coerce_str(arguments, "repo", required=False)
    if repo_arg:
        repo_root: Path | None = Path(repo_arg)
    else:
        repo_root = server.repo_root

    results = doctor(vault=server.vault, config=server.config_path, repo_root=repo_root)
    payload = [{"name": r.name, "ok": r.ok, "message": r.message} for r in results]
    return {
        "vault_path": str(server.vault),
        "config_path": str(server.config_path) if server.config_path else None,
        "repo_root": str(repo_root) if repo_root else None,
        "ok": all(item["ok"] for item in payload),
        "checks": payload,
    }


def _build_tool_table() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="second_brain_status",
            description="Report Open Second Brain configuration and vault status.",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            handler=_tool_second_brain_status,
        ),
        ToolDefinition(
            name="second_brain_query",
            description="List vault pages with optional title substring filter.",
            input_schema={
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Optional case-insensitive substring matched against page titles.",
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "description": "Maximum number of matched pages to return (default 50).",
                    },
                },
                "additionalProperties": False,
            },
            handler=_tool_second_brain_query,
        ),
        ToolDefinition(
            name="second_brain_capture",
            description="Write a new Markdown note to AI Wiki/notes/ with frontmatter.",
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Human-readable note title."},
                    "content": {"type": "string", "description": "Markdown body of the note."},
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of tag strings.",
                    },
                    "overwrite": {
                        "type": "boolean",
                        "description": "Allow overwriting an existing note with the same slug.",
                    },
                },
                "required": ["title", "content"],
                "additionalProperties": False,
            },
            handler=_tool_second_brain_capture,
        ),
        ToolDefinition(
            name="event_log_append",
            description="Append a single-line event to the daily Markdown event log.",
            input_schema={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Single-line event message."},
                    "agent": {"type": "string", "description": "Agent name (default 'agent')."},
                    "date": {
                        "type": "string",
                        "description": "Optional event date in YYYY.MM.DD format.",
                    },
                    "time": {
                        "type": "string",
                        "description": "Optional event time in 24-hour HH:MM format.",
                    },
                },
                "required": ["message"],
                "additionalProperties": False,
            },
            handler=_tool_event_log_append,
        ),
        ToolDefinition(
            name="vault_health",
            description="Run vault, config, and plugin manifest health checks.",
            input_schema={
                "type": "object",
                "properties": {
                    "repo": {
                        "type": "string",
                        "description": "Optional repository root to validate plugin manifests.",
                    },
                },
                "additionalProperties": False,
            },
            handler=_tool_vault_health,
        ),
    ]


# ── stdio loop ───────────────────────────────────────────────────────────


def serve_stdio(
    server: MCPServer,
    *,
    stdin: IO[str] | None = None,
    stdout: IO[str] | None = None,
    stderr: IO[str] | None = None,
) -> int:
    """Run the MCP server reading newline-delimited JSON from stdin.

    The server only writes JSON-RPC frames to ``stdout``. Logs go to ``stderr``.
    Returns 0 on normal EOF.
    """

    inp = stdin or sys.stdin
    out = stdout or sys.stdout
    err = stderr or sys.stderr

    for raw_line in inp:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            response = server._error_response(  # noqa: SLF001 — controlled internal use
                None, PARSE_ERROR, f"invalid JSON: {exc}"
            )
            _write_frame(out, response)
            continue

        if isinstance(request, list):
            response = server._error_response(  # noqa: SLF001 — controlled internal use
                None,
                INVALID_REQUEST,
                "batch requests are not supported by the 2025-06-18 spec",
            )
            _write_frame(out, response)
            continue

        response = server.handle_request(request)
        if response is not None:
            _write_frame(out, response)
    return 0


def _write_frame(out: IO[str], response: dict[str, Any]) -> None:
    line = json.dumps(response, ensure_ascii=False)
    if "\n" in line:
        line = line.replace("\n", " ")
    out.write(line + "\n")
    out.flush()


def run_cli_command(
    *,
    vault: Path,
    config_path: Path | None,
    repo_root: Path | None,
) -> int:
    server = MCPServer(vault=vault, config_path=config_path, repo_root=repo_root)
    sys.stderr.write(
        f"[mcp] open-second-brain {SERVER_VERSION} listening on stdio (vault={vault})\n"
    )
    sys.stderr.flush()
    return serve_stdio(server)


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> int:
    """Entry point for ``python -m open_second_brain.mcp``."""

    import argparse

    parser = argparse.ArgumentParser(
        prog="open-second-brain-mcp",
        description="Open Second Brain MCP server (stdio).",
    )
    parser.add_argument("--vault", type=Path, default=None, help="Vault directory")
    parser.add_argument("--config", type=Path, default=None, help="Config file path")
    parser.add_argument("--repo", type=Path, default=None, help="Repository root for plugin checks")
    args = parser.parse_args(argv)

    vault = args.vault or Path(os.environ.get("VAULT_DIR", "."))
    config = args.config or default_config_path()
    repo_root = args.repo
    return run_cli_command(vault=vault, config_path=config, repo_root=repo_root)


if __name__ == "__main__":
    raise SystemExit(main())
