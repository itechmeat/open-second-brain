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

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from plugins.hermes import config as cfg  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
