"""Bridge from the Python memory provider to the Open Second Brain TS core.

The provider never reimplements deterministic memory logic; it forwards work
to the existing ``o2b mcp`` stdio server over MCP JSON-RPC. ``BrainBridge`` is
the seam: ``McpBrainBridge`` is the production backend that owns a long-lived
``o2b mcp`` subprocess, and ``FakeBrainBridge`` lets tests exercise the
provider with no live Bun runtime.

Splitting ``JsonRpcStdioClient`` (pure framing) from ``McpBrainBridge`` (process
lifecycle) keeps each class single-responsibility and lets the framing be
unit-tested against in-memory streams.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any, Protocol, runtime_checkable

PROTOCOL_VERSION = "2025-06-18"
CLIENT_NAME = "open-second-brain-hermes-provider"


class BridgeError(RuntimeError):
    """Base error: a JSON-RPC error response or a transport failure."""


class BridgeTransportError(BridgeError):
    """The channel itself failed (EOF, broken pipe). Worth one restart.

    Distinct from a plain ``BridgeError``, which signals a JSON-RPC error
    response (e.g. invalid tool arguments) - a server-level rejection that a
    restart would only repeat, so it must propagate unchanged.
    """


@runtime_checkable
class BrainBridge(Protocol):
    """Minimal contract the provider depends on (Dependency Inversion)."""

    def start(self) -> None: ...

    def list_tools(self) -> list[dict[str, Any]]: ...

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]: ...

    def stop(self) -> None: ...


class JsonRpcStdioClient:
    """Newline-delimited JSON-RPC 2.0 client over a writer/reader pair.

    ``writer`` needs ``write`` (and optionally ``flush``); ``reader`` needs
    ``readline`` returning ``str`` (``""`` at EOF). Responses are correlated by
    id; notifications and stale ids are skipped.
    """

    def __init__(self, writer: Any, reader: Any) -> None:
        self._writer = writer
        self._reader = reader
        self._id = 0

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        frame: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            frame["params"] = params
        self._write(frame)

    def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._id += 1
        rid = self._id
        frame: dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            frame["params"] = params
        self._write(frame)
        return self._read_response(rid)

    def _write(self, frame: dict[str, Any]) -> None:
        try:
            self._writer.write(json.dumps(frame) + "\n")
            flush = getattr(self._writer, "flush", None)
            if callable(flush):
                flush()
        except (BrokenPipeError, ValueError, OSError) as exc:
            raise BridgeTransportError(f"write failed: {exc}") from exc

    def _read_response(self, rid: int) -> Any:
        while True:
            line = self._reader.readline()
            if line == "":
                raise BridgeTransportError("unexpected EOF from MCP server")
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                # stdout carries only JSON-RPC frames; ignore stray noise.
                continue
            if not isinstance(message, dict) or message.get("id") != rid:
                continue
            if "error" in message:
                raise BridgeError(str(message["error"]))
            return message.get("result")


class McpBrainBridge:
    """Owns one ``o2b mcp`` subprocess and speaks MCP JSON-RPC to it.

    ``spawn`` is injectable so tests substitute a fake process and never need a
    live Bun runtime. A crashed channel is restarted once on the next call.
    """

    def __init__(
        self,
        *,
        vault: str | None,
        command: tuple[str, ...] = ("o2b", "mcp"),
        spawn: Any = None,
        cwd: str | None = None,
    ) -> None:
        self._vault = vault
        self._command = command
        self._spawn = spawn or self._default_spawn
        self._cwd = cwd
        self._proc: Any = None
        self._client: JsonRpcStdioClient | None = None
        self._tools: list[dict[str, Any]] = []
        self._started = False

    def _argv(self) -> list[str]:
        argv = list(self._command)
        if self._vault:
            argv += ["--vault", self._vault]
        return argv

    def _default_spawn(self, argv: list[str]) -> Any:
        return subprocess.Popen(  # noqa: S603 - argv is a fixed command + config path
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            cwd=self._cwd,
        )

    def start(self) -> None:
        if self._started:
            return
        self._proc = self._spawn(self._argv())
        self._client = JsonRpcStdioClient(self._proc.stdin, self._proc.stdout)
        self._client.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": "1"},
            },
        )
        self._client.notify("notifications/initialized")
        result = self._client.request("tools/list", {})
        self._tools = list((result or {}).get("tools", []))
        self._started = True

    def list_tools(self) -> list[dict[str, Any]]:
        self._ensure_started()
        return self._tools

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self._ensure_started()
        assert self._client is not None
        try:
            result = self._client.request("tools/call", {"name": name, "arguments": args})
        except BridgeTransportError:
            # The channel died: restart once and retry. A JSON-RPC error
            # (plain BridgeError, e.g. invalid arguments) is a server-level
            # rejection and propagates unchanged - restarting would only repeat it.
            self._restart()
            assert self._client is not None
            result = self._client.request("tools/call", {"name": name, "arguments": args})
        return result or {}

    def stop(self) -> None:
        proc = self._proc
        self._started = False
        self._client = None
        self._proc = None
        if proc is None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001 - never raise on shutdown
            kill = getattr(proc, "kill", None)
            if callable(kill):
                kill()

    def _ensure_started(self) -> None:
        if not self._started:
            self.start()

    def _restart(self) -> None:
        self.stop()
        self.start()


class FakeBrainBridge:
    """In-memory ``BrainBridge`` for tests: records calls, returns canned data."""

    def __init__(
        self,
        tools: list[dict[str, Any]] | None = None,
        results: dict[str, Any] | None = None,
    ) -> None:
        self._tools = tools or []
        self._results = results or {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def list_tools(self) -> list[dict[str, Any]]:
        return list(self._tools)

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((name, args))
        result = self._results.get(name)
        if callable(result):
            return result(args)
        return result if result is not None else {}

    def stop(self) -> None:
        self.stopped = True


__all__ = [
    "BridgeError",
    "BridgeTransportError",
    "BrainBridge",
    "JsonRpcStdioClient",
    "McpBrainBridge",
    "FakeBrainBridge",
    "PROTOCOL_VERSION",
]
