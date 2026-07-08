"""Tests for the native Hermes memory provider and its bridge.

The provider subclasses the Hermes ``MemoryProvider`` ABC when running inside
a Hermes install, and a local fallback base otherwise (so this repo's CI can
exercise it without Hermes present). All deterministic work is delegated to
the TypeScript core through a ``BrainBridge`` seam, which tests replace with a
fake so no live Bun runtime is needed.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from plugins.hermes import config as cfg  # noqa: E402
from plugins.hermes._base import (  # noqa: E402
    HAS_HERMES_ABC,
    MemoryProvider,
    _FallbackMemoryProviderBase,
)
from plugins.hermes.bridge import (  # noqa: E402
    BridgeError,
    BridgeTransportError,
    FakeBrainBridge,
    JsonRpcStdioClient,
    McpBrainBridge,
)
from plugins.hermes.provider import (  # noqa: E402
    MEMORY_TOOLS,
    OpenSecondBrainMemoryProvider,
)
from plugins.hermes.cli import register_cli  # noqa: E402


class ConfigHelperTests(unittest.TestCase):
    _ENV_KEYS = ("VAULT_AGENT_NAME", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG")

    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in self._ENV_KEYS}
        cfg._reset_template_cache_for_tests()

    def tearDown(self):
        for k in self._ENV_KEYS:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]
        cfg._reset_template_cache_for_tests()

    def _write_config(self, tmp, body):
        path = Path(tmp) / "config.yaml"
        path.write_text(body, encoding="utf-8")
        os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(path)
        return path

    def test_resolve_agent_name_prefers_env(self):
        os.environ["VAULT_AGENT_NAME"] = "env-agent"
        self.assertEqual(cfg.resolve_agent_name(), "env-agent")

    def test_resolve_agent_name_from_config_snake_and_camel(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_config(tmp, 'agent_name: "snake-agent"\n')
            self.assertEqual(cfg.resolve_agent_name(), "snake-agent")
        with tempfile.TemporaryDirectory() as tmp:
            self._write_config(tmp, 'agentName: "camel-agent"\n')
            self.assertEqual(cfg.resolve_agent_name(), "camel-agent")

    def test_resolve_agent_name_default_when_unresolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(Path(tmp) / "missing.yaml")
            self.assertEqual(cfg.resolve_agent_name(), cfg.DEFAULT_AGENT)

    def test_resolve_vault_prefers_env(self):
        os.environ["VAULT_DIR"] = "/tmp/env-vault"
        self.assertEqual(cfg.resolve_vault(), "/tmp/env-vault")

    def test_resolve_vault_from_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_config(tmp, 'vault: "/tmp/cfg-vault"\nagent_name: "x"\n')
            self.assertEqual(cfg.resolve_vault(), "/tmp/cfg-vault")

    def test_resolve_vault_none_when_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_config(tmp, 'agent_name: "x"\n')
            self.assertIsNone(cfg.resolve_vault())

    def test_render_reminder_substitutes_every_placeholder(self):
        rendered = cfg.render_reminder("zed")
        self.assertIn("@zed", rendered)
        self.assertNotIn("{agent}", rendered)

    def test_build_reminder_none_when_unresolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(Path(tmp) / "missing.yaml")
            self.assertIsNone(cfg.build_reminder())

    def test_build_reminder_string_when_identity_set(self):
        os.environ["VAULT_AGENT_NAME"] = "build-agent"
        reminder = cfg.build_reminder()
        self.assertIsNotNone(reminder)
        self.assertIn("@build-agent", reminder)


class FallbackBaseTests(unittest.TestCase):
    """Pin the no-op stand-in contract.

    These tests target ``_FallbackMemoryProviderBase`` directly so they hold in
    both environments: CI without the Hermes ABC, and a real install where
    ``MemoryProvider`` aliases the Hermes ABC (which enforces its abstract
    surface). The stand-in is the unit under test, not whichever base
    ``MemoryProvider`` resolves to at import time.
    """

    def test_fallback_base_is_subclassable_without_abstract_methods(self):
        class Demo(_FallbackMemoryProviderBase):
            @property
            def name(self):
                return "demo"

        demo = Demo()
        self.assertEqual(demo.name, "demo")

    def test_optional_hooks_are_noop_on_fallback_base(self):
        class Demo(_FallbackMemoryProviderBase):
            @property
            def name(self):
                return "demo"

        demo = Demo()
        # Optional lifecycle hooks the provider may not override must not raise.
        self.assertIsNone(demo.queue_prefetch("q"))
        self.assertIsNone(demo.on_session_end([]))
        self.assertIsNone(demo.shutdown())

    def test_memory_provider_aliases_fallback_base_without_hermes(self):
        # When the Hermes ABC is unavailable, MemoryProvider must BE the
        # fallback stand-in (not a separate class), so the provider subclass
        # inherits the no-op hooks. With Hermes present, MemoryProvider is the
        # real ABC and the stand-in stays independently testable above.
        if not HAS_HERMES_ABC:
            self.assertIs(MemoryProvider, _FallbackMemoryProviderBase)
        else:
            self.assertIsNot(MemoryProvider, _FallbackMemoryProviderBase)


class ProviderRequiredSurfaceTests(unittest.TestCase):
    _ENV_KEYS = ("VAULT_AGENT_NAME", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG")

    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in self._ENV_KEYS}

    def tearDown(self):
        for k in self._ENV_KEYS:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]

    def _provider(self, bridge):
        return OpenSecondBrainMemoryProvider(bridge=bridge)

    def test_name(self):
        self.assertEqual(self._provider(FakeBrainBridge()).name, "open-second-brain")

    def test_is_available_true_when_vault_configured(self):
        os.environ["VAULT_DIR"] = "/tmp/vault"
        self.assertTrue(self._provider(FakeBrainBridge()).is_available())

    def test_is_available_false_when_no_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(Path(tmp) / "missing.yaml")
            self.assertFalse(self._provider(FakeBrainBridge()).is_available())

    def test_initialize_starts_bridge(self):
        bridge = FakeBrainBridge()
        provider = self._provider(bridge)
        provider.initialize("sess-1", hermes_home="/tmp/hh")
        self.assertTrue(bridge.started)

    def test_get_tool_schemas_filters_to_allowlist(self):
        bridge = FakeBrainBridge(
            tools=[
                {"name": "brain_query"},
                {"name": "brain_note"},
                {"name": "vault_health"},
                {"name": "second_brain_status"},
            ]
        )
        provider = self._provider(bridge)
        provider.initialize("s", hermes_home="/tmp/hh")
        names = {t["name"] for t in provider.get_tool_schemas()}
        self.assertEqual(names, {"brain_query", "brain_note"})
        self.assertTrue(names.issubset(set(MEMORY_TOOLS)))

    def test_handle_tool_call_forwards_to_bridge(self):
        bridge = FakeBrainBridge(results={"brain_note": {"ok": True}})
        provider = self._provider(bridge)
        provider.initialize("s", hermes_home="/tmp/hh")
        result = provider.handle_tool_call("brain_note", {"text": "hi"})
        # Hermes feeds the return back as tool-message content, so the
        # contract is str, not dict. The MCP result is serialized losslessly.
        self.assertIsInstance(result, str)
        self.assertEqual(json.loads(result), {"ok": True})
        self.assertEqual(bridge.calls, [("brain_note", {"text": "hi"})])

    def test_handle_tool_call_always_returns_string_for_dict_results(self):
        # The base-class contract types handle_tool_call as -> str. A raw dict
        # reaching the model as tool content breaks strict providers (DeepSeek
        # HTTP 400) while passing on lenient ones (Anthropic), so the boundary
        # must coerce regardless of the tool's result shape.
        shapes = {
            "brain_note": {"content": [{"type": "text", "text": "ok"}], "structuredContent": {"ok": True}},
            "brain_query": {"structuredContent": {"hits": [1, 2, 3]}},
            "brain_search": {},
        }
        bridge = FakeBrainBridge(results=shapes)
        provider = self._provider(bridge)
        provider.initialize("s", hermes_home="/tmp/hh")
        for tool, shape in shapes.items():
            result = provider.handle_tool_call(tool, {})
            self.assertIsInstance(result, str, f"{tool} must return a string")
            # Lossless: both the content and structuredContent envelopes survive.
            self.assertEqual(json.loads(result), shape)

    def test_handle_tool_call_passes_through_string_result(self):
        # A bridge that already yields a string must not be double-encoded.
        bridge = FakeBrainBridge(results={"brain_note": "plain text"})
        provider = self._provider(bridge)
        provider.initialize("s", hermes_home="/tmp/hh")
        self.assertEqual(provider.handle_tool_call("brain_note", {}), "plain text")

    def test_get_config_schema_shape(self):
        schema = self._provider(FakeBrainBridge()).get_config_schema()
        by_key = {f["key"]: f for f in schema}
        self.assertEqual(set(by_key), {"vault", "agent_name", "timezone"})
        self.assertTrue(by_key["vault"].get("required"))

    def test_save_config_writes_to_osb_config_and_preserves_others(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.yaml"
            cfg_path.write_text('existing_key: "keep"\n', encoding="utf-8")
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(cfg_path)
            provider = self._provider(FakeBrainBridge())
            provider.save_config(
                {"vault": "/v", "agent_name": "a", "timezone": "UTC"}, tmp
            )
            text = cfg_path.read_text(encoding="utf-8")
        self.assertIn('vault: "/v"', text)
        self.assertIn('agent_name: "a"', text)
        self.assertIn('timezone: "UTC"', text)
        self.assertIn('existing_key: "keep"', text)

    def test_handle_tool_call_rejects_non_allowlisted_tool(self):
        bridge = FakeBrainBridge(results={"brain_dream": {"ok": True}})
        provider = self._provider(bridge)
        provider.initialize("s", hermes_home="/tmp/hh")
        with self.assertRaises(BridgeError):
            provider.handle_tool_call("brain_dream", {})
        self.assertEqual(bridge.calls, [])  # never reached the bridge

    def test_save_config_encodes_windows_path_safely(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.yaml"
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(cfg_path)
            provider = self._provider(FakeBrainBridge())
            win = 'C:\\Users\\me\\My "Special" Vault'
            provider.save_config({"vault": win}, tmp)
            # Round-trips through the writer (JSON scalar) and the reader, even
            # with backslashes and embedded quotes that would corrupt a raw
            # interpolation. Asserted inside the tempdir so the file still exists.
            self.assertEqual(cfg.resolve_vault(), win)


class ProviderStaticSchemaFallbackTests(unittest.TestCase):
    """Hermes builds its tool routing table BEFORE initialize(); the provider
    must advertise the curated tool set from the very first
    get_tool_schemas() call, not only after the bridge is up."""

    def _curated_live_tools(self):
        return [
            {"name": name, "description": f"live {name}", "inputSchema": {"type": "object"}}
            for name in MEMORY_TOOLS
        ]

    def test_get_tool_schemas_before_initialize_returns_curated_set(self):
        provider = OpenSecondBrainMemoryProvider(bridge=FakeBrainBridge())
        schemas = provider.get_tool_schemas()  # no initialize() yet
        self.assertEqual({s["name"] for s in schemas}, set(MEMORY_TOOLS))
        for schema in schemas:
            self.assertTrue(schema["description"])
            # static_tool_schemas() remaps inputSchema -> parameters
            self.assertEqual(schema["parameters"].get("type"), "object")

    def test_get_tool_schemas_after_initialize_keeps_name_set(self):
        bridge = FakeBrainBridge(tools=self._curated_live_tools())
        provider = OpenSecondBrainMemoryProvider(bridge=bridge)
        before = {s["name"] for s in provider.get_tool_schemas()}
        provider.initialize("s", hermes_home="/tmp/hh")
        after = {s["name"] for s in provider.get_tool_schemas()}
        self.assertEqual(before, after)
        # Live schemas win once the bridge is up.
        self.assertTrue(
            all(s["description"].startswith("live ") for s in provider.get_tool_schemas())
        )

    def test_get_tool_schemas_falls_back_to_static_when_listing_fails(self):
        class _ListingFailsBridge(FakeBrainBridge):
            def list_tools(self):
                raise BridgeError("listing failed")

        provider = OpenSecondBrainMemoryProvider(bridge=_ListingFailsBridge())
        provider.initialize("s", hermes_home="/tmp/hh")
        names = {s["name"] for s in provider.get_tool_schemas()}
        self.assertEqual(names, set(MEMORY_TOOLS))

    def test_handle_tool_call_before_initialize_still_raises(self):
        provider = OpenSecondBrainMemoryProvider(bridge=FakeBrainBridge())
        with self.assertRaises(BridgeError):
            provider.handle_tool_call("brain_note", {"text": "early"})

    def test_hermes_registration_ordering_end_to_end(self):
        # Simulate MemoryManager.add_provider(): the routing table is built
        # from get_tool_schemas() BEFORE initialize_all() runs.
        bridge = FakeBrainBridge(
            tools=self._curated_live_tools(),
            results={"brain_note": {"ok": True}},
        )
        provider = OpenSecondBrainMemoryProvider(bridge=bridge)
        routing_table = {s["name"]: provider for s in provider.get_tool_schemas()}
        self.assertGreaterEqual(len(routing_table), 1)  # "registered (N tools)", N >= 1
        self.assertIn("brain_note", routing_table)

        # initialize_all() runs after registration; the model then calls a tool.
        provider.initialize("sess-1", hermes_home="/tmp/hh")
        result = routing_table["brain_note"].handle_tool_call("brain_note", {"text": "hi"})
        self.assertIsInstance(result, str)
        self.assertEqual(json.loads(result), {"ok": True})
        self.assertEqual(bridge.calls, [("brain_note", {"text": "hi"})])


class CliTests(unittest.TestCase):
    _ENV_KEYS = ("VAULT_AGENT_NAME", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG")

    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in self._ENV_KEYS}

    def tearDown(self):
        for k in self._ENV_KEYS:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]

    def _run(self, argv):
        import argparse
        import contextlib

        parser = argparse.ArgumentParser()
        subparsers = parser.add_subparsers(dest="cmd")
        osb = subparsers.add_parser("open-second-brain")
        register_cli(osb)
        args = parser.parse_args(["open-second-brain", *argv])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = args.func(args)
        return rc, buf.getvalue()

    def test_status_reports_provider_and_availability(self):
        os.environ["VAULT_DIR"] = "/tmp/cli-vault"
        rc, out = self._run(["status"])
        self.assertEqual(rc, 0)
        self.assertIn("open-second-brain", out)
        self.assertIn("/tmp/cli-vault", out)

    def test_status_nonzero_when_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(Path(tmp) / "missing.yaml")
            rc, _ = self._run(["status"])
        self.assertEqual(rc, 1)

    def test_config_reports_effective_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.yaml"
            cfg_path.write_text('vault: "/v"\nagent_name: "cli-agent"\n', encoding="utf-8")
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(cfg_path)
            rc, out = self._run(["config"])
        self.assertEqual(rc, 0)
        self.assertIn("/v", out)
        self.assertIn("cli-agent", out)


class _RaisingBridge(FakeBrainBridge):
    """Bridge whose tool calls always fail, to prove hooks are exception-safe."""

    def call_tool(self, name, args):
        raise BridgeError("boom")


class ProviderLifecycleTests(unittest.TestCase):
    _ENV_KEYS = ("VAULT_AGENT_NAME", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG")

    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in self._ENV_KEYS}

    def tearDown(self):
        for k in self._ENV_KEYS:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]

    def _init(self, bridge, **kwargs):
        provider = OpenSecondBrainMemoryProvider(bridge=bridge)
        provider.initialize("sess-1", **kwargs)
        return provider

    def test_system_prompt_block_returns_active_content(self):
        bridge = FakeBrainBridge(
            results={"brain_context": {"structuredContent": {"content": "ACTIVE PREFS"}}}
        )
        provider = self._init(bridge, hermes_home="/tmp/hh")
        self.assertEqual(provider.system_prompt_block(), "ACTIVE PREFS")

    def test_prefetch_returns_recall_and_reminder_when_gate_retrieves(self):
        os.environ["VAULT_AGENT_NAME"] = "pf-agent"
        bridge = FakeBrainBridge(
            results={
                "brain_recall_gate": {"structuredContent": {"retrieve": True, "reason": "hit"}},
                "brain_context_pack": {"content": [{"type": "text", "text": "RECALLED"}]},
            }
        )
        provider = self._init(bridge, hermes_home="/tmp/hh")
        out = provider.prefetch("what did we decide", session_id="sess-1")
        self.assertIn("RECALLED", out)
        self.assertIn("@pf-agent", out)

    def test_prefetch_appends_skills_attach_block_when_enabled(self):
        os.environ["VAULT_AGENT_NAME"] = "pf-agent"
        bridge = FakeBrainBridge(
            results={
                "brain_recall_gate": {"structuredContent": {"retrieve": False}},
                "skills_attach": {
                    "structuredContent": {
                        "enabled": True,
                        "block": "## Relevant skills\n\n- embeddings-setup - configure providers",
                        "skills": [{"name": "embeddings-setup"}],
                    }
                },
            }
        )
        provider = self._init(bridge, hermes_home="/tmp/hh")
        out = provider.prefetch("configure embeddings", session_id="sess-1")
        self.assertIn("## Relevant skills", out)
        self.assertIn("embeddings-setup", out)

    def test_prefetch_unchanged_when_skills_attach_disabled_or_missing(self):
        os.environ["VAULT_AGENT_NAME"] = "pf-agent"
        bridge = FakeBrainBridge(
            results={
                "brain_recall_gate": {"structuredContent": {"retrieve": False}},
                "skills_attach": {"structuredContent": {"enabled": False, "block": ""}},
            }
        )
        provider = self._init(bridge, hermes_home="/tmp/hh")
        out = provider.prefetch("hello", session_id="sess-1")
        self.assertNotIn("Relevant skills", out)
        self.assertIn("@pf-agent", out)

    def test_prefetch_reminder_only_when_gate_declines(self):
        os.environ["VAULT_AGENT_NAME"] = "pf-agent"
        bridge = FakeBrainBridge(
            results={"brain_recall_gate": {"structuredContent": {"retrieve": False}}}
        )
        provider = self._init(bridge, hermes_home="/tmp/hh")
        out = provider.prefetch("hello", session_id="sess-1")
        self.assertIn("@pf-agent", out)
        self.assertNotIn("RECALLED", out)
        called = [name for name, _ in bridge.calls]
        self.assertNotIn("brain_context_pack", called)

    def test_prefetch_empty_when_no_identity_and_no_recall(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(Path(tmp) / "missing.yaml")
            bridge = FakeBrainBridge(
                results={"brain_recall_gate": {"structuredContent": {"retrieve": False}}}
            )
            provider = self._init(bridge, hermes_home="/tmp/hh")
            self.assertEqual(provider.prefetch("hi"), "")

    def test_sync_turn_buffers_and_pre_compress_flushes_through_extract(self):
        bridge = FakeBrainBridge(results={"brain_pre_compact_extract": {"structuredContent": {}}})
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.sync_turn("u1", "a1", session_id="sess-1")
        provider.sync_turn("u2", "a2", session_id="sess-1")
        provider._drain_captures()
        provider.on_pre_compress([])
        extract_calls = [a for n, a in bridge.calls if n == "brain_pre_compact_extract"]
        self.assertEqual(len(extract_calls), 1)
        self.assertIn("u1", extract_calls[0]["text"])
        self.assertIn("a2", extract_calls[0]["text"])
        # Buffer cleared: a second flush makes no further extract call.
        provider.on_session_end([])
        self.assertEqual(
            len([1 for n, _ in bridge.calls if n == "brain_pre_compact_extract"]), 1
        )

    def test_on_session_end_clean_close_omits_interrupted_flag(self):
        bridge = FakeBrainBridge(results={"brain_pre_compact_extract": {"structuredContent": {}}})
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.sync_turn("u1", "a1", session_id="sess-1")
        provider._drain_captures()
        provider.on_session_end([])
        extract_calls = [a for n, a in bridge.calls if n == "brain_pre_compact_extract"]
        self.assertEqual(len(extract_calls), 1)
        # A clean close is byte-identical: no interrupted field on the payload.
        self.assertNotIn("interrupted", extract_calls[0])

    def test_on_session_end_surfaces_interrupted_onto_flush_payload(self):
        bridge = FakeBrainBridge(results={"brain_pre_compact_extract": {"structuredContent": {}}})
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.sync_turn("u1", "a1", session_id="sess-1")
        provider._drain_captures()
        provider.on_session_end([], interrupted=True)
        extract_calls = [a for n, a in bridge.calls if n == "brain_pre_compact_extract"]
        self.assertEqual(len(extract_calls), 1)
        # The interrupted close is recorded honestly on the flushed segment.
        self.assertIs(extract_calls[0].get("interrupted"), True)

    def test_on_session_end_drains_and_flushes_the_exit_path(self):
        # Regression for Hermes #49315: the god-file Phase 4 refactor bound the
        # atexit _active_agent_ref to the mixin module instead of cli.py, so
        # on_session_end never fired on CLI /exit and end-of-session capture was
        # silently lost. The hook is native again; this guards the path /exit now
        # drives by calling on_session_end WITHOUT a prior manual _drain_captures()
        # — the hook must self-drain the in-flight sync_turn thread and flush.
        bridge = FakeBrainBridge(results={"brain_pre_compact_extract": {"structuredContent": {}}})
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.sync_turn("u1", "a1", session_id="sess-1")
        # No _drain_captures() here: end-of-session capture must work end to end.
        provider.on_session_end([])
        extract_calls = [a for n, a in bridge.calls if n == "brain_pre_compact_extract"]
        self.assertEqual(len(extract_calls), 1)
        self.assertIn("u1", extract_calls[0]["text"])
        self.assertIn("a1", extract_calls[0]["text"])
        # The capture threads were joined: drain ran inside the hook.
        self.assertEqual(provider._sync_threads, [])

    def test_on_memory_write_forwards_to_host_bridge_tool(self):
        bridge = FakeBrainBridge(
            results={"brain_memory_bridge": {"structuredContent": {"recorded": True}}}
        )
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.on_memory_write(
            "add", "user", "remember the vault path", metadata={"session_id": "s1"}
        )
        bridge_calls = [a for n, a in bridge.calls if n == "brain_memory_bridge"]
        self.assertEqual(len(bridge_calls), 1)
        self.assertEqual(bridge_calls[0]["action"], "add")
        self.assertEqual(bridge_calls[0]["target"], "user")
        self.assertEqual(bridge_calls[0]["content"], "remember the vault path")
        self.assertEqual(bridge_calls[0]["metadata"], {"session_id": "s1"})
        # The deprecated brain_note mirror path is gone.
        self.assertEqual([n for n, _ in bridge.calls if n == "brain_note"], [])

    def test_on_memory_write_omits_empty_metadata(self):
        bridge = FakeBrainBridge(results={"brain_memory_bridge": {"structuredContent": {}}})
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.on_memory_write("replace", "memory", "an observation")
        args = next(a for n, a in bridge.calls if n == "brain_memory_bridge")
        self.assertNotIn("metadata", args)

    def test_on_memory_write_is_noop_without_a_bridge(self):
        # No host invocation path: a provider with no started bridge writes nothing.
        provider = OpenSecondBrainMemoryProvider(bridge=None)
        provider.on_memory_write("add", "user", "x")  # must not raise

    def test_memory_bridge_tool_is_not_agent_facing(self):
        # The host bridge tool is advertised on the server but deliberately kept
        # out of the curated agent surface: the Hermes agent must not see or be
        # able to invoke it directly — only the on_memory_write hook calls it.
        self.assertNotIn("brain_memory_bridge", MEMORY_TOOLS)
        bridge = FakeBrainBridge()
        provider = self._init(bridge, hermes_home="/tmp/hh")
        with self.assertRaises(BridgeError):
            provider.handle_tool_call("brain_memory_bridge", {"action": "add"})

    def test_shutdown_stops_bridge(self):
        bridge = FakeBrainBridge()
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.shutdown()
        self.assertTrue(bridge.stopped)

    def test_hooks_are_exception_safe(self):
        os.environ["VAULT_AGENT_NAME"] = "safe-agent"
        provider = self._init(_RaisingBridge(), hermes_home="/tmp/hh")
        # None of these may raise even though every bridge call fails.
        self.assertEqual(provider.system_prompt_block(), "")
        self.assertIn("@safe-agent", provider.prefetch("q"))
        provider.sync_turn("u", "a")
        provider._drain_captures()
        provider.on_pre_compress([])
        provider.on_session_end([])
        provider.on_memory_write("add", "user", "x")
        provider.shutdown()


class InPlaceCompactionLifecycleTests(unittest.TestCase):
    """Regression guards for Hermes PR #52658 (compression.in_place default
    False->True). Compaction now keeps ONE durable session id instead of
    rotating it, so the provider must flush exactly once per boundary that has
    buffered turns, clear its buffer between flushes (no double-flush /
    clobber), and make no assumption that the session id rotates.
    """

    _ENV_KEYS = ("VAULT_AGENT_NAME", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG")

    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in self._ENV_KEYS}

    def tearDown(self):
        for k in self._ENV_KEYS:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]

    def _init(self, bridge, session_id):
        provider = OpenSecondBrainMemoryProvider(bridge=bridge)
        provider.initialize(session_id, hermes_home="/tmp/hh")
        return provider

    @staticmethod
    def _extract_calls(bridge):
        return [a for n, a in bridge.calls if n == "brain_pre_compact_extract"]

    def test_repeated_in_place_compaction_flushes_each_boundary_once_with_stable_session_id(self):
        bridge = FakeBrainBridge(results={"brain_pre_compact_extract": {"structuredContent": {}}})
        provider = self._init(bridge, "sess-stable")

        # Buffer a turn, then fire boundary #1 (in-place compaction).
        provider.sync_turn("u1", "a1", session_id="sess-stable")
        provider._drain_captures()
        provider.on_pre_compress([])  # boundary #1: flushes the buffered turn

        # Boundary #2 uses the SAME (non-rotating) session id but no new turn
        # was buffered; the buffer was cleared by #1, so it must NOT re-flush.
        provider.on_pre_compress([])  # boundary #2: zero extract calls
        # A final session end (still the same stable id) also adds nothing.
        provider.on_session_end([])   # zero extract calls

        extract_calls = self._extract_calls(bridge)
        self.assertEqual(len(extract_calls), 1)
        # The single flush carried the stable session id, never a rotated one.
        self.assertEqual(extract_calls[0]["session_id"], "sess-stable")
        self.assertIn("u1", extract_calls[0]["text"])
        self.assertIn("a1", extract_calls[0]["text"])

        # Now buffer NEW turns between boundary #1 and a later boundary and
        # assert the next boundary flushes only the new turns — no re-flush of
        # #1's content, proving no duplicate/clobbered writes accumulate under
        # a stable id.
        provider.sync_turn("u2", "a2", session_id="sess-stable")
        provider._drain_captures()
        provider.on_pre_compress([])  # boundary #3: flushes only u2/a2

        extract_calls = self._extract_calls(bridge)
        self.assertEqual(len(extract_calls), 2)
        second = extract_calls[1]
        self.assertEqual(second["session_id"], "sess-stable")
        self.assertIn("u2", second["text"])
        self.assertNotIn("u1", second["text"])
        self.assertNotIn("a1", second["text"])

    def test_stable_session_id_does_not_assume_rotation(self):
        # Decision guard: the provider makes NO assumption that session_id
        # changes across compaction. Passing the same id to repeated sync_turn
        # + on_pre_compress produces independent, dedup-safe flushes — each
        # carries only the turns buffered since the previous boundary, keyed by
        # the one stable id (the TS core dedupes by content hash downstream).
        bridge = FakeBrainBridge(results={"brain_pre_compact_extract": {"structuredContent": {}}})
        provider = self._init(bridge, "sess-stable")

        for tag in ("t1", "t2", "t3"):
            provider.sync_turn(f"u-{tag}", f"a-{tag}", session_id="sess-stable")
            provider._drain_captures()
            provider.on_pre_compress([])

        extract_calls = self._extract_calls(bridge)
        self.assertEqual(len(extract_calls), 3)
        # Every flush used the one stable id; none assumed a rotated/new id.
        self.assertEqual({c["session_id"] for c in extract_calls}, {"sess-stable"})
        # Each flush is independent — it carries only its own turn, so repeated
        # in-place compaction under one id cannot clobber a prior boundary.
        self.assertIn("u-t1", extract_calls[0]["text"])
        self.assertNotIn("u-t2", extract_calls[0]["text"])
        self.assertIn("u-t3", extract_calls[2]["text"])
        self.assertNotIn("u-t1", extract_calls[2]["text"])
        # turn_end reflects the per-boundary buffer size (1), not a cumulative
        # count — no unbounded growth across in-place compaction cycles.
        self.assertTrue(all(c["turn_end"] == 1 for c in extract_calls))


class _ScriptedReader:
    """Readline source that yields pre-built JSON-RPC frames in order."""

    def __init__(self, frames):
        self._lines = [(json.dumps(f) + "\n").encode("utf-8") for f in frames]
        self._i = 0

    def readline(self):
        if self._i >= len(self._lines):
            return b""
        line = self._lines[self._i]
        self._i += 1
        return line


class _FakeProcess:
    """Minimal Popen stand-in: captures stdin writes, scripts stdout reads."""

    def __init__(self, responses):
        self.stdin = io.BytesIO()
        self.stdout = _ScriptedReader(responses)
        self.terminated = False
        self._returncode = None

    def poll(self):
        return self._returncode

    def terminate(self):
        self.terminated = True
        self._returncode = 0

    def wait(self, timeout=None):
        self._returncode = 0
        return 0

    def kill(self):
        self._returncode = -9


class JsonRpcStdioClientTests(unittest.TestCase):
    def test_request_correlates_by_id_and_skips_noise(self):
        writer = io.BytesIO()
        # A notification (no id) and a mismatched id must be skipped before
        # the matching response is returned.
        reader = _ScriptedReader(
            [
                {"jsonrpc": "2.0", "method": "notifications/progress"},
                {"jsonrpc": "2.0", "id": 999, "result": {"stale": True}},
                {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}},
            ]
        )
        client = JsonRpcStdioClient(writer, reader)
        result = client.request("ping", {})
        self.assertEqual(result, {"ok": True})
        sent = json.loads(writer.getvalue().strip().splitlines()[0])
        self.assertEqual(sent["method"], "ping")
        self.assertEqual(sent["id"], 1)

    def test_error_response_raises(self):
        reader = _ScriptedReader(
            [{"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "nope"}}]
        )
        client = JsonRpcStdioClient(io.BytesIO(), reader)
        with self.assertRaises(BridgeError):
            client.request("missing", {})

    def test_eof_raises(self):
        client = JsonRpcStdioClient(io.BytesIO(), _ScriptedReader([]))
        with self.assertRaises(BridgeError):
            client.request("ping", {})


class McpBrainBridgeTests(unittest.TestCase):
    def _handshake_frames(self, extra=None):
        frames = [
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18"}},
            {
                "jsonrpc": "2.0",
                "id": 2,
                "result": {"tools": [{"name": "brain_query"}, {"name": "brain_note"}]},
            },
        ]
        if extra:
            frames.extend(extra)
        return frames

    def test_start_runs_handshake_and_lists_tools(self):
        proc = _FakeProcess(self._handshake_frames())
        bridge = McpBrainBridge(vault="/v", spawn=lambda argv: proc)
        bridge.start()
        names = [t["name"] for t in bridge.list_tools()]
        self.assertEqual(names, ["brain_query", "brain_note"])
        # initialize then tools/list were written; argv carried the vault.
        methods = [json.loads(line)["method"] for line in proc.stdin.getvalue().splitlines()]
        self.assertEqual(methods[0], "initialize")
        self.assertIn("notifications/initialized", methods)
        self.assertIn("tools/list", methods)

    def test_call_tool_forwards_name_and_arguments(self):
        extra = [{"jsonrpc": "2.0", "id": 3, "result": {"content": "ok"}}]
        proc = _FakeProcess(self._handshake_frames(extra))
        bridge = McpBrainBridge(vault="/v", spawn=lambda argv: proc)
        bridge.start()
        result = bridge.call_tool("brain_query", {"q": "x"})
        self.assertEqual(result, {"content": "ok"})
        last = json.loads(proc.stdin.getvalue().splitlines()[-1])
        self.assertEqual(last["method"], "tools/call")
        self.assertEqual(last["params"], {"name": "brain_query", "arguments": {"q": "x"}})

    def test_argv_includes_vault(self):
        captured = {}

        def spy(argv):
            captured["argv"] = argv
            return _FakeProcess(self._handshake_frames())

        McpBrainBridge(vault="/my/vault", spawn=spy).start()
        self.assertIn("--vault", captured["argv"])
        self.assertIn("/my/vault", captured["argv"])

    def test_argv_includes_repo_root(self):
        captured = {}

        def spy(argv):
            captured["argv"] = argv
            return _FakeProcess(self._handshake_frames())

        McpBrainBridge(vault="/v", repo_root="/my/repo", spawn=spy).start()
        self.assertIn("--repo", captured["argv"])
        self.assertIn("/my/repo", captured["argv"])

    def test_argv_omits_repo_when_unset(self):
        captured = {}

        def spy(argv):
            captured["argv"] = argv
            return _FakeProcess(self._handshake_frames())

        McpBrainBridge(vault="/v", spawn=spy).start()
        self.assertNotIn("--repo", captured["argv"])

    def test_stop_terminates_process(self):
        proc = _FakeProcess(self._handshake_frames())
        bridge = McpBrainBridge(vault="/v", spawn=lambda argv: proc)
        bridge.start()
        bridge.stop()
        self.assertTrue(proc.terminated)

    def _counting_spawn(self, *procs):
        it = iter(procs)
        state = {"n": 0}

        def spawn(argv):
            state["n"] += 1
            return next(it)

        spawn.state = state
        return spawn

    def test_tool_error_response_propagates_without_restart(self):
        # A JSON-RPC error (e.g. invalid arguments) is a server rejection, not
        # a dead channel: it must propagate and must not respawn the process.
        err = [{"jsonrpc": "2.0", "id": 3, "error": {"code": -32602, "message": "bad args"}}]
        spawn = self._counting_spawn(_FakeProcess(self._handshake_frames(err)))
        bridge = McpBrainBridge(vault="/v", spawn=spawn)
        bridge.start()
        with self.assertRaises(BridgeError) as ctx:
            bridge.call_tool("brain_query", {})
        self.assertNotIsInstance(ctx.exception, BridgeTransportError)
        self.assertEqual(spawn.state["n"], 1)

    def test_transport_error_restarts_once_and_retries(self):
        # First process dies mid-call (EOF); the bridge restarts once and the
        # second process answers.
        dead = _FakeProcess(self._handshake_frames())  # no id-3 frame -> EOF
        good = _FakeProcess(
            self._handshake_frames([{"jsonrpc": "2.0", "id": 3, "result": {"ok": True}}])
        )
        spawn = self._counting_spawn(dead, good)
        bridge = McpBrainBridge(vault="/v", spawn=spawn)
        bridge.start()
        result = bridge.call_tool("brain_query", {"topic": "x"})
        self.assertEqual(result, {"ok": True})
        self.assertEqual(spawn.state["n"], 2)

    def test_transport_error_retries_through_failed_restart(self):
        # Regression: a restart whose OWN handshake dies must not abort the
        # retry loop. dead-on-call -> dead-on-handshake -> good. The middle
        # child EOFs during initialize, so _restart() raises; the loop must
        # capture that and still reach the third, healthy child.
        first = _FakeProcess(self._handshake_frames())  # no id-3 -> EOF on the call
        broken = _FakeProcess([])  # EOF during handshake -> _restart() raises
        good = _FakeProcess(
            self._handshake_frames([{"jsonrpc": "2.0", "id": 3, "result": {"ok": True}}])
        )
        spawn = self._counting_spawn(first, broken, good)
        bridge = McpBrainBridge(vault="/v", spawn=spawn)
        bridge.start()
        result = bridge.call_tool("brain_query", {"topic": "x"})
        self.assertEqual(result, {"ok": True})
        self.assertEqual(spawn.state["n"], 3)


class FakeBrainBridgeTests(unittest.TestCase):
    def test_records_calls_and_returns_canned_results(self):
        bridge = FakeBrainBridge(
            tools=[{"name": "brain_query"}],
            results={"brain_query": {"items": []}},
        )
        bridge.start()
        self.assertTrue(bridge.started)
        self.assertEqual(bridge.list_tools(), [{"name": "brain_query"}])
        self.assertEqual(bridge.call_tool("brain_query", {"q": "x"}), {"items": []})
        self.assertEqual(bridge.calls, [("brain_query", {"q": "x"})])
        bridge.stop()
        self.assertTrue(bridge.stopped)


if __name__ == "__main__":
    unittest.main()
