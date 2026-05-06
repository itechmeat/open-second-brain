import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "PYTHONPATH": str(ROOT / "src")}


def run_module(module, *args, env=None):
    return subprocess.run(
        [sys.executable, "-m", module, *args],
        cwd=ROOT,
        env={**ENV, **(env or {})},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )


def run_cli(*args, env=None):
    return run_module("open_second_brain.cli", *args, env=env)


class CliTests(unittest.TestCase):
    def test_status_reports_missing_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "missing.yaml"
            result = run_cli("status", env={"OPEN_SECOND_BRAIN_CONFIG": str(config)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("config_exists: false", result.stdout)
            self.assertIn(str(config), result.stdout)

    def test_init_creates_vault_structure(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            result = run_cli("init", "--vault", str(vault), "--name", "Test")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("initialized vault:", result.stdout)
            self.assertTrue((vault / "AI Wiki" / "_OPEN_SECOND_BRAIN.md").is_file())
            self.assertTrue((vault / "AI Wiki" / "identity" / "agents.md").is_file())

    def test_init_already_initialized_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            run_cli("init", "--vault", str(vault), "--name", "First")
            index = vault / "AI Wiki" / "index.md"
            index.write_text("custom", encoding="utf-8")
            result = run_cli("init", "--vault", str(vault), "--name", "Second")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already initialized", result.stdout)
            self.assertEqual(index.read_text(encoding="utf-8"), "custom")

    def test_init_force_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            run_cli("init", "--vault", str(vault), "--name", "First")
            index = vault / "AI Wiki" / "index.md"
            index.write_text("old", encoding="utf-8")
            result = run_cli("init", "--vault", str(vault), "--name", "Second", "--force")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("initialized vault:", result.stdout)
            self.assertNotEqual(index.read_text(encoding="utf-8"), "old")

    def test_doctor_checks_valid_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            result = run_cli("doctor", "--vault", str(vault))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("[OK]", result.stdout)
            self.assertIn("vault", result.stdout.lower())

    def test_doctor_reports_missing_vault(self):
        result = run_cli("doctor", "--vault", "/nonexistent/path")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("[FAIL]", result.stdout)

    def test_doctor_with_repo_checks_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            repo = Path(tmp) / "repo"
            (repo / ".claude-plugin").mkdir(parents=True)
            (repo / ".codex-plugin").mkdir(parents=True)
            (repo / ".claude-plugin" / "plugin.json").write_text('{"name":"test"}', encoding="utf-8")
            (repo / ".codex-plugin" / "plugin.json").write_text('{"name":"test"}', encoding="utf-8")
            result = run_cli("doctor", "--vault", str(vault), "--repo", str(repo))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("claude_manifest", result.stdout)
            self.assertIn("codex_manifest", result.stdout)

    def test_append_event_writes_daily_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_cli(
                "append-event",
                "created CLI",
                "--vault",
                tmp,
                "--as",
                "test-agent",
                "--date",
                "2026.05.06",
                "--time",
                "10:15",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            daily = Path(tmp) / "Daily" / "2026.05.06.md"
            self.assertIn("- 10:15 — @test-agent — created CLI", daily.read_text(encoding="utf-8"))

    def test_export_config_writes_redacted_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.yaml"
            config.write_text("api_key: abc\nvault_path: /tmp/vault\n", encoding="utf-8")
            output = Path(tmp) / "snapshot.json"
            result = run_cli(
                "export-config",
                "--config",
                str(config),
                "--output",
                str(output),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(data["config"]["api_key"], "[REDACTED]")
            self.assertEqual(data["config"]["vault_path"], "/tmp/vault")

    def test_vault_log_compatibility_module(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_module(
                "open_second_brain.vault_log",
                "--as",
                "compat-agent",
                "--vault",
                tmp,
                "--date",
                "2026.05.06",
                "--time",
                "10:30",
                "compat entry",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            daily = Path(tmp) / "Daily" / "2026.05.06.md"
            self.assertIn("- 10:30 — @compat-agent — compat entry", daily.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
