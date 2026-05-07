import tempfile
import unittest
from pathlib import Path

from open_second_brain.doctor import (
    CheckResult,
    check_claude_manifest,
    check_config_writeable,
    check_codex_manifest,
    check_hermes_manifest,
    check_json_manifest,
    check_openclaw_manifest,
    check_vault_writeable,
    doctor,
)

from tests.fixtures import create_plugin_repo, create_sandbox_vault


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
            vault = create_sandbox_vault(Path(tmp))
            config = Path(tmp) / "config.yaml"
            config.write_text("vault_path: /tmp", encoding="utf-8")
            results = doctor(vault=vault, config=config)
            self.assertGreater(len(results), 0)
            for r in results:
                self.assertIsInstance(r, CheckResult)

    def test_manifest_schema_checks_accept_valid_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = create_plugin_repo(Path(tmp), valid=True)
            self.assertTrue(check_claude_manifest(repo / ".claude-plugin" / "plugin.json").ok)
            self.assertTrue(check_codex_manifest(repo / ".codex-plugin" / "plugin.json").ok)
            self.assertTrue(check_hermes_manifest(repo / "plugins" / "hermes" / "plugin.yaml").ok)
            self.assertTrue(check_openclaw_manifest(repo / "openclaw.plugin.json").ok)

    def test_manifest_schema_checks_reject_missing_required_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = create_plugin_repo(Path(tmp), valid=False)
            claude = check_claude_manifest(repo / ".claude-plugin" / "plugin.json")
            codex = check_codex_manifest(repo / ".codex-plugin" / "plugin.json")
            hermes = check_hermes_manifest(repo / "plugins" / "hermes" / "plugin.yaml")
            openclaw = check_openclaw_manifest(repo / "openclaw.plugin.json")
            self.assertFalse(claude.ok)
            self.assertFalse(codex.ok)
            self.assertFalse(hermes.ok)
            self.assertFalse(openclaw.ok)
            self.assertIn("schema invalid", claude.message)
            self.assertIn("skills", codex.message)
            self.assertIn("missing", hermes.message)
            self.assertIn("'id'", openclaw.message)


if __name__ == "__main__":
    unittest.main()
