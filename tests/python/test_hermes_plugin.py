"""Tests for the Hermes plugin package surface.

The package now registers a native memory provider and a data-only health
check; the legacy per-turn ``pre_llm_call`` hook is retired (its identity
reminder moved into the provider's ``prefetch``). These tests pin the package
contract Hermes relies on: ``register`` wiring, the health report, the root
entrypoint re-export, and the identity-reminder template source of truth.
"""

import importlib.util
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from plugins.hermes import check_health, health, register, register_cli  # noqa: E402
from plugins.hermes import config as cfg  # noqa: E402
from plugins.hermes.provider import OpenSecondBrainMemoryProvider  # noqa: E402

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
    therefore the entry the gateway sees first; it must re-export the same
    callable names this package exposes.
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

    def test_registers_memory_provider(self):
        registered: list[object] = []

        class Context:
            def register_memory_provider(self, provider):
                registered.append(provider)

        register(Context())
        self.assertEqual(len(registered), 1)
        self.assertIsInstance(registered[0], OpenSecondBrainMemoryProvider)
        self.assertEqual(registered[0].name, PLUGIN_NAME)


class HermesLoaderContractTests(unittest.TestCase):
    """Locks the entrypoint against the updated Hermes loader contract.

    Since hermes-agent PR #37366 the external memory-provider loader
    registers the synthetic ``_hermes_user_memory`` parent namespace in
    ``sys.modules`` before executing a user-installed plugin, so the
    entrypoint uses ordinary relative imports (no file-path self-bootstrap).
    This test mimics that exact loader sequence - parent shell registered,
    plugin executed under the synthetic dotted name - and asserts the
    entrypoint yields a working provider and ``register`` through the
    ``plugins/`` namespace intermediate directory.
    """

    SYNTHETIC_PARENT = "_hermes_user_memory"

    def test_entrypoint_loads_under_synthetic_name_with_parent_registered(self):
        synthetic = f"{self.SYNTHETIC_PARENT}.{PLUGIN_NAME}"
        # Mirror the loader: an empty namespace shell for the parent.
        parent = types.ModuleType(self.SYNTHETIC_PARENT)
        parent.__path__ = []  # mark it a package so child imports resolve
        sys.modules[self.SYNTHETIC_PARENT] = parent
        spec = importlib.util.spec_from_file_location(
            synthetic,
            ROOT / "__init__.py",
            submodule_search_locations=[str(ROOT)],
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[synthetic] = module
        try:
            spec.loader.exec_module(module)
            provider = module.OpenSecondBrainMemoryProvider()
            self.assertEqual(provider.name, PLUGIN_NAME)
            self.assertTrue(callable(module.register))
            self.assertTrue(callable(module.register_cli))
        finally:
            for name in list(sys.modules):
                if name == self.SYNTHETIC_PARENT or name.startswith(self.SYNTHETIC_PARENT + "."):
                    sys.modules.pop(name, None)

    def test_entrypoint_has_no_selfbootstrap_machinery(self):
        """The crutch is gone: no private package name, no file-path import."""
        source = (ROOT / "__init__.py").read_text(encoding="utf-8")
        self.assertNotIn("_osb_hermes_impl", source)
        self.assertNotIn("spec_from_file_location", source)
        self.assertIn("from .plugins.hermes import", source)

    def test_root_cli_shim_loads_through_the_lightweight_scan(self):
        """Mirror ``discover_plugin_cli_commands()`` for a user plugin.

        The scan imports ``<plugin_root>/cli.py`` as
        ``_hermes_user_memory.<name>.cli`` after registering the synthetic
        parent packages (the parent shell carries the plugin dir as its
        search location) and never executes the root ``__init__.py``. The
        root ``cli.py`` shim must resolve ``register_cli`` through that
        exact sequence and wire an argparse subtree.
        """
        import argparse

        synthetic_cli = f"{self.SYNTHETIC_PARENT}.{PLUGIN_NAME}.cli"
        # Parent shells exactly as the loader registers them: the namespace
        # root with no search locations, the per-provider shell with the
        # plugin directory.
        for mod_name, locations in (
            (self.SYNTHETIC_PARENT, []),
            (f"{self.SYNTHETIC_PARENT}.{PLUGIN_NAME}", [str(ROOT)]),
        ):
            spec = importlib.util.spec_from_loader(mod_name, loader=None, is_package=True)
            spec.submodule_search_locations = locations
            sys.modules[mod_name] = importlib.util.module_from_spec(spec)
        spec = importlib.util.spec_from_file_location(synthetic_cli, ROOT / "cli.py")
        cli_mod = importlib.util.module_from_spec(spec)
        sys.modules[synthetic_cli] = cli_mod
        try:
            spec.loader.exec_module(cli_mod)
            self.assertTrue(callable(cli_mod.register_cli))
            self.assertTrue(callable(cli_mod.run))
            parser = argparse.ArgumentParser()
            sub = parser.add_subparsers().add_parser(PLUGIN_NAME)
            cli_mod.register_cli(sub)  # must not raise
        finally:
            for name in list(sys.modules):
                if name == self.SYNTHETIC_PARENT or name.startswith(self.SYNTHETIC_PARENT + "."):
                    sys.modules.pop(name, None)

    def test_register_does_not_raise_on_minimal_context(self):
        class Context:
            pass

        # A ctx exposing neither hook must be ignored, not fatal.
        register(Context())

    def test_register_cli_is_reexported(self):
        # Hermes may discover CLI registration at package level; keep it exported.
        self.assertTrue(callable(register_cli))

    def test_no_pre_llm_call_hook_registered(self):
        registered: list[str] = []

        class Context:
            def register_hook(self, name, callback):
                registered.append(name)

            def register_memory_provider(self, provider):
                pass

        register(Context())
        self.assertNotIn("pre_llm_call", registered)


class TemplateSourceOfTruthTests(unittest.TestCase):
    """The reminder text lives in ``templates/identity-reminder*.txt`` so the
    Python provider and the TypeScript core do not drift apart. These tests
    pin the file's location, shape, and per-target parity with the shared
    fixture asserted on the TypeScript side.
    """

    def setUp(self):
        cfg._reset_template_cache_for_tests()

    def tearDown(self):
        cfg._reset_template_cache_for_tests()

    def test_template_file_exists_at_canonical_path(self):
        path = ROOT / "templates" / "identity-reminder.txt"
        self.assertTrue(path.is_file(), f"missing canonical reminder template: {path}")

    def test_template_uses_two_or_more_agent_placeholders(self):
        path = ROOT / "templates" / "identity-reminder.txt"
        text = path.read_text(encoding="utf-8")
        self.assertGreaterEqual(text.count("{agent}"), 2)

    def test_render_reminder_substitutes_every_placeholder(self):
        rendered = cfg.render_reminder("parity-agent")
        self.assertIn("@parity-agent", rendered)
        self.assertNotIn("{agent}", rendered)

    def test_hermes_template_matches_shared_fixture(self):
        fixture = (
            (ROOT / "tests" / "fixtures" / "identity-reminder" / "hermes.txt")
            .read_text(encoding="utf-8")
            .rstrip()
        )
        rendered = cfg.load_reminder_template().replace("{agent}", "test-agent")
        self.assertEqual(rendered, fixture)

    def test_hermes_template_prefers_per_target_over_common(self):
        self.assertIn("Hermes turns are short", cfg.load_reminder_template())


if __name__ == "__main__":
    unittest.main()
