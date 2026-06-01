"""Tests for the native Hermes memory provider and its bridge.

The provider subclasses the Hermes ``MemoryProvider`` ABC when running inside
a Hermes install, and a local fallback base otherwise (so this repo's CI can
exercise it without Hermes present). All deterministic work is delegated to
the TypeScript core through a ``BrainBridge`` seam, which tests replace with a
fake so no live Bun runtime is needed.
"""

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


if __name__ == "__main__":
    unittest.main()
