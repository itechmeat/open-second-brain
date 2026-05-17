"""Tests for the slim Hermes Python shim.

The shim only handles the per-turn ``pre_llm_call`` injection and a small
data-only health report; everything else lives in the TypeScript core
exposed through the MCP server. These tests pin the contract Hermes
relies on.
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Ensure ``plugins.hermes`` is importable regardless of which directory the
# test runner is invoked from. Pytest with rootdir at the repo root works
# out of the box; running ``python -m unittest tests.python.test_hermes_plugin``
# from the repo root also works because ``plugins/hermes/__init__.py`` is on
# the path. The legacy invocation ``python -m unittest discover -s tests``
# would not find ``plugins`` without the explicit insert; the shim's
# import is small enough that we keep it self-contained.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from plugins.hermes import (  # noqa: E402
    _load_reminder_template,
    check_health,
    health,
    on_pre_llm_call,
    register,
)

PLUGIN_NAME = "open-second-brain"


class HealthReportTests(unittest.TestCase):
    def test_health_reports_repo_artifacts(self):
        report = health(ROOT)
        self.assertEqual(report["name"], PLUGIN_NAME)
        self.assertIn("o2b_script", report["checks"])
        self.assertIn("openclaw_bundle", report["checks"])
        self.assertIn("package_json", report["checks"])

    def test_check_health_alias_returns_same_shape(self):
        self.assertEqual(check_health(ROOT)["name"], PLUGIN_NAME)


class RootPluginEntrypointTests(unittest.TestCase):
    """Hermes installs Git plugins by cloning the repo and loading the
    repository root as the plugin directory. The root ``__init__.py`` is
    therefore the entry the gateway sees first; it must re-export the
    same callable names this shim exposes.
    """

    def test_root_init_exposes_check_health(self):
        spec = importlib.util.spec_from_file_location(
            "open_second_brain_plugin_test",
            ROOT / "__init__.py",
            submodule_search_locations=[str(ROOT)],
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        try:
            spec.loader.exec_module(module)
            self.assertEqual(module.check_health(ROOT)["name"], PLUGIN_NAME)
        finally:
            sys.modules.pop(spec.name, None)


class RegisterTests(unittest.TestCase):
    def test_attaches_via_register_health_check(self):
        calls: list[tuple[str, object]] = []

        class Context:
            def register_health_check(self, name, callback):
                calls.append((name, callback))

        register(Context())
        self.assertEqual(calls[0][0], PLUGIN_NAME)
        self.assertTrue(calls[0][1](ROOT)["name"] == PLUGIN_NAME)

    def test_attaches_via_health_checks_dict(self):
        class Context:
            def __init__(self):
                self.health_checks: dict[str, object] = {}

        ctx = Context()
        register(ctx)
        self.assertIn(PLUGIN_NAME, ctx.health_checks)

    def test_register_hook_called_for_pre_llm_call(self):
        registered: list[tuple[str, object]] = []

        class Context:
            def register_hook(self, name, callback):
                registered.append((name, callback))

        register(Context())
        self.assertEqual(len(registered), 1)
        name, callback = registered[0]
        self.assertEqual(name, "pre_llm_call")
        self.assertIs(callback, on_pre_llm_call)


class PreLlmCallTests(unittest.TestCase):
    """The hook fires every turn and must:

      - return ``{"context": "..."}`` when identity is configured
      - return ``None`` (no injection) when identity is unresolved
      - never raise
    """

    def setUp(self):
        self._prev_env = os.environ.pop("VAULT_AGENT_NAME", None)
        self._prev_cfg = os.environ.pop("OPEN_SECOND_BRAIN_CONFIG", None)

    def tearDown(self):
        os.environ.pop("VAULT_AGENT_NAME", None)
        os.environ.pop("OPEN_SECOND_BRAIN_CONFIG", None)
        if self._prev_env is not None:
            os.environ["VAULT_AGENT_NAME"] = self._prev_env
        if self._prev_cfg is not None:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = self._prev_cfg

    def test_returns_context_when_env_identity_set(self):
        os.environ["VAULT_AGENT_NAME"] = "hermes-vps-agent"
        result = on_pre_llm_call(
            session_id="test",
            user_message="hello",
            conversation_history=[],
            is_first_turn=True,
            model="combo",
            platform="cli",
            sender_id="",
        )
        self.assertIsInstance(result, dict)
        self.assertIn("context", result)
        ctx = result["context"]
        self.assertIn("@hermes-vps-agent", ctx)
        self.assertIn("event_log_append", ctx)

    def test_returns_context_from_persisted_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            cfg.write_text('agent_name: "openclaw-main"\n', encoding="utf-8")
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(cfg)
            result = on_pre_llm_call()
        self.assertIsInstance(result, dict)
        self.assertIn("@openclaw-main", result["context"])

    def test_returns_context_with_camelcase_config_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            cfg.write_text('agentName: "codex-vps-agent"\n', encoding="utf-8")
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(cfg)
            result = on_pre_llm_call()
        self.assertIsInstance(result, dict)
        self.assertIn("@codex-vps-agent", result["context"])

    def test_returns_none_when_identity_unresolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(Path(tmp) / "missing.yaml")
            result = on_pre_llm_call()
        self.assertIsNone(result)


class TemplateSourceOfTruthTests(unittest.TestCase):
    """The reminder text lives in `templates/identity-reminder.txt` so the
    Python shim and the TypeScript core do not drift apart. These tests
    pin the file's location and shape; both runtimes must keep loading it.
    """

    def test_template_file_exists_at_canonical_path(self):
        path = ROOT / "templates" / "identity-reminder.txt"
        self.assertTrue(path.is_file(), f"missing canonical reminder template: {path}")

    def test_template_uses_two_or_more_agent_placeholders(self):
        path = ROOT / "templates" / "identity-reminder.txt"
        text = path.read_text(encoding="utf-8")
        self.assertGreaterEqual(text.count("{agent}"), 2)

    def test_pre_llm_call_substitutes_every_placeholder(self):
        os.environ["VAULT_AGENT_NAME"] = "parity-agent"
        try:
            result = on_pre_llm_call()
        finally:
            os.environ.pop("VAULT_AGENT_NAME", None)
        self.assertIsNotNone(result)
        self.assertIn("@parity-agent", result["context"])
        self.assertNotIn("{agent}", result["context"])


class PerTargetParityTests(unittest.TestCase):
    """Python and TypeScript must produce the same bytes for the Hermes
    target. The shared fixture at
    ``tests/fixtures/identity-reminder/hermes.txt`` is asserted by the
    TS resolver test; this test asserts the Python shim against the same
    bytes. If the two drift, both languages' CI fails.
    """

    def test_hermes_template_matches_shared_fixture(self):
        fixture = (
            ROOT / "tests" / "fixtures" / "identity-reminder" / "hermes.txt"
        ).read_text(encoding="utf-8").rstrip()
        rendered = _load_reminder_template().replace("{agent}", "test-agent")
        self.assertEqual(rendered, fixture)

    def test_hermes_template_prefers_per_target_over_common(self):
        body = _load_reminder_template()
        self.assertIn("Hermes turns are short", body)


if __name__ == "__main__":
    unittest.main()
