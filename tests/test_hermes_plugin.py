import importlib.util
import sys
import unittest
from pathlib import Path

from plugins.hermes import check_health, health, register


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


if __name__ == "__main__":
    unittest.main()
