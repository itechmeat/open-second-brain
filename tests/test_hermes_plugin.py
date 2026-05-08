import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

from plugins.hermes import check_health, health, on_pre_llm_call, register


ROOT = Path(__file__).resolve().parents[1]


class HermesPluginTests(unittest.TestCase):
    def test_health_report_checks_repo_artifacts(self):
        report = health(ROOT)
        self.assertTrue(report["ok"], report)
        self.assertIn("claude_manifest", report["checks"])
        self.assertIn("codex_manifest", report["checks"])
        self.assertIn("openclaw_manifest", report["checks"])
        self.assertIn("o2b_script", report["checks"])

    def test_check_health_alias(self):
        self.assertEqual(check_health(ROOT)["name"], "open-second-brain")

    def test_root_plugin_entrypoint_loads_like_hermes_git_install(self):
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
            self.assertEqual(module.check_health(ROOT)["name"], "open-second-brain")
        finally:
            sys.modules.pop(spec.name, None)

    def test_register_attaches_to_method_context(self):
        calls = []

        class Context:
            def register_health_check(self, name, callback):
                calls.append((name, callback))

        register(Context())
        self.assertEqual(calls[0][0], "open-second-brain")
        self.assertTrue(calls[0][1](ROOT)["ok"])

    def test_register_attaches_to_dict_context(self):
        class Context:
            def __init__(self):
                self.health_checks = {}

        ctx = Context()
        register(ctx)
        self.assertIn("open-second-brain", ctx.health_checks)

    def test_register_calls_register_hook_for_pre_llm_call(self):
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
    """Verify the pre_llm_call hook contract toward Hermes.

    The hook fires every turn and must:
      - return ``{"context": "..."}`` when identity is configured
      - return ``None`` (no inject) when identity is unresolved
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

    def test_pre_llm_call_returns_context_when_env_identity_set(self):
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

    def test_pre_llm_call_returns_context_from_persisted_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            cfg.write_text('agent_name: "openclaw-main"\n', encoding="utf-8")
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(cfg)
            result = on_pre_llm_call()
        self.assertIsInstance(result, dict)
        self.assertIn("@openclaw-main", result["context"])

    def test_pre_llm_call_returns_none_when_identity_unresolved(self):
        # No env, no config → fallback hits the literal "agent" placeholder.
        # The hook must skip injection instead of telling the LLM "you are
        # @agent", which would be misleading.
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OPEN_SECOND_BRAIN_CONFIG"] = str(
                Path(tmp) / "missing.yaml"
            )
            result = on_pre_llm_call()
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
