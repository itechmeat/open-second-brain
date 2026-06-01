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
    FakeBrainBridge,
    JsonRpcStdioClient,
    McpBrainBridge,
)


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
