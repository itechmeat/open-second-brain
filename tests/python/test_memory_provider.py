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
from plugins.hermes._base import MemoryProvider  # noqa: E402
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
    def test_memory_provider_is_subclassable(self):
        class Demo(MemoryProvider):
            @property
            def name(self):
                return "demo"

        demo = Demo()
        self.assertEqual(demo.name, "demo")

    def test_optional_hooks_are_noop_on_base(self):
        class Demo(MemoryProvider):
            @property
            def name(self):
                return "demo"

        demo = Demo()
        # Optional lifecycle hooks the provider may not override must not raise.
        self.assertIsNone(demo.queue_prefetch("q"))
        self.assertIsNone(demo.on_session_end([]))
        self.assertIsNone(demo.shutdown())


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
        self.assertEqual(result, {"ok": True})
        self.assertEqual(bridge.calls, [("brain_note", {"text": "hi"})])

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

    def test_on_memory_write_mirrors_to_brain_note(self):
        bridge = FakeBrainBridge(results={"brain_note": {"structuredContent": {}}})
        provider = self._init(bridge, hermes_home="/tmp/hh")
        provider.on_memory_write("update", "MEMORY.md", "remember the vault path")
        note_calls = [a for n, a in bridge.calls if n == "brain_note"]
        self.assertEqual(len(note_calls), 1)
        self.assertIn("MEMORY.md", note_calls[0]["text"])
        self.assertIn("remember the vault path", note_calls[0]["text"])

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
        provider.on_memory_write("update", "USER.md", "x")
        provider.shutdown()


class _ScriptedReader:
    """Readline source that yields pre-built JSON-RPC frames in order."""

    def __init__(self, frames):
        self._lines = [json.dumps(f) + "\n" for f in frames]
        self._i = 0

    def readline(self):
        if self._i >= len(self._lines):
            return ""
        line = self._lines[self._i]
        self._i += 1
        return line


class _FakeProcess:
    """Minimal Popen stand-in: captures stdin writes, scripts stdout reads."""

    def __init__(self, responses):
        self.stdin = io.StringIO()
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
        writer = io.StringIO()
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
        client = JsonRpcStdioClient(io.StringIO(), reader)
        with self.assertRaises(BridgeError):
            client.request("missing", {})

    def test_eof_raises(self):
        client = JsonRpcStdioClient(io.StringIO(), _ScriptedReader([]))
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
