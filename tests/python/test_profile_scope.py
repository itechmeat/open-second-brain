"""Two-mode settings for the Hermes plugin on a multiplexed gateway.

A Hermes gateway with ``multiplex_profiles`` serves several profiles from one
process, and the process environment belongs to the launch profile. Under
multiplexing every profile-scoped setting must therefore come from the turn's
profile scope (``agent.secret_scope``), never from ``os.environ``; without
multiplexing the plugin must answer exactly as it always has.

Hermes is not installed in CI, so a fake ``agent.secret_scope`` is injected
through ``sys.modules``. ``config.py`` imports it lazily per call, so the stub
takes effect without reloading anything.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from plugins.hermes import bridge as bridge_module  # noqa: E402
from plugins.hermes import config as cfg  # noqa: E402
from plugins.hermes import provider as provider_module  # noqa: E402
from plugins.hermes.bridge import FakeBrainBridge, McpBrainBridge  # noqa: E402
from plugins.hermes.provider import OpenSecondBrainMemoryProvider  # noqa: E402

# Process-environment values that belong to the LAUNCH profile. None of them
# may surface under multiplexing, in a result or in a message.
LAUNCH_VALUES = {
    "VAULT_DIR": "launch-vault-dir-value",
    "VAULT_AGENT_NAME": "launch-agent-value",
    "VAULT_TIMEZONE": "Launch/Zone",
    "OPEN_SECOND_BRAIN_CONFIG": "launch-config-path-value.yaml",
    "OPEN_SECOND_BRAIN_MCP_TIMEOUT": "4242",
}

_ISOLATED_ENV = (*LAUNCH_VALUES.keys(), cfg.XDG_CONFIG_HOME_ENV)


class FakeUnscopedError(RuntimeError):
    """Stands in for Hermes's ``UnscopedSecretError``."""


def make_fake_scope(*, multiplexed: bool, values: dict | None = None, unbound: bool = False):
    """A fake ``agent`` package and ``agent.secret_scope`` module.

    ``reads`` records every name the plugin asked the scope for, so a test can
    prove the scope was (or was not) consulted.
    """
    pkg = types.ModuleType("agent")
    pkg.__path__ = []
    fake = types.ModuleType("agent.secret_scope")
    scoped_values = dict(values or {})
    reads: list[str] = []

    def is_multiplex_active() -> bool:
        return multiplexed

    def get_secret(name, default=None):
        reads.append(name)
        if unbound:
            raise FakeUnscopedError(f"{name} has no bound profile scope")
        return scoped_values.get(name, default)

    fake.is_multiplex_active = is_multiplex_active
    fake.get_secret = get_secret
    fake.UnscopedSecretError = FakeUnscopedError
    fake.reads = reads
    pkg.secret_scope = fake
    return pkg, fake


class ScopeTestCase(unittest.TestCase):
    """Isolates every scoped name and the XDG directory per test."""

    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in _ISOLATED_ENV}
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        reset = getattr(cfg, "_reset_scope_warnings_for_tests", None)
        if reset is not None:
            reset()

    def tearDown(self):
        for k in _ISOLATED_ENV:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]
        self._tmp.cleanup()
        reset = getattr(cfg, "_reset_scope_warnings_for_tests", None)
        if reset is not None:
            reset()

    def install(self, fake_pair):
        pkg, fake = fake_pair
        return patch.dict(sys.modules, {"agent": pkg, "agent.secret_scope": fake})

    def no_hermes(self):
        # A ``None`` entry makes the import raise ImportError, whatever is on
        # the machine running the suite.
        return patch.dict(sys.modules, {"agent": None, "agent.secret_scope": None})

    def set_launch_env(self):
        os.environ.update(LAUNCH_VALUES)

    def write_xdg_config(self, body: str) -> Path:
        xdg = self.tmp / "xdg"
        path = xdg / cfg.PLUGIN_NAME / cfg.CONFIG_FILENAME
        path.parent.mkdir(parents=True)
        path.write_text(body, encoding="utf-8")
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(xdg)
        return path


class ContractTests(unittest.TestCase):
    def test_scoped_names_are_the_five_profile_settings(self):
        self.assertEqual(
            cfg.PROFILE_SCOPED_ENV,
            (
                "VAULT_DIR",
                "VAULT_AGENT_NAME",
                "VAULT_TIMEZONE",
                "OPEN_SECOND_BRAIN_CONFIG",
                "OPEN_SECOND_BRAIN_MCP_TIMEOUT",
            ),
        )
        self.assertEqual(cfg.REQUEST_TIMEOUT_ENV, "OPEN_SECOND_BRAIN_MCP_TIMEOUT")

    def test_os_level_variables_are_not_scoped(self):
        for name in ("XDG_CONFIG_HOME", "LOCALAPPDATA", "PATH", "PATHEXT", "HOME"):
            self.assertNotIn(name, cfg.PROFILE_SCOPED_ENV)

    def test_config_directories_are_scope_first(self):
        self.assertEqual(cfg.SCOPE_FIRST_ENV, ("XDG_CONFIG_HOME", "LOCALAPPDATA"))


class WithoutHermesTests(ScopeTestCase):
    """(a) No ``agent.secret_scope``: today's answers."""

    def test_not_multiplexed_and_process_environment_answers(self):
        self.set_launch_env()
        with self.no_hermes():
            self.assertFalse(cfg.is_multiplexed())
            self.assertEqual(cfg.resolve_agent_name(), "launch-agent-value")
            self.assertEqual(cfg.resolve_vault(str(self.tmp)), "launch-vault-dir-value")
            self.assertEqual(cfg.resolve_timezone(), "Launch/Zone")
            self.assertEqual(cfg.config_path(), Path("launch-config-path-value.yaml"))
            self.assertEqual(cfg.env_setting("VAULT_AGENT_NAME"), "launch-agent-value")

    def test_empty_value_counts_as_unset(self):
        os.environ["VAULT_AGENT_NAME"] = ""
        with self.no_hermes():
            self.assertIsNone(cfg.env_setting("VAULT_AGENT_NAME"))


class BrokenScopeModuleTests(ScopeTestCase):
    """A Hermes scope module that is present but fails to import fails closed."""

    def _hermes_on_path(self, secret_scope_source: str | None):
        """A real ``agent`` package on ``sys.path``; ``None`` omits ``secret_scope``."""
        root = Path(tempfile.mkdtemp(prefix="hermes-src-", dir=self.tmp))
        package = root / "agent"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("", encoding="utf-8")
        if secret_scope_source is not None:
            (package / "secret_scope.py").write_text(secret_scope_source, encoding="utf-8")
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(sys, "path", [str(root), *sys.path]))
        stack.enter_context(patch.dict(sys.modules))
        for name in ("agent", "agent.secret_scope"):
            sys.modules.pop(name, None)
        return stack

    def test_a_failing_import_refuses_scoped_reads_and_warns_once_by_type(self):
        self.set_launch_env()
        failures = {
            "RuntimeError": "raise RuntimeError('launch-vault-dir-value')\n",
            "ModuleNotFoundError": "import o2b_hermes_dependency_that_is_absent\n",
        }
        for type_name, source in failures.items():
            with self.subTest(failure=type_name):
                cfg._reset_scope_warnings_for_tests()
                with (
                    self._hermes_on_path(source),
                    self.assertLogs("plugins.hermes.config", "WARNING") as logs,
                ):
                    self.assertTrue(cfg.is_multiplexed())
                    with self.assertRaises(cfg.ProfileScopeError):
                        cfg.resolve_agent_name()
                    with self.assertRaises(cfg.ProfileScopeError):
                        cfg.config_path()
                    self.assertEqual(cfg.env_setting("PATH"), os.environ.get("PATH") or None)
                failed = [
                    r.getMessage() for r in logs.records if "failed to import" in r.getMessage()
                ]
                self.assertEqual(len(failed), 1)
                self.assertIn(type_name, failed[0])
                for value in LAUNCH_VALUES.values():
                    self.assertNotIn(value, failed[0])

    def test_a_failed_import_is_tried_once_until_reset(self):
        calls = []

        def failing_import(name, *args, **kwargs):
            calls.append(name)
            raise ImportError("scope module is broken")

        with (
            patch.object(cfg.importlib, "import_module", side_effect=failing_import),
            self.assertLogs("plugins.hermes.config", "WARNING"),
        ):
            for _ in range(2):
                with self.assertRaises(cfg.ProfileScopeError):
                    cfg.env_setting("VAULT_AGENT_NAME")
            self.assertEqual(calls, [cfg._SCOPE_MODULE_NAME])
            cfg._reset_scope_warnings_for_tests()
            with self.assertRaises(cfg.ProfileScopeError):
                cfg.env_setting("VAULT_AGENT_NAME")
            self.assertEqual(len(calls), 2)

    def test_a_hermes_without_the_scope_module_reads_the_process_environment(self):
        self.set_launch_env()
        with self._hermes_on_path(None), self.assertNoLogs("plugins.hermes.config", "WARNING"):
            self.assertFalse(cfg.is_multiplexed())
            self.assertEqual(cfg.resolve_agent_name(), "launch-agent-value")


class MultiplexOffTests(ScopeTestCase):
    """(b) Hermes present, multiplexing off: the process environment wins."""

    def test_process_environment_answers_and_the_scope_is_never_read(self):
        self.set_launch_env()
        pair = make_fake_scope(multiplexed=False, values={"VAULT_AGENT_NAME": "scoped-agent"})
        with self.install(pair):
            self.assertFalse(cfg.is_multiplexed())
            self.assertEqual(cfg.resolve_agent_name(), "launch-agent-value")
            self.assertEqual(cfg.resolve_vault(str(self.tmp)), "launch-vault-dir-value")
            self.assertEqual(cfg.resolve_timezone(), "Launch/Zone")
            self.assertEqual(cfg.config_path(), Path("launch-config-path-value.yaml"))
        self.assertEqual(pair[1].reads, [])


class MultiplexedScopeTests(ScopeTestCase):
    """(c) Multiplexed with a bound scope: scoped values beat the launch env."""

    def test_scoped_values_beat_conflicting_process_values(self):
        self.set_launch_env()
        scoped_config = self.tmp / "scoped.yaml"
        pair = make_fake_scope(
            multiplexed=True,
            values={
                "VAULT_DIR": "scoped-vault",
                "VAULT_AGENT_NAME": "scoped-agent",
                "VAULT_TIMEZONE": "Europe/Paris",
                "OPEN_SECOND_BRAIN_CONFIG": str(scoped_config),
                "OPEN_SECOND_BRAIN_MCP_TIMEOUT": "7",
            },
        )
        with self.install(pair):
            self.assertTrue(cfg.is_multiplexed())
            self.assertEqual(cfg.resolve_vault(str(self.tmp)), "scoped-vault")
            self.assertEqual(cfg.resolve_agent_name(), "scoped-agent")
            self.assertEqual(cfg.resolve_timezone(), "Europe/Paris")
            self.assertEqual(cfg.config_path(), scoped_config)
            self.assertEqual(cfg.env_setting("OPEN_SECOND_BRAIN_MCP_TIMEOUT"), "7")

    def test_config_directories_fall_back_to_the_process_when_the_scope_has_none(self):
        xdg = self.tmp / "xdg"
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(xdg)
        pair = make_fake_scope(multiplexed=True)
        with self.install(pair):
            self.assertEqual(cfg.config_path(), xdg / cfg.PLUGIN_NAME / cfg.CONFIG_FILENAME)
        self.assertIn(cfg.XDG_CONFIG_HOME_ENV, pair[1].reads)

    def test_the_scope_config_directory_beats_the_process_one(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "launch-xdg")
        scoped = self.tmp / "profile-xdg"
        pair = make_fake_scope(multiplexed=True, values={"XDG_CONFIG_HOME": str(scoped)})
        with self.install(pair):
            self.assertEqual(cfg.config_path(), scoped / cfg.PLUGIN_NAME / cfg.CONFIG_FILENAME)

    def test_the_scope_local_app_data_beats_the_process_one(self):
        scoped = self.tmp / "profile-local"
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.tmp / "launch-local")}):
            pair = make_fake_scope(multiplexed=True, values={"LOCALAPPDATA": str(scoped)})
            with self.install(pair):
                self.assertEqual(cfg._windows_local_app_data(), scoped)
            empty = make_fake_scope(multiplexed=True)
            with self.install(empty):
                self.assertEqual(cfg._windows_local_app_data(), self.tmp / "launch-local")
            off = make_fake_scope(multiplexed=False, values={"LOCALAPPDATA": str(scoped)})
            with self.install(off):
                self.assertEqual(cfg._windows_local_app_data(), self.tmp / "launch-local")
            self.assertEqual(off[1].reads, [])

    def test_unbound_scope_refuses_the_config_directories(self):
        pair = make_fake_scope(multiplexed=True, unbound=True)
        with self.install(pair):
            for name in cfg.SCOPE_FIRST_ENV:
                with self.subTest(name=name), self.assertRaises(cfg.ProfileScopeError):
                    cfg.scope_first_setting(name)


class MultiplexedEmptyScopeTests(ScopeTestCase):
    """(d) Multiplexed, empty scope: the config chain answers, never os.environ."""

    def test_falls_through_to_the_config_file(self):
        self.set_launch_env()
        self.write_xdg_config(
            'vault: "config-vault"\nagent_name: "config-agent"\ntimezone: "Asia/Tokyo"\n'
        )
        pair = make_fake_scope(multiplexed=True, values={"VAULT_AGENT_NAME": ""})
        with self.install(pair):
            self.assertEqual(cfg.resolve_vault(str(self.tmp)), "config-vault")
            self.assertEqual(cfg.resolve_agent_name(), "config-agent")
            self.assertEqual(cfg.resolve_timezone(), "Asia/Tokyo")

    def test_falls_through_to_the_defaults(self):
        self.set_launch_env()
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        pair = make_fake_scope(multiplexed=True)
        with self.install(pair):
            self.assertIsNone(cfg.resolve_vault(str(self.tmp)))
            self.assertEqual(cfg.resolve_agent_name(), cfg.DEFAULT_AGENT)
            self.assertIsNone(cfg.resolve_timezone())
            self.assertIsNone(cfg.env_setting("OPEN_SECOND_BRAIN_MCP_TIMEOUT"))


class UnboundScopeTests(ScopeTestCase):
    """(e) Multiplexed with no scope bound: a named, value-free refusal."""

    def test_resolvers_raise_profile_scope_error(self):
        self.set_launch_env()
        pair = make_fake_scope(multiplexed=True, unbound=True)
        for resolver in (lambda: cfg.resolve_vault(str(self.tmp)), cfg.resolve_agent_name):
            with self.subTest(resolver=resolver), self.install(pair):
                with self.assertRaises(cfg.ProfileScopeError) as caught:
                    resolver()
                exc = caught.exception
                self.assertIsInstance(exc, cfg.ConfigReadError)
                self.assertIsInstance(exc.__cause__, FakeUnscopedError)
                self.assertEqual(exc.path, "")
                self.assertEqual(exc.reason, "no profile scope bound")
                self.assertIn(exc.name, cfg.PROFILE_SCOPED_ENV)
                message = str(exc)
                for value in LAUNCH_VALUES.values():
                    self.assertNotIn(value, message)

    def test_message_names_the_setting_and_the_remedy(self):
        exc = cfg.ProfileScopeError("VAULT_AGENT_NAME")
        self.assertEqual(exc.name, "VAULT_AGENT_NAME")
        self.assertEqual(
            str(exc),
            "VAULT_AGENT_NAME cannot be resolved: this multiplexed Hermes gateway bound no "
            "profile scope for the call, and Open Second Brain does not fall back to the "
            "gateway's process environment, which belongs to the launch profile. Restart the "
            "gateway (hermes gateway restart); if it persists, report it.",
        )


class IgnoredProcessValueWarningTests(ScopeTestCase):
    """(c') and (g): one value-free WARNING per ignored name, once per process."""

    def test_one_warning_per_ignored_name_without_its_value(self):
        self.set_launch_env()
        pair = make_fake_scope(multiplexed=True, values={"VAULT_AGENT_NAME": "scoped-agent"})
        with self.install(pair), self.assertLogs("plugins.hermes.config", "WARNING") as logs:
            cfg.resolve_agent_name()
            cfg.resolve_timezone()
        messages = [record.getMessage() for record in logs.records]
        self.assertTrue(any("VAULT_AGENT_NAME" in m for m in messages))
        self.assertTrue(any("VAULT_TIMEZONE" in m for m in messages))
        for message in messages:
            self.assertIn("multiplexed gateway", message)
            for value in LAUNCH_VALUES.values():
                self.assertNotIn(value, message)

    def test_repeated_reads_warn_once(self):
        os.environ["VAULT_AGENT_NAME"] = LAUNCH_VALUES["VAULT_AGENT_NAME"]
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        pair = make_fake_scope(multiplexed=True, values={"VAULT_AGENT_NAME": "scoped-agent"})
        with self.install(pair), self.assertLogs("plugins.hermes.config", "WARNING") as logs:
            for _ in range(3):
                cfg.resolve_agent_name()
        named = [r for r in logs.records if "VAULT_AGENT_NAME" in r.getMessage()]
        self.assertEqual(len(named), 1)

    def test_no_warning_without_multiplexing_or_without_a_process_value(self):
        pair = make_fake_scope(multiplexed=True, values={"VAULT_AGENT_NAME": "scoped-agent"})
        with self.install(pair), self.assertNoLogs("plugins.hermes.config", "WARNING"):
            cfg.resolve_agent_name()
        os.environ["VAULT_AGENT_NAME"] = "launch-agent-value"
        off = make_fake_scope(multiplexed=False)
        with self.install(off), self.assertNoLogs("plugins.hermes.config", "WARNING"):
            cfg.resolve_agent_name()


class ShadowingSourceTests(ScopeTestCase):
    def test_multiplexed_names_the_profile_env_file(self):
        pair = make_fake_scope(multiplexed=True, values={"VAULT_AGENT_NAME": "scoped-agent"})
        with self.install(pair):
            self.assertEqual(
                cfg.shadowing_source("agent_name"),
                "the VAULT_AGENT_NAME setting in this Hermes profile's .env overrides the "
                "config file",
            )

    def test_multiplexed_ignores_the_process_environment(self):
        self.set_launch_env()
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        pair = make_fake_scope(multiplexed=True)
        with self.install(pair):
            self.assertIsNone(cfg.shadowing_source("agent_name"))

    def test_without_multiplexing_the_text_is_unchanged(self):
        os.environ["VAULT_AGENT_NAME"] = "launch-agent-value"
        with self.no_hermes():
            self.assertEqual(
                cfg.shadowing_source("agent_name"),
                "the VAULT_AGENT_NAME environment variable overrides the config file",
            )


class ConfigCommandSourceTests(ScopeTestCase):
    def _run_config(self):
        from plugins.hermes import cli

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli._config()
        return rc, out.getvalue(), err.getvalue()

    def test_first_line_names_the_process_environment(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        with self.no_hermes():
            rc, out, _ = self._run_config()
        self.assertEqual(rc, 0)
        self.assertEqual(
            out.splitlines()[0],
            "settings_source: process environment (this command; a gateway with "
            "gateway.multiplex_profiles reads each profile's .env)",
        )
        self.assertTrue(out.splitlines()[1].startswith("config_path:"))

    def test_first_line_names_the_profile_scope(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        pair = make_fake_scope(multiplexed=True, values={"VAULT_AGENT_NAME": "scoped-agent"})
        with self.install(pair):
            rc, out, _ = self._run_config()
        self.assertEqual(rc, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], "settings_source: profile scope (multiplexed gateway)")
        self.assertIn("scoped-agent", out)

    def test_unbound_scope_prints_the_named_error_and_exits_2(self):
        self.set_launch_env()
        pair = make_fake_scope(multiplexed=True, unbound=True)
        with self.install(pair):
            rc, out, err = self._run_config()
        self.assertEqual(rc, 2)
        self.assertEqual(out.splitlines()[0], "settings_source: profile scope (multiplexed gateway)")
        self.assertIn("OPEN_SECOND_BRAIN_CONFIG cannot be resolved", err)
        for value in LAUNCH_VALUES.values():
            self.assertNotIn(value, out + err)


class StatusConfigScopeTests(ScopeTestCase):
    def test_unbound_scope_skips_the_config_file_field(self):
        self.set_launch_env()
        pair = make_fake_scope(multiplexed=True, unbound=True)
        with self.install(pair):
            status = OpenSecondBrainMemoryProvider(bridge=FakeBrainBridge()).get_status_config({})
        self.assertNotIn("config_file", status)
        for value in LAUNCH_VALUES.values():
            self.assertNotIn(value, json.dumps(status))

    def test_bound_scope_reports_the_config_file(self):
        scoped_config = self.tmp / "scoped.yaml"
        pair = make_fake_scope(
            multiplexed=True, values={"OPEN_SECOND_BRAIN_CONFIG": str(scoped_config)}
        )
        with self.install(pair):
            status = OpenSecondBrainMemoryProvider(bridge=FakeBrainBridge()).get_status_config({})
        self.assertEqual(status["config_file"], str(scoped_config))


class _HandshakeProcess:
    """A child that answers ``initialize`` and ``tools/list`` and nothing else."""

    def __init__(self):
        frames = [
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "id": 2, "result": {"tools": []}},
        ]
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b"".join(json.dumps(f).encode() + b"\n" for f in frames))
        self.stderr = None
        self.pid = 4242

    def poll(self):
        return None

    def terminate(self):
        pass

    def kill(self):
        pass

    def wait(self, timeout=None):
        return 0


class ScopedChildEnvironmentTests(ScopeTestCase):
    """(f) Under multiplexing each profile gets its own MCP child identity."""

    def tearDown(self):
        provider_module._reset_shared_bridges_for_tests()
        super().tearDown()

    def _initialize(self, pair, factory, overlay=None):
        with (
            self.install(pair),
            patch("plugins.hermes.provider.McpBrainBridge", side_effect=factory),
            patch.object(OpenSecondBrainMemoryProvider, "_repo_root", return_value="/repo"),
            patch.object(
                OpenSecondBrainMemoryProvider, "_resolve_command", return_value=("o2b", "mcp")
            ),
            patch.object(OpenSecondBrainMemoryProvider, "_resolve_env", return_value=overlay),
        ):
            OpenSecondBrainMemoryProvider().initialize("session", hermes_home=str(self.tmp))

    def test_child_env_carries_the_scoped_identity_only(self):
        self.set_launch_env()
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        built = []
        pair = make_fake_scope(
            multiplexed=True,
            values={"VAULT_DIR": "shared-vault", "VAULT_AGENT_NAME": "scoped-agent"},
        )
        self._initialize(pair, lambda **kw: built.append(kw) or FakeBrainBridge())
        self.assertEqual(len(built), 1)
        env = built[0]["env"]
        self.assertEqual(env["VAULT_AGENT_NAME"], "scoped-agent")
        self.assertEqual(env["VAULT_DIR"], "shared-vault")
        for name in ("VAULT_TIMEZONE", "OPEN_SECOND_BRAIN_CONFIG", "OPEN_SECOND_BRAIN_MCP_TIMEOUT"):
            self.assertNotIn(name, env)
        for value in LAUNCH_VALUES.values():
            self.assertNotIn(value, env.values())
        # The bridge never reads the deadline itself on this gateway.
        self.assertEqual(built[0]["timeout"], bridge_module.DEFAULT_REQUEST_TIMEOUT_SECONDS)

    def test_child_env_carries_the_scope_config_directory(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "launch-xdg")
        scoped = str(self.tmp / "profile-xdg")
        built = []
        pair = make_fake_scope(
            multiplexed=True, values={"VAULT_DIR": "v", "XDG_CONFIG_HOME": scoped}
        )
        self._initialize(pair, lambda **kw: built.append(kw) or FakeBrainBridge())
        self.assertEqual(built[0]["env"]["XDG_CONFIG_HOME"], scoped)

    def test_child_env_keeps_the_process_config_directory_the_scope_lacks(self):
        launch = str(self.tmp / "launch-xdg")
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = launch
        built = []
        pair = make_fake_scope(multiplexed=True, values={"VAULT_DIR": "v"})
        self._initialize(pair, lambda **kw: built.append(kw) or FakeBrainBridge())
        self.assertEqual(built[0]["env"]["XDG_CONFIG_HOME"], launch)

    def test_overlay_path_survives_the_scoping(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        built = []
        pair = make_fake_scope(multiplexed=True, values={"VAULT_DIR": "v"})
        overlay = {"PATH": "/opt/bun/bin", "VAULT_AGENT_NAME": "launch-agent-value"}
        self._initialize(pair, lambda **kw: built.append(kw) or FakeBrainBridge(), overlay)
        self.assertEqual(built[0]["env"]["PATH"], "/opt/bun/bin")
        self.assertNotIn("VAULT_AGENT_NAME", built[0]["env"])

    def test_scoped_timeout_reaches_the_bridge(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        built = []
        for raw, expected in (("7", 7.0), ("0", 0.0)):
            with self.subTest(raw=raw):
                provider_module._reset_shared_bridges_for_tests()
                built.clear()
                pair = make_fake_scope(
                    multiplexed=True,
                    values={"VAULT_DIR": "v", "OPEN_SECOND_BRAIN_MCP_TIMEOUT": raw},
                )
                self._initialize(pair, lambda **kw: built.append(kw) or FakeBrainBridge())
                self.assertEqual(built[0]["timeout"], expected)

    def test_same_vault_different_agents_get_two_bridges(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        built = []
        for agent in ("agent-one", "agent-two", "agent-one"):
            pair = make_fake_scope(
                multiplexed=True,
                values={"VAULT_DIR": "shared-vault", "VAULT_AGENT_NAME": agent},
            )
            self._initialize(pair, lambda **kw: built.append(kw) or FakeBrainBridge())
        self.assertEqual(
            [kw["env"]["VAULT_AGENT_NAME"] for kw in built], ["agent-one", "agent-two"]
        )

    def test_same_config_different_config_directories_get_two_bridges(self):
        shared = str(self.tmp / "shared-config.yaml")
        built = []
        for xdg in ("profile-one-xdg", "profile-two-xdg", "profile-one-xdg"):
            pair = make_fake_scope(
                multiplexed=True,
                values={
                    "VAULT_DIR": "shared-vault",
                    "VAULT_AGENT_NAME": "same-agent",
                    "OPEN_SECOND_BRAIN_CONFIG": shared,
                    "XDG_CONFIG_HOME": str(self.tmp / xdg),
                },
            )
            self._initialize(pair, lambda **kw: built.append(kw) or FakeBrainBridge())
        self.assertEqual(
            [kw["env"]["XDG_CONFIG_HOME"] for kw in built],
            [str(self.tmp / "profile-one-xdg"), str(self.tmp / "profile-two-xdg")],
        )
        self.assertEqual(len(provider_module._SHARED_BRIDGES), 2)

    def test_without_multiplexing_env_and_sharing_are_unchanged(self):
        os.environ["VAULT_DIR"] = "launch-vault"
        os.environ["VAULT_AGENT_NAME"] = "launch-agent-value"
        built = []
        off = make_fake_scope(multiplexed=False)
        for _ in range(2):
            self._initialize(off, lambda **kw: built.append(kw) or FakeBrainBridge())
        self.assertEqual(len(built), 1)
        self.assertIsNone(built[0]["env"])
        self.assertNotIn("timeout", built[0])
        self.assertEqual(off[1].reads, [])


class BridgeTimeoutFixedAtConstructionTests(ScopeTestCase):
    """(h) A restart from a plugin-owned thread never reads the scope."""

    def test_fixed_timeout_restart_never_reads_the_scope(self):
        pair = make_fake_scope(multiplexed=True, unbound=True)
        bridge = McpBrainBridge(vault="v", spawn=lambda argv: _HandshakeProcess(), timeout=7.0)
        errors = []

        def restart():
            try:
                bridge.start()
            except Exception as exc:  # noqa: BLE001 - recorded for the assertion
                errors.append(exc)

        with self.install(pair):
            thread = threading.Thread(target=restart)
            thread.start()
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(pair[1].reads, [])
        self.assertEqual(bridge._client._timeout, 7.0)

    def test_non_positive_timeout_disables_the_deadline(self):
        bridge = McpBrainBridge(vault="v", spawn=lambda argv: _HandshakeProcess(), timeout=0.0)
        bridge.start()
        self.assertIsNone(bridge._client._timeout)

    def test_no_timeout_argument_keeps_reading_the_environment(self):
        os.environ["OPEN_SECOND_BRAIN_MCP_TIMEOUT"] = "45"
        with self.no_hermes():
            bridge = McpBrainBridge(vault="v", spawn=lambda argv: _HandshakeProcess())
            bridge.start()
        self.assertEqual(bridge._client._timeout, 45.0)

    def test_multiplexed_timeout_reads_the_scope(self):
        os.environ["OPEN_SECOND_BRAIN_MCP_TIMEOUT"] = "4242"
        pair = make_fake_scope(multiplexed=True, values={"OPEN_SECOND_BRAIN_MCP_TIMEOUT": "9"})
        with self.install(pair):
            self.assertEqual(bridge_module.resolve_request_timeout(), 9.0)


class RequestTimeoutValueTests(ScopeTestCase):
    """A timeout value that is not a finite number never becomes a deadline."""

    def _resolve(self, raw):
        os.environ["OPEN_SECOND_BRAIN_MCP_TIMEOUT"] = raw
        with self.no_hermes():
            return bridge_module.resolve_request_timeout()

    def test_nan_falls_back_to_the_default_with_a_warning(self):
        for raw in ("nan", "NaN", "-nan"):
            with self.subTest(raw=raw), self.assertLogs("plugins.hermes.bridge", "WARNING") as logs:
                self.assertEqual(self._resolve(raw), bridge_module.DEFAULT_REQUEST_TIMEOUT_SECONDS)
            self.assertEqual(len(logs.records), 1)

    def test_infinity_disables_the_deadline(self):
        for raw in ("inf", "Infinity", "-inf"):
            with self.subTest(raw=raw), self.assertNoLogs("plugins.hermes.bridge", "WARNING"):
                self.assertIsNone(self._resolve(raw))

    def test_malformed_value_warning_never_carries_the_value(self):
        for raw in ("launch-timeout-value", "nan"):
            with self.subTest(raw=raw), self.assertLogs("plugins.hermes.bridge", "WARNING") as logs:
                self._resolve(raw)
            message = logs.records[0].getMessage()
            self.assertIn("OPEN_SECOND_BRAIN_MCP_TIMEOUT", message)
            self.assertNotIn(raw, message)

    def test_nan_scoped_timeouts_share_one_bridge(self):
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(self.tmp / "absent")
        built = []
        try:
            for _ in range(2):
                pair = make_fake_scope(
                    multiplexed=True,
                    values={"VAULT_DIR": "v", "OPEN_SECOND_BRAIN_MCP_TIMEOUT": "nan"},
                )
                with (
                    self.install(pair),
                    patch(
                        "plugins.hermes.provider.McpBrainBridge",
                        side_effect=lambda **kw: built.append(kw) or FakeBrainBridge(),
                    ),
                    patch.object(OpenSecondBrainMemoryProvider, "_repo_root", return_value="/repo"),
                    patch.object(
                        OpenSecondBrainMemoryProvider,
                        "_resolve_command",
                        return_value=("o2b", "mcp"),
                    ),
                    patch.object(OpenSecondBrainMemoryProvider, "_resolve_env", return_value=None),
                ):
                    OpenSecondBrainMemoryProvider().initialize("session", hermes_home=str(self.tmp))
        finally:
            provider_module._reset_shared_bridges_for_tests()
        self.assertEqual(len(built), 1)
        self.assertEqual(built[0]["timeout"], bridge_module.DEFAULT_REQUEST_TIMEOUT_SECONDS)


class PrefetchDegradeTests(ScopeTestCase):
    """(h) ``prefetch`` with no scope bound omits the reminder for the turn."""

    def test_prefetch_degrades_and_warns_once(self):
        # Recall the turn can still serve, so "omit the reminder" is told
        # apart from "drop the whole turn".
        bridge = FakeBrainBridge(
            results={
                "brain_recall_gate": {"structuredContent": {"retrieve": True, "reason": "hit"}},
                "brain_context_pack": {
                    "structuredContent": {"generated_at": "2026-08-22"},
                    "content": [{"type": "text", "text": "SCOPED TURN RECALL"}],
                },
            }
        )
        provider = OpenSecondBrainMemoryProvider(bridge=bridge)
        provider.initialize("session", hermes_home=str(self.tmp))
        provider_module._reset_scope_degrade_warning_for_tests()
        pair = make_fake_scope(multiplexed=True, unbound=True)
        with self.install(pair), self.assertLogs("plugins.hermes.provider", "WARNING") as logs:
            first = provider.prefetch("hello")
            second = provider.prefetch("hello again")
        self.assertIn("SCOPED TURN RECALL", first)
        self.assertIn("SCOPED TURN RECALL", second)
        degraded = [
            r for r in logs.records if "no profile scope bound for this turn" in r.getMessage()
        ]
        self.assertEqual(len(degraded), 1)
        self.assertEqual(
            degraded[0].getMessage(),
            "open-second-brain: no profile scope bound for this turn; the vault reminder is "
            "omitted",
        )


if __name__ == "__main__":
    unittest.main()
