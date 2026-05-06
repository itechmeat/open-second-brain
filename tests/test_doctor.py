import tempfile
import unittest
from pathlib import Path

from open_second_brain.doctor import (
    CheckResult,
    check_config_writeable,
    check_json_manifest,
    check_vault_writeable,
    doctor,
)


class DoctorTests(unittest.TestCase):
    def test_check_vault_writeable(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            result = check_vault_writeable(vault)
            self.assertTrue(result.ok, result.message)
            self.assertIn("writable", result.message.lower())

    def test_check_vault_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "does_not_exist"
            result = check_vault_writeable(missing)
        self.assertFalse(result.ok)
        self.assertIn("missing", result.message.lower())

    def test_check_config_writeable_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.yaml"
            config.write_text("vault_path: /tmp", encoding="utf-8")
            result = check_config_writeable(config)
            self.assertTrue(result.ok, result.message)

    def test_check_config_writeable_missing_parent_is_ok(self):
        # config can be missing; the check verifies we can write to the parent
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "subdir" / "config.yaml"
            result = check_config_writeable(config)
            self.assertTrue(result.ok, f"should be ok: can create parent dirs and touch file: {result.message}")

    def test_check_json_manifest_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "plugin.json"
            manifest.write_text('{"name": "test", "version": "1.0.0"}', encoding="utf-8")
            result = check_json_manifest(manifest, "Test manifest")
            self.assertTrue(result.ok)

    def test_check_json_manifest_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "plugin.json"
            manifest.write_text("{invalid json", encoding="utf-8")
            result = check_json_manifest(manifest, "Test manifest")
            self.assertFalse(result.ok)

    def test_check_json_manifest_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "does_not_exist.json"
            result = check_json_manifest(missing, "Test")
        self.assertFalse(result.ok)

    def test_doctor_aggregates_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            config = Path(tmp) / "config.yaml"
            config.write_text("vault_path: /tmp", encoding="utf-8")
            results = doctor(vault=vault, config=config)
            self.assertGreater(len(results), 0)
            for r in results:
                self.assertIsInstance(r, CheckResult)


if __name__ == "__main__":
    unittest.main()
