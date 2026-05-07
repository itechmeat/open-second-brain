"""Tests for OpenClaw plugin compatibility (openclaw.plugin.json)."""

import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

from open_second_brain.doctor import check_openclaw_manifest
from open_second_brain.mcp import MCPServer

from tests.fixtures import create_plugin_repo


class OpenClawManifestValidityTests(unittest.TestCase):
    """Validate the shipped openclaw.plugin.json."""

    @classmethod
    def setUpClass(cls):
        cls.manifest_path = ROOT / "openclaw.plugin.json"
        with cls.manifest_path.open("r", encoding="utf-8") as f:
            cls.manifest = json.load(f)

    def test_manifest_is_valid_json(self):
        self.assertIsInstance(self.manifest, dict)

    def test_manifest_has_required_id(self):
        self.assertEqual(self.manifest["id"], "open-second-brain")

    def test_manifest_has_config_schema(self):
        schema = self.manifest["configSchema"]
        self.assertIsInstance(schema, dict)
        self.assertEqual(schema["type"], "object")

    def test_manifest_has_version(self):
        self.assertEqual(self.manifest["version"], "0.5.0")

    def test_manifest_declares_tools(self):
        tools = self.manifest["contracts"]["tools"]
        self.assertIsInstance(tools, list)
        expected = {
            "second_brain_status",
            "second_brain_query",
            "second_brain_capture",
            "event_log_append",
            "vault_health",
        }
        self.assertEqual(set(tools), expected)

    def test_manifest_tool_names_match_mcp_server(self):
        """Every tool declared in openclaw.plugin.json must exist in the MCP server."""
        with tempfile.TemporaryDirectory() as tmp:
            server = MCPServer(vault=Path(tmp))
            mcp_tools = set(server._tools.keys())
            manifest_tools = set(self.manifest["contracts"]["tools"])
            self.assertEqual(
                manifest_tools,
                mcp_tools,
                f"OpenClaw manifest tools {manifest_tools} do not match MCP tools {mcp_tools}",
            )


class OpenClawManifestDoctorTests(unittest.TestCase):
    """Test the doctor check for openclaw.plugin.json."""

    def test_doctor_passes_on_valid_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = create_plugin_repo(Path(tmp), valid=True)
            result = check_openclaw_manifest(repo / "openclaw.plugin.json")
            self.assertTrue(result.ok, result.message)
            self.assertEqual(result.name, "openclaw_manifest")

    def test_doctor_fails_on_missing_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = check_openclaw_manifest(Path(tmp) / "missing.json")
            self.assertFalse(result.ok)
            self.assertEqual(result.name, "openclaw_manifest")

    def test_doctor_fails_on_empty_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "openclaw.plugin.json"
            manifest.write_text("{}", encoding="utf-8")
            result = check_openclaw_manifest(manifest)
            self.assertFalse(result.ok)
            self.assertIn("field 'id'", result.message)

    def test_doctor_fails_on_missing_config_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "openclaw.plugin.json"
            manifest.write_text(
                json.dumps({"id": "test-plugin"}),
                encoding="utf-8",
            )
            result = check_openclaw_manifest(manifest)
            self.assertFalse(result.ok)
            self.assertIn("configSchema", result.message)

    def test_doctor_passes_on_real_repo_manifest(self):
        result = check_openclaw_manifest(ROOT / "openclaw.plugin.json")
        self.assertTrue(result.ok, result.message)


class OpenClawInstallabilityTests(unittest.TestCase):
    """Invariants required for `openclaw plugins install` to succeed."""

    @classmethod
    def setUpClass(cls):
        cls.manifest_path = ROOT / "openclaw.plugin.json"

    def test_manifest_file_exists_at_project_root(self):
        self.assertTrue(self.manifest_path.is_file())

    def test_manifest_is_parseable_json(self):
        data = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.assertIn("id", data)

    def test_bundle_adapter_claude_exists(self):
        """OpenClaw Bundle format auto-detects .claude-plugin/."""
        self.assertTrue((ROOT / ".claude-plugin" / "plugin.json").is_file())

    def test_bundle_adapter_codex_exists(self):
        """OpenClaw Bundle format auto-detects .codex-plugin/."""
        self.assertTrue((ROOT / ".codex-plugin" / "plugin.json").is_file())

    def test_no_package_json(self):
        """OpenClaw native plugins need package.json; we deliberately omit it
        because we use the Bundle format instead. If package.json is ever added
        for tooling (ESLint, etc.), this test should be updated or removed."""
        self.assertFalse((ROOT / "package.json").is_file())


if __name__ == "__main__":
    unittest.main()
