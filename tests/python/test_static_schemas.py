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
from plugins.hermes.bridge import FakeBrainBridge  # noqa: E402
from plugins.hermes.provider import (  # noqa: E402
    MEMORY_TOOLS,
    OpenSecondBrainMemoryProvider,
)

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


def _is_prewrapped(entry: dict) -> bool:
    """A schema is pre-wrapped when it carries the Chat-Completions function
    envelope (``{"type": "function", "function": {...}}``) at the top level
    instead of a flat tool schema. Upstream Hermes PR #52140 makes core unwrap
    such entries before it re-wraps them; OSB must never hand core a pre-wrapped
    entry in the first place, or a strict provider (DeepSeek) 400s the turn."""
    return entry.get("type") == "function" and isinstance(entry.get("function"), dict)


class NormalizeContractTests(unittest.TestCase):
    """Guard OSB's exported schema shape against core's new
    normalize/validate-before-wrap (Hermes PR #52140). The exported entries
    must be flat and named so core's ``normalize_tool_schema()`` neither
    unwraps nor drops any of them."""

    def test_static_tuple_entries_are_flat_and_named(self):
        for schema in STATIC_TOOL_SCHEMAS:
            with self.subTest(tool=schema.get("name")):
                self.assertFalse(
                    _is_prewrapped(schema),
                    "static schema is pre-wrapped; core would unwrap it",
                )
                name = schema.get("name")
                self.assertIsInstance(name, str)
                self.assertTrue(name, "static schema has an empty top-level name")

    def test_accessor_output_entries_are_flat_and_named(self):
        for schema in static_tool_schemas():
            with self.subTest(tool=schema.get("name")):
                self.assertFalse(_is_prewrapped(schema))
                name = schema.get("name")
                self.assertIsInstance(name, str)
                self.assertTrue(name)

    def test_remap_preserves_names_count_and_order(self):
        # The inputSchema->parameters remap must not drop, rename, or reorder
        # any tool: normalization keys off the top-level name, so a silent
        # rename would desync the routing table.
        static_names = [s["name"] for s in STATIC_TOOL_SCHEMAS]
        accessor_names = [s["name"] for s in static_tool_schemas()]
        self.assertEqual(accessor_names, static_names)
        self.assertEqual(len(accessor_names), len(MEMORY_TOOLS))
        self.assertEqual(set(accessor_names), set(MEMORY_TOOLS))

    def test_remap_moves_inputschema_to_parameters_without_wrapping(self):
        for schema in static_tool_schemas():
            with self.subTest(tool=schema["name"]):
                # The MCP key is gone, the adapter key is present, and the
                # remap introduced no function envelope.
                self.assertNotIn("inputSchema", schema)
                self.assertIn("parameters", schema)
                self.assertEqual(schema["parameters"].get("type"), "object")
                self.assertFalse(_is_prewrapped(schema))

    def test_accessor_is_idempotent_and_deep_copied(self):
        first = static_tool_schemas()
        second = static_tool_schemas()
        self.assertEqual(first, second)
        # Deep-copied: mutating one call's output cannot leak into the next.
        first[0]["parameters"]["properties"]["__mutated__"] = True
        third = static_tool_schemas()
        self.assertEqual(third, second)
        self.assertNotIn("__mutated__", third[0]["parameters"]["properties"])


class ProviderNormalizeSurvivalTests(unittest.TestCase):
    """A strict-provider turn: drive the provider's live-listing path with a
    tool list that mixes a normal curated tool, a non-curated tool, and an
    accidentally pre-wrapped entry. The provider must keep the curated flat
    tools intact and never emit a nameless or double-wrapped schema — the exact
    shape core's normalize/validate step accepts without disabling the toolset."""

    def _provider_with_live_tools(self, tools):
        bridge = FakeBrainBridge(tools=tools)
        provider = OpenSecondBrainMemoryProvider(bridge=bridge)
        provider.initialize("s", hermes_home="/tmp/hh")
        return provider

    def test_live_toolset_survives_normalize_path(self):
        tools = [
            {"name": "brain_note", "description": "d", "inputSchema": {"type": "object"}},
            {"name": "brain_query", "description": "d", "inputSchema": {"type": "object"}},
            # Non-curated: must be filtered out by name.
            {"name": "vault_health", "description": "d", "inputSchema": {"type": "object"}},
            # Accidentally pre-wrapped: no top-level name, so it is dropped
            # rather than emitted as a double-wrapped entry that core would
            # have to unwrap.
            {"type": "function", "function": {"name": "brain_search", "parameters": {"type": "object"}}},
        ]
        schemas = self._provider_with_live_tools(tools)
        emitted = schemas.get_tool_schemas()

        names = {s.get("name") for s in emitted}
        # Only curated, properly-named tools survive; the pre-wrapped and the
        # non-curated entries are gone.
        self.assertEqual(names, {"brain_note", "brain_query"})
        self.assertTrue(names.issubset(set(MEMORY_TOOLS)))

        for entry in emitted:
            with self.subTest(tool=entry.get("name")):
                # No entry is nameless or double-wrapped, and each was remapped
                # to the adapter key.
                self.assertIsInstance(entry.get("name"), str)
                self.assertTrue(entry["name"])
                self.assertFalse(_is_prewrapped(entry))
                self.assertNotIn("inputSchema", entry)
                self.assertIn("parameters", entry)

    def test_static_fallback_path_also_survives_normalize(self):
        # When the live listing fails, the vendored static set is the surface a
        # strict provider sees; it must satisfy the same flat-and-named contract.
        class _ListingFailsBridge(FakeBrainBridge):
            def list_tools(self):
                raise RuntimeError("listing failed")

        provider = OpenSecondBrainMemoryProvider(bridge=_ListingFailsBridge())
        provider.initialize("s", hermes_home="/tmp/hh")
        emitted = provider.get_tool_schemas()
        self.assertEqual({s["name"] for s in emitted}, set(MEMORY_TOOLS))
        for entry in emitted:
            with self.subTest(tool=entry["name"]):
                self.assertFalse(_is_prewrapped(entry))
                self.assertTrue(entry["name"])
                self.assertNotIn("inputSchema", entry)


if __name__ == "__main__":
    unittest.main()
