"""Static tool schemas: integrity of the vendored copies and anti-drift.

The integrity tests are pure-Python and always run. The anti-drift test
spawns the live ``o2b mcp`` server and compares the vendored
(name, description, inputSchema) projection against ``tools/list``; it skips
with a visible reason when the CLI or the Bun runtime is unavailable, so unit
runs without the TS toolchain stay green while CI (which has Bun) enforces
the contract.
"""

from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from plugins.hermes._schemas import STATIC_TOOL_SCHEMAS, static_tool_schemas  # noqa: E402
from plugins.hermes.provider import MEMORY_TOOLS  # noqa: E402

# Fields the provider vendors for each tool; the anti-drift comparison is
# limited to this projection so unrelated server-side additions (annotations,
# outputSchema) cannot break the contract test.
_EMBEDDED_FIELDS = ("name", "description", "inputSchema")

_HANDSHAKE_TIMEOUT = 30.0


class StaticSchemaIntegrityTests(unittest.TestCase):
    def test_static_names_are_exactly_the_curated_set(self):
        self.assertEqual(
            {s["name"] for s in STATIC_TOOL_SCHEMAS},
            set(MEMORY_TOOLS),
        )
        self.assertEqual(len(STATIC_TOOL_SCHEMAS), len(MEMORY_TOOLS))

    def test_every_static_schema_is_complete(self):
        for schema in STATIC_TOOL_SCHEMAS:
            with self.subTest(tool=schema.get("name")):
                self.assertEqual(sorted(schema), sorted(_EMBEDDED_FIELDS))
                self.assertTrue(schema["name"])
                self.assertTrue(schema["description"])
                self.assertIsInstance(schema["inputSchema"], dict)
                self.assertEqual(schema["inputSchema"].get("type"), "object")

    def test_accessor_returns_deep_copies(self):
        first = static_tool_schemas()
        # static_tool_schemas() remaps inputSchema -> parameters
        first[0]["parameters"]["properties"]["__mutated__"] = True
        first[0]["name"] = "mutated"
        second = static_tool_schemas()
        self.assertNotEqual(second[0]["name"], "mutated")
        self.assertNotIn("__mutated__", second[0]["parameters"]["properties"])


def _live_memory_tool_projection() -> list[dict]:
    """Fetch tools/list from a live ``o2b mcp`` and project the curated subset."""
    proc = subprocess.Popen(  # noqa: S603 - fixed argv, test-only
        ["o2b", "mcp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    # Deadline for the whole handshake: if the server stays alive but never
    # answers, the timer kills it, readline() sees EOF, and the caller skips.
    watchdog = threading.Timer(_HANDSHAKE_TIMEOUT, proc.kill)
    watchdog.start()
    try:
        def request(rid: int, method: str, params: dict) -> dict:
            assert proc.stdin is not None and proc.stdout is not None
            frame = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
            proc.stdin.write(json.dumps(frame) + "\n")
            proc.stdin.flush()
            while True:
                line = proc.stdout.readline()
                if line == "":
                    raise RuntimeError("unexpected EOF from o2b mcp")
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict) and message.get("id") == rid:
                    if "error" in message:
                        raise RuntimeError(str(message["error"]))
                    return message.get("result") or {}

        request(
            1,
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "anti-drift-test", "version": "1"},
            },
        )
        assert proc.stdin is not None
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        tools = request(2, "tools/list", {}).get("tools", [])
    finally:
        watchdog.cancel()
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                stream.close()
        proc.terminate()
        try:
            proc.wait(timeout=_HANDSHAKE_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=_HANDSHAKE_TIMEOUT)
    return [
        {field: tool.get(field) for field in _EMBEDDED_FIELDS}
        for tool in tools
        if tool.get("name") in MEMORY_TOOLS
    ]


class AntiDriftTests(unittest.TestCase):
    """The vendored schemas must match the live server, field by field."""

    def test_static_schemas_match_live_tools_list(self):
        if shutil.which("o2b") is None:
            self.skipTest("o2b CLI not on PATH; anti-drift needs the live server")
        try:
            live = _live_memory_tool_projection()
        except (OSError, RuntimeError) as exc:
            self.skipTest(f"live o2b mcp unavailable: {exc}")
        live_by_name = {t["name"]: t for t in live}
        self.assertEqual(set(live_by_name), set(MEMORY_TOOLS), "curated tool missing from live tools/list")
        for schema in STATIC_TOOL_SCHEMAS:
            with self.subTest(tool=schema["name"]):
                self.assertEqual(
                    copy.deepcopy(schema),
                    live_by_name[schema["name"]],
                    "vendored schema drifted from the live server; "
                    "re-vendor plugins/hermes/_schemas.py from `o2b mcp` tools/list",
                )


if __name__ == "__main__":
    unittest.main()
