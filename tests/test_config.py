import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from open_second_brain.config import default_config_path, discover_config, redact_mapping


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

    def test_redact_mapping_redacts_secret_like_keys(self):
        redacted = redact_mapping({"api_key": "abc", "path": "/tmp/vault", "token": "xyz"})
        self.assertEqual(redacted["api_key"], "[REDACTED]")
        self.assertEqual(redacted["token"], "[REDACTED]")
        self.assertEqual(redacted["path"], "/tmp/vault")


if __name__ == "__main__":
    unittest.main()
