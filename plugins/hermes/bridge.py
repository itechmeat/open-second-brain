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
import logging
import os
import subprocess
import sys
import threading
import time
from typing import Any, Protocol, runtime_checkable

PROTOCOL_VERSION = "2025-06-18"
CLIENT_NAME = "open-second-brain-hermes-provider"
logger = logging.getLogger(__name__)


# A shared bridge is one stdio stream, so its calls are serialised: a child
# that stops answering blocks every agent in the gateway rather than one
# session. Nothing in this transport bounded a read before - with a bridge per
# session that was survivable, and with a shared one it is not. The deadline is
# generous on purpose: a tool call can legitimately take tens of seconds when
# it opens the store for writing and the integrity scan runs.
DEFAULT_REQUEST_TIMEOUT_SECONDS = 120.0
REQUEST_TIMEOUT_ENV = "OPEN_SECOND_BRAIN_MCP_TIMEOUT"


def resolve_request_timeout() -> float | None:
    """Seconds a single JSON-RPC round trip may take, or None to wait forever.

    A non-positive value disables the deadline, which is the escape hatch for
    an operator whose vault legitimately outruns it; it is spelled explicitly
    rather than reached by a malformed value, and a malformed value falls back
    to the default rather than to no bound at all.
    """
    raw = os.environ.get(REQUEST_TIMEOUT_ENV)
    if raw is None or raw.strip() == "":
        return DEFAULT_REQUEST_TIMEOUT_SECONDS
    try:
        seconds = float(raw)
    except ValueError:
        logger.warning(
            "%s is not a number (%r); using the %.0fs default",
            REQUEST_TIMEOUT_ENV,
            raw,
            DEFAULT_REQUEST_TIMEOUT_SECONDS,
        )
        return DEFAULT_REQUEST_TIMEOUT_SECONDS
    return None if seconds <= 0 else seconds


class BridgeError(RuntimeError):
    """Base error: a JSON-RPC error response or a transport failure."""


class BridgeTransportError(BridgeError):
    """The channel itself failed (EOF, broken pipe). Worth one restart.

    Distinct from a plain ``BridgeError``, which signals a JSON-RPC error
    response (e.g. invalid tool arguments) - a server-level rejection that a
    restart would only repeat, so it must propagate unchanged.
    """


class BridgeTimeoutError(BridgeTransportError):
    """The child is alive but did not answer inside the request deadline.

    A subclass of the transport error on purpose: the restart-and-retry ladder
    that already handles a dead child is the right response to an unresponsive
    one too, and a bridge nobody can get an answer from is not usefully
    different from a bridge that died.
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
    ``readline`` returning ``bytes`` (``b""`` at EOF). Responses are correlated
    by id; notifications and stale ids are skipped.

    Popen with ``bufsize=0`` (no ``text=True``) gives raw byte streams; the
    client decodes UTF-8 itself. This avoids the line-buffering deadlock that
    ``text=True, bufsize=1`` classically triggers with Popen pipes: a fast
    child writer + a slow parent reader fills the kernel buffer and both
    block, surfacing as a silent EOF on the JSON-RPC channel.
    """

    def __init__(self, writer: Any, reader: Any, timeout: float | None = None) -> None:
        self._writer = writer
        self._reader = reader
        self._id = 0
        self._timeout = timeout

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
            payload = (json.dumps(frame) + "\n").encode("utf-8")
            self._writer.write(payload)
            flush = getattr(self._writer, "flush", None)
            if callable(flush):
                flush()
        except (BrokenPipeError, ValueError, OSError) as exc:
            raise BridgeTransportError(f"write failed: {exc}") from exc

    def _readline(self, deadline: float | None) -> Any:
        """One line, or a timeout. Blocks plainly when no deadline is set.

        A blocking ``readline`` on a pipe cannot be interrupted, so the read
        runs on a daemon thread whose result is collected with the remaining
        budget. The thread is left behind on a timeout deliberately: the caller
        tears the child down, which closes the pipe and releases it. Daemon,
        because a thread stuck on a dead pipe must never hold up interpreter
        exit - the failure this whole change is about is a process that would
        not go away.
        """
        if deadline is None:
            return self._reader.readline()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise BridgeTimeoutError("no response from MCP server within the deadline")
        box: list[Any] = []
        error: list[BaseException] = []

        def pump() -> None:
            try:
                box.append(self._reader.readline())
            except BaseException as exc:  # noqa: BLE001 - reported to the caller
                error.append(exc)

        worker = threading.Thread(target=pump, daemon=True)
        worker.start()
        worker.join(remaining)
        if worker.is_alive():
            raise BridgeTimeoutError(
                f"no response from MCP server within {self._timeout:.0f}s"
            )
        if error:
            raise BridgeTransportError(f"read failed: {error[0]}") from error[0]
        return box[0] if box else None

    def _read_response(self, rid: int) -> Any:
        deadline = None if self._timeout is None else time.monotonic() + self._timeout
        while True:
            line = self._readline(deadline)
            # EOF arrives as b"" from a bytes reader, as "" from a str reader
            # (e.g. the StringIO-based _ScriptedReader in test_memory_provider),
            # and as None from a closed pipe. All three terminate the read.
            if line is None or line == b"" or line == "":
                raise BridgeTransportError("unexpected EOF from MCP server")
            if isinstance(line, bytes):
                line = line.decode("utf-8", errors="replace")
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
        repo_root: str | None = None,
        command: tuple[str, ...] = ("o2b", "mcp"),
        spawn: Any = None,
        cwd: str | None = None,
    ) -> None:
        self._vault = vault
        self._repo_root = repo_root
        self._command = command
        self._spawn = spawn or self._default_spawn
        self._cwd = cwd
        # A gateway may serve several AIAgents concurrently, but one shared
        # bridge has one request/response stream. Serialise lifecycle and RPC
        # operations so request ids and stdout frames cannot interleave.
        self._lock = threading.RLock()
        self._proc: Any = None
        self._client: JsonRpcStdioClient | None = None
        self._tools: list[dict[str, Any]] = []
        self._started = False

    def _argv(self) -> list[str]:
        argv = list(self._command)
        if self._vault:
            argv += ["--vault", self._vault]
        # Without --repo the server's repoRoot is null, so skill discovery
        # only searches <vault>/Brain/skills and never the in-repo skills/
        # directory - which silently empties skill_auto_attach.
        if self._repo_root:
            argv += ["--repo", self._repo_root]
        return argv

    _watchdog_absent_warned = False

    @classmethod
    def _warn_watchdog_absent(cls) -> None:
        if cls._watchdog_absent_warned:
            return
        cls._watchdog_absent_warned = True
        logger.warning(
            "parent-death watchdog module unavailable; open-second-brain MCP "
            "children will not be reaped if this process exits abruptly"
        )

    @staticmethod
    def _watchdog_argv(argv: list[str]) -> list[str]:
        """Wrap POSIX MCP children in Hermes' parent-death watchdog."""
        if os.name != "posix":
            return argv
        try:
            from tools import mcp_stdio_watchdog
        except ImportError:
            # The plugin can still operate from a standalone checkout; the
            # host's normal runtime has this module and gets descendant
            # cleanup. Say so rather than degrading in silence: if the module
            # is ever renamed, the guarantee disappears and nothing else would
            # report it. Once per process, because this is a property of the
            # installation and not of the call.
            McpBrainBridge._warn_watchdog_absent()
            return argv
        watchdog_path = getattr(mcp_stdio_watchdog, "__file__", None)
        if not watchdog_path:
            return argv
        return [
            sys.executable,
            str(watchdog_path),
            "--ppid",
            str(os.getpid()),
            "--",
            *argv,
        ]

    def _default_spawn(self, argv: list[str]) -> Any:
        # Use a small thread to drain stderr continuously; otherwise the child
        # can block on a full stderr pipe after logging init warnings and
        # silently die before its first stdout write - surfacing as
        # "unexpected EOF" on the JSON-RPC read. `bufsize=0` on the pipes
        # avoids the line-buffering deadlock that `text=True, bufsize=1`
        # classically triggers with Popen pipes: a fast child writer +
        # a slow parent reader fills the kernel buffer and both block.
        # Hermes' watchdog owns the real child process group, forwards the
        # stdio streams transparently, and kills the group when this gateway
        # exits unexpectedly.
        process = subprocess.Popen(  # noqa: S603 - argv is a fixed command + config path
            self._watchdog_argv(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            cwd=self._cwd,
        )
        stderr_thread = threading.Thread(
            target=self._drain_stderr,
            args=(process,),
            daemon=True,
            name="o2b-mcp-stderr-drain",
        )
        stderr_thread.start()
        return process

    @staticmethod
    def _drain_stderr(process: Any) -> None:
        """Read stderr line-by-line until the child exits; discard contents.

        Runs in a daemon thread so a misbehaving child (one that floods
        stderr) cannot wedge the parent. Without this, a `stderr=PIPE` child
        that writes more than the kernel pipe buffer (~64 KiB on Linux) will
        block on its next stderr write, which surfaces in the parent as a
        silent death of the JSON-RPC channel.
        """
        try:
            stream = getattr(process, "stderr", None)
            if stream is None:
                return
            for _line in iter(stream.readline, b""):
                # Drain and discard; we do not currently surface stderr to
                # the agent, but a future diagnostic flag could log it.
                pass
        except Exception:  # noqa: BLE001 - drain must never raise
            pass

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._proc = self._spawn(self._argv())
            self._client = JsonRpcStdioClient(
                self._proc.stdin, self._proc.stdout, timeout=resolve_request_timeout()
            )
            pid = getattr(self._proc, "pid", "unknown")
            logger.debug("open-second-brain MCP child spawned pid=%s", pid)
            try:
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
            except BaseException:
                # A failed handshake must not leak the spawned process.
                logger.warning("open-second-brain MCP handshake failed pid=%s", pid)
                self.stop()
                raise
            self._tools = list((result or {}).get("tools", []))
            self._started = True
            logger.debug("open-second-brain MCP child ready pid=%s", pid)

    def list_tools(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_started()
            return list(self._tools)

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            return self._call_tool(name, args)

    def _call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        # Hard cap on restarts: o2b mcp can flake under load (e.g. bun runtime
        # SIGPIPE on a parent process briefly holding the pipe). One restart is
        # not enough; a bounded retry with backoff turns a transient subproc
        # death into a successful call instead of an EOF error to the agent.
        # A plain BridgeError (JSON-RPC rejection) is server-level and never
        # triggers a restart - it would only repeat.
        max_attempts = 3
        backoff_seconds = 0.1
        last_transport_error: BridgeTransportError | None = None
        for attempt in range(max_attempts):
            try:
                # Spawn / handshake / restart all live inside the try: a
                # transport failure while bringing a replacement child up is
                # just as retryable as one on the request itself. Otherwise a
                # dead -> dead -> good sequence would abort on the second dead
                # child and collapse back to single-restart behaviour.
                self._ensure_started()
                assert self._client is not None
                if self._is_proc_dead():
                    # Subprocess died between the last call and now: restart, then try.
                    self._restart()
                    assert self._client is not None
                result = self._client.request(
                    "tools/call", {"name": name, "arguments": args}
                )
                return result or {}
            except BridgeTransportError as exc:
                last_transport_error = exc
                if attempt + 1 >= max_attempts:
                    break
                # Restart and back off briefly before the next attempt. A
                # restart that itself fails to hand-shake is captured, not
                # raised, so the remaining attempts still run.
                try:
                    self._restart()
                except BridgeTransportError as restart_exc:
                    last_transport_error = restart_exc
                if backoff_seconds > 0:
                    time.sleep(backoff_seconds)
                backoff_seconds *= 2
        assert last_transport_error is not None  # for type-checkers
        raise last_transport_error

    def _is_proc_dead(self) -> bool:
        """poll() the owned subprocess; return True if it has exited.

        Cheap health check that catches the case where the child died between
        the last successful call and this one (e.g. parent process briefly held
        the stdin pipe, child got SIGPIPE). Without this guard, the next write
        surfaces as a BrokenPipe that the EOF handler would otherwise see as a
        one-off flake and restart from - slow and noisy.
        """
        proc = self._proc
        if proc is None:
            return True
        poll = getattr(proc, "poll", None)
        if not callable(poll):
            return False
        return poll() is not None

    def stop(self) -> None:
        with self._lock:
            proc = self._proc
            self._started = False
            self._client = None
            self._proc = None
            if proc is None:
                return
            pid = getattr(proc, "pid", "unknown")
            try:
                poll = getattr(proc, "poll", None)
                if not callable(poll) or poll() is None:
                    proc.terminate()
            except Exception:  # noqa: BLE001 - shutdown is best-effort
                pass
            try:
                proc.wait(timeout=8)
            except Exception:  # noqa: BLE001 - escalate once, then still reap
                kill = getattr(proc, "kill", None)
                if callable(kill):
                    try:
                        kill()
                    except Exception:  # noqa: BLE001
                        pass
                try:
                    proc.wait(timeout=5)
                except Exception:  # noqa: BLE001
                    pass
            finally:
                # Release the parent's pipe descriptors as well as reaping the
                # child. The old implementation only waited for the process.
                for stream_name in ("stdin", "stdout", "stderr"):
                    stream = getattr(proc, stream_name, None)
                    close = getattr(stream, "close", None)
                    if callable(close):
                        try:
                            close()
                        except Exception:  # noqa: BLE001
                            pass
                logger.debug("open-second-brain MCP child stopped pid=%s", pid)

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
