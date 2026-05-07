"""Tests for OpenClaw plugin compatibility (openclaw.plugin.json and package.json)."""

import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

from open_second_brain.doctor import check_openclaw_manifest, check_openclaw_installability
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
        self.assertEqual(self.manifest["version"], "0.5.1")

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

    def test_manifest_has_activation(self):
        self.assertIn("activation", self.manifest)
        self.assertTrue(self.manifest["activation"].get("onStartup"))

    def test_manifest_has_skills(self):
        self.assertIn("skills", self.manifest)
        self.assertIsInstance(self.manifest["skills"], list)

    def test_manifest_has_ui_hints(self):
        self.assertIn("uiHints", self.manifest)
        self.assertIn("vault", self.manifest["uiHints"])

    def test_manifest_mcp_enabled_default_false(self):
        mcp_prop = self.manifest["configSchema"]["properties"]["mcpEnabled"]
        self.assertFalse(mcp_prop.get("default", True))


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


class OpenClawPackageJsonTests(unittest.TestCase):
    """Validate the shipped package.json for OpenClaw native plugin compatibility."""

    @classmethod
    def setUpClass(cls):
        cls.pkg_path = ROOT / "package.json"
        with cls.pkg_path.open("r", encoding="utf-8") as f:
            cls.pkg = json.load(f)

    def test_package_json_is_valid_json(self):
        self.assertIsInstance(self.pkg, dict)

    def test_package_json_has_name(self):
        self.assertEqual(self.pkg["name"], "open-second-brain")

    def test_package_json_has_version(self):
        self.assertEqual(self.pkg["version"], "0.5.1")

    def test_package_json_has_type_module(self):
        self.assertEqual(self.pkg["type"], "module")

    def test_package_json_has_openclaw_extensions(self):
        extensions = self.pkg["openclaw"]["extensions"]
        self.assertIsInstance(extensions, list)
        self.assertGreater(len(extensions), 0)

    def test_package_json_extension_entries_exist(self):
        for entry in self.pkg["openclaw"]["extensions"]:
            entry_path = ROOT / entry
            self.assertTrue(entry_path.is_file(), f"Missing extension entry: {entry}")

    def test_package_json_has_no_dependencies(self):
        """The package must not declare dependencies — it imports from the host at runtime."""
        self.assertNotIn("dependencies", self.pkg)


class OpenClawInstallabilityDoctorTests(unittest.TestCase):
    """Test check_openclaw_installability doctor checks."""

    def test_passes_on_real_repo(self):
        results = check_openclaw_installability(ROOT)
        for r in results:
            self.assertTrue(r.ok, f"{r.name}: {r.message}")

    def test_fails_on_missing_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            # No package.json
            results = check_openclaw_installability(repo)
            self.assertFalse(results[0].ok)
            self.assertEqual(results[0].name, "openclaw_package_json")

    def test_fails_on_package_json_without_extensions(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps({"name": "test"}),
                encoding="utf-8",
            )
            results = check_openclaw_installability(repo)
            # First check (package.json exists) passes
            self.assertTrue(results[0].ok)
            # Second check (extensions) fails
            self.assertFalse(results[1].ok)
            self.assertIn("extensions", results[1].message)

    def test_fails_on_missing_extension_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "package.json").write_text(
                json.dumps({"openclaw": {"extensions": ["./nonexistent.js"]}}),
                encoding="utf-8",
            )
            results = check_openclaw_installability(repo)
            # First two checks pass
            self.assertTrue(results[0].ok)
            self.assertTrue(results[1].ok)
            # Entry file check fails
            self.assertFalse(results[2].ok)
            self.assertIn("nonexistent.js", results[2].message)


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

    def test_package_json_exists_at_project_root(self):
        self.assertTrue((ROOT / "package.json").is_file())

    def test_bundle_adapter_claude_exists(self):
        """OpenClaw Bundle format auto-detects .claude-plugin/."""
        self.assertTrue((ROOT / ".claude-plugin" / "plugin.json").is_file())

    def test_bundle_adapter_codex_exists(self):
        """OpenClaw Bundle format auto-detects .codex-plugin/."""
        self.assertTrue((ROOT / ".codex-plugin" / "plugin.json").is_file())

    def test_openclaw_entry_js_exists(self):
        """The JS entry declared in package.json must exist."""
        self.assertTrue((ROOT / "openclaw" / "index.js").is_file())

    def test_openclaw_runner_js_exists(self):
        """The subprocess helper must exist."""
        self.assertTrue((ROOT / "openclaw" / "o2b-runner.js").is_file())


if __name__ == "__main__":
    unittest.main()
