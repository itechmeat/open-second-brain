import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from open_second_brain.config import (
    default_config_path,
    discover_config,
    redact_mapping,
    resolve_agent_name,
    resolve_timezone,
    resolve_vault,
)


class ConfigTests(unittest.TestCase):
    def test_default_config_path_uses_env_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "custom.yaml"
            with patch.dict(os.environ, {"OPEN_SECOND_BRAIN_CONFIG": str(path)}):
                self.assertEqual(default_config_path(), path)

    def test_default_config_path_uses_xdg_config_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": tmp, "OPEN_SECOND_BRAIN_CONFIG": ""}, clear=False):
                self.assertEqual(default_config_path(), Path(tmp) / "open-second-brain" / "config.yaml")

    def test_discover_config_reports_missing_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing.yaml"
            result = discover_config(path)
            self.assertFalse(result.exists)
            self.assertEqual(result.path, path)
            self.assertEqual(result.data, {})

    def test_discover_config_reads_simple_key_value_yaml(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.yaml"
            path.write_text("instance_name: Test Brain\nruntime: hermes\n", encoding="utf-8")
            result = discover_config(path)
            self.assertTrue(result.exists)
            self.assertEqual(result.data["instance_name"], "Test Brain")
            self.assertEqual(result.data["runtime"], "hermes")

    def test_discover_config_reports_directory_as_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            result = discover_config(path)
            self.assertFalse(result.exists)
            self.assertEqual(result.path, path)
            self.assertEqual(result.data, {})

    def test_discover_config_reports_invalid_utf8_as_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.yaml"
            path.write_bytes(b"\xff\xfe\x00")
            result = discover_config(path)
            self.assertFalse(result.exists)
            self.assertEqual(result.path, path)
            self.assertEqual(result.data, {})

    def test_redact_mapping_redacts_secret_like_keys(self):
        redacted = redact_mapping({"api_key": "abc", "path": "/tmp/vault", "token": "xyz"})
        self.assertEqual(redacted["api_key"], "[REDACTED]")
        self.assertEqual(redacted["token"], "[REDACTED]")
        self.assertEqual(redacted["path"], "/tmp/vault")


class ResolveVaultTests(unittest.TestCase):
    """``resolve_vault`` is the single source of truth that ``o2b mcp``
    consults when launched without ``--vault`` (the case for Claude's
    ``.mcp.json`` auto-register and any Hermes/Codex MCP entry that
    omits the path). Lookup chain: ``VAULT_DIR`` env, then plugin config
    ``vault`` field, then ``None``.
    """

    def setUp(self):
        self._prev_env = os.environ.pop("VAULT_DIR", None)

    def tearDown(self):
        os.environ.pop("VAULT_DIR", None)
        if self._prev_env is not None:
            os.environ["VAULT_DIR"] = self._prev_env

    def test_returns_none_when_neither_env_nor_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(resolve_vault(Path(tmp) / "missing.yaml"))

    def test_reads_from_env(self):
        os.environ["VAULT_DIR"] = "/tmp/env-vault"
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(resolve_vault(Path(tmp) / "missing.yaml"), Path("/tmp/env-vault"))

    def test_env_wins_over_config(self):
        os.environ["VAULT_DIR"] = "/tmp/env-vault"
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            cfg.write_text('vault: "/tmp/cfg-vault"\n', encoding="utf-8")
            self.assertEqual(resolve_vault(cfg), Path("/tmp/env-vault"))

    def test_reads_from_config_when_env_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            cfg.write_text('vault: "/tmp/cfg-vault"\n', encoding="utf-8")
            self.assertEqual(resolve_vault(cfg), Path("/tmp/cfg-vault"))

    def test_expanduser_in_config_value(self):
        # Stored vault path may use ``~`` if the user hand-edits the file.
        # The resolver expands it so MCP launches don't see a literal tilde.
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            cfg.write_text('vault: "~/my-vault"\n', encoding="utf-8")
            resolved = resolve_vault(cfg)
            self.assertIsNotNone(resolved)
            self.assertFalse(str(resolved).startswith("~"))


if __name__ == "__main__":
    unittest.main()
