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

    def test_os_level_names_still_come_from_the_process(self):
        xdg = self.tmp / "xdg"
        os.environ[cfg.XDG_CONFIG_HOME_ENV] = str(xdg)
        pair = make_fake_scope(multiplexed=True)
        with self.install(pair):
            self.assertEqual(cfg.config_path(), xdg / cfg.PLUGIN_NAME / cfg.CONFIG_FILENAME)
        self.assertNotIn(cfg.XDG_CONFIG_HOME_ENV, pair[1].reads)


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
        self.assertEqual(out.splitlines()[0], "settings_source: process environment")
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

    def test_restart_in_a_bare_thread_does_not_read_the_scope(self):
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
        provider = OpenSecondBrainMemoryProvider(bridge=FakeBrainBridge())
        provider.initialize("session", hermes_home=str(self.tmp))
        provider_module._reset_scope_degrade_warning_for_tests()
        pair = make_fake_scope(multiplexed=True, unbound=True)
        with self.install(pair), self.assertLogs("plugins.hermes.provider", "WARNING") as logs:
            first = provider.prefetch("hello")
            second = provider.prefetch("hello again")
        self.assertIsInstance(first, str)
        self.assertIsInstance(second, str)
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
