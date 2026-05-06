import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "PYTHONPATH": str(ROOT / "src")}


def run_cli(*args, env=None):
    return subprocess.run(
        [sys.executable, "-m", "open_second_brain.cli", *args],
        cwd=ROOT,
        env={**ENV, **(env or {})},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class CliTests(unittest.TestCase):
    def test_status_reports_missing_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "missing.yaml"
            result = run_cli("status", env={"OPEN_SECOND_BRAIN_CONFIG": str(config)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("config_exists: false", result.stdout)
            self.assertIn(str(config), result.stdout)

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
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
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
                ],
                cwd=ROOT,
                env=ENV,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            daily = Path(tmp) / "Daily" / "2026.05.06.md"
            self.assertIn("- 10:30 — @compat-agent — compat entry", daily.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
