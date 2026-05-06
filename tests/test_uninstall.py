import os
import re
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from open_second_brain.uninstall import (
    HERMES_COMMANDS,
    PLUGIN_NAME,
    SAFE_CONFIG_DIR_NAMES,
    plan_uninstall,
    render_plan,
)
from tests.test_cli import run_cli


class HermesCommandsTests(unittest.TestCase):
    def test_hermes_commands_match_documented_form(self):
        self.assertEqual(
            HERMES_COMMANDS,
            (
                f"hermes mcp remove {PLUGIN_NAME}",
                f"hermes plugins remove {PLUGIN_NAME}",
                "hermes gateway restart",
            ),
        )

    def test_hermes_commands_do_not_use_quoted_args_blob(self):
        for cmd in HERMES_COMMANDS:
            self.assertNotIn("'", cmd)
            self.assertNotIn('"', cmd)
            self.assertNotIn("--args ", cmd)


class PlanUninstallTests(unittest.TestCase):
    def test_dry_run_does_not_remove_config_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "open-second-brain"
            config_dir.mkdir()
            config = config_dir / "config.yaml"
            config.write_text("vault_path: /vault/example\n", encoding="utf-8")
            other = config_dir / "snapshot.json"
            other.write_text("{}", encoding="utf-8")

            plan = plan_uninstall(config_path=config, apply_local=False)

            self.assertFalse(plan.apply_local)
            self.assertTrue(config.exists())
            self.assertTrue(other.exists())
            self.assertTrue(config_dir.is_dir())
            self.assertEqual(plan.removed_paths, ())
            self.assertEqual(plan.skipped_paths, ())
            self.assertEqual(plan.config_dir, config_dir)
            self.assertTrue(plan.config_dir_exists)
            self.assertEqual(plan.vault_path, Path("/vault/example"))

    def test_dry_run_records_missing_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "open-second-brain" / "missing.yaml"

            plan = plan_uninstall(config_path=config, apply_local=False)

            self.assertFalse(plan.config_exists)
            self.assertFalse(plan.config_dir_exists)
            self.assertEqual(plan.removed_paths, ())

    def test_apply_local_removes_only_named_config_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "open-second-brain"
            config_dir.mkdir()
            (config_dir / "config.yaml").write_text("instance: x\n", encoding="utf-8")
            (config_dir / "snapshots").mkdir()
            (config_dir / "snapshots" / "old.json").write_text("{}", encoding="utf-8")

            plan = plan_uninstall(config_path=config_dir / "config.yaml", apply_local=True)

            self.assertTrue(plan.apply_local)
            self.assertFalse(config_dir.exists())
            self.assertEqual(plan.removed_paths, (config_dir,))
            self.assertEqual(plan.skipped_paths, ())
            self.assertEqual(plan.errors, ())

    def test_apply_local_refuses_unknown_directory_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "etc"
            config_dir.mkdir()
            payload = config_dir / "important.yaml"
            payload.write_text("vault_path: /vault\n", encoding="utf-8")

            plan = plan_uninstall(config_path=payload, apply_local=True)

            self.assertTrue(config_dir.exists())
            self.assertTrue(payload.exists())
            self.assertEqual(plan.removed_paths, ())
            self.assertEqual(len(plan.skipped_paths), 1)
            skipped_path, reason = plan.skipped_paths[0]
            self.assertEqual(skipped_path, config_dir)
            self.assertIn("not a recognized", reason)

    def test_apply_local_refuses_paths_inside_hermes(self):
        with tempfile.TemporaryDirectory() as tmp:
            hermes_root = Path(tmp) / ".hermes"
            config_dir = hermes_root / "open-second-brain"
            config_dir.mkdir(parents=True)
            payload = config_dir / "config.yaml"
            payload.write_text("vault_path: /vault\n", encoding="utf-8")

            plan = plan_uninstall(config_path=payload, apply_local=True)

            self.assertTrue(config_dir.exists())
            self.assertTrue(payload.exists())
            self.assertEqual(plan.removed_paths, ())
            self.assertEqual(len(plan.skipped_paths), 1)
            _, reason = plan.skipped_paths[0]
            self.assertIn("Hermes", reason)

    def test_apply_local_refuses_git_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "open-second-brain"
            config_dir.mkdir()
            (config_dir / ".git").mkdir()
            payload = config_dir / "config.yaml"
            payload.write_text("instance: x\n", encoding="utf-8")

            plan = plan_uninstall(config_path=payload, apply_local=True)

            self.assertTrue(config_dir.exists())
            self.assertEqual(plan.removed_paths, ())
            self.assertEqual(len(plan.skipped_paths), 1)
            _, reason = plan.skipped_paths[0]
            self.assertIn("git", reason)

    def test_apply_local_skips_when_config_dir_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = Path(tmp) / "open-second-brain" / "config.yaml"

            plan = plan_uninstall(config_path=payload, apply_local=True)

            self.assertEqual(plan.removed_paths, ())
            self.assertEqual(len(plan.skipped_paths), 1)
            _, reason = plan.skipped_paths[0]
            self.assertIn("does not exist", reason)


class VaultSafetyTests(unittest.TestCase):
    def test_apply_local_never_touches_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = tmp_path / "vault"
            (vault / "AI Wiki").mkdir(parents=True)
            (vault / "Daily").mkdir(parents=True)
            (vault / "AI Wiki" / "page.md").write_text("# Page\n", encoding="utf-8")
            (vault / "Daily" / "2026.05.06.md").write_text("# Daily\n", encoding="utf-8")

            config_dir = tmp_path / "open-second-brain"
            config_dir.mkdir()
            config = config_dir / "config.yaml"
            config.write_text(f"vault_path: {vault}\n", encoding="utf-8")

            plan_uninstall(config_path=config, apply_local=True)

            self.assertTrue(vault.is_dir())
            self.assertTrue((vault / "AI Wiki" / "page.md").is_file())
            self.assertTrue((vault / "Daily" / "2026.05.06.md").is_file())

    def test_apply_local_never_touches_hermes_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            hermes_dir = tmp_path / ".hermes"
            hermes_dir.mkdir()
            hermes_config = hermes_dir / "config.yaml"
            hermes_payload = textwrap.dedent(
                """
                mcp_servers:
                  open-second-brain:
                    command: o2b
                    args: ["mcp", "--vault", "/vault"]
                """
            ).strip() + "\n"
            hermes_config.write_text(hermes_payload, encoding="utf-8")

            config_dir = tmp_path / "open-second-brain"
            config_dir.mkdir()
            config = config_dir / "config.yaml"
            config.write_text("vault_path: /vault\n", encoding="utf-8")

            plan_uninstall(config_path=config, apply_local=True)

            self.assertTrue(hermes_config.is_file())
            self.assertEqual(hermes_config.read_text(encoding="utf-8"), hermes_payload)


class RenderPlanTests(unittest.TestCase):
    def _basic_plan(self, *, apply_local: bool, tmp_path: Path) -> str:
        config_dir = tmp_path / "open-second-brain"
        config_dir.mkdir()
        config = config_dir / "config.yaml"
        config.write_text("vault_path: /vault/here\n", encoding="utf-8")

        plan = plan_uninstall(config_path=config, apply_local=apply_local)
        return render_plan(plan)

    def test_rendered_plan_includes_hermes_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = self._basic_plan(apply_local=False, tmp_path=Path(tmp))
        for cmd in HERMES_COMMANDS:
            self.assertIn(cmd, text)

    def test_rendered_plan_states_vault_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = self._basic_plan(apply_local=False, tmp_path=Path(tmp))
        self.assertRegex(text, r"Vault \(NEVER removed by this tool\)")
        self.assertIn("Daily/", text)
        self.assertIn("AI Wiki/", text)

    def test_rendered_plan_states_hermes_config_is_not_edited(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = self._basic_plan(apply_local=False, tmp_path=Path(tmp))
        self.assertIn("~/.hermes/config.yaml", text)
        self.assertIn("never edits", text)

    def test_rendered_plan_marks_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = self._basic_plan(apply_local=False, tmp_path=Path(tmp))
        self.assertIn("dry-run", text)

    def test_rendered_plan_marks_apply_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = self._basic_plan(apply_local=True, tmp_path=Path(tmp))
        self.assertIn("apply-local", text)


class CliUninstallTests(unittest.TestCase):
    def test_cli_dry_run_does_not_modify_filesystem(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config_dir = tmp_path / "open-second-brain"
            config_dir.mkdir()
            config = config_dir / "config.yaml"
            config.write_text("vault_path: /vault\n", encoding="utf-8")

            result = run_cli("uninstall", "--config", str(config))

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Uninstall plan", result.stdout)
            self.assertIn("dry-run", result.stdout)
            self.assertIn("hermes mcp remove open-second-brain", result.stdout)
            self.assertIn("hermes plugins remove open-second-brain", result.stdout)
            self.assertIn("hermes gateway restart", result.stdout)
            self.assertIn("NEVER removed by this tool", result.stdout)
            self.assertTrue(config.exists())
            self.assertTrue(config_dir.is_dir())

    def test_cli_apply_local_removes_only_local_config_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            vault = tmp_path / "vault"
            (vault / "Daily").mkdir(parents=True)
            (vault / "Daily" / "2026.05.06.md").write_text("vault content", encoding="utf-8")

            config_dir = tmp_path / "open-second-brain"
            config_dir.mkdir()
            config = config_dir / "config.yaml"
            config.write_text(f"vault_path: {vault}\n", encoding="utf-8")

            result = run_cli("uninstall", "--config", str(config), "--apply-local")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("apply-local", result.stdout)
            self.assertFalse(config_dir.exists())
            self.assertTrue(vault.is_dir())
            self.assertTrue((vault / "Daily" / "2026.05.06.md").is_file())

    def test_cli_apply_local_refuses_when_config_dir_name_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config_dir = tmp_path / "etc"
            config_dir.mkdir()
            (config_dir / "very-important.yaml").write_text("keep-me\n", encoding="utf-8")
            config = config_dir / "config.yaml"
            config.write_text("vault_path: /vault\n", encoding="utf-8")

            result = run_cli("uninstall", "--config", str(config), "--apply-local")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("skipped", result.stdout)
            self.assertTrue(config_dir.is_dir())
            self.assertTrue((config_dir / "very-important.yaml").is_file())

    def test_cli_uses_open_second_brain_config_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config_dir = tmp_path / "open-second-brain"
            config_dir.mkdir()
            config = config_dir / "config.yaml"
            config.write_text("vault_path: /env/vault\n", encoding="utf-8")

            result = run_cli(
                "uninstall",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(config)},
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(str(config), result.stdout)
            self.assertIn("/env/vault", result.stdout)

    def test_cli_help_documents_safety_invariants(self):
        result = run_cli("uninstall", "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("never touches", result.stdout)
        self.assertIn("vault", result.stdout.lower())


class SafeNamesTests(unittest.TestCase):
    def test_safe_names_only_contain_canonical_open_second_brain_names(self):
        self.assertEqual(
            SAFE_CONFIG_DIR_NAMES,
            frozenset({"open-second-brain", "open_second_brain"}),
        )


if __name__ == "__main__":
    unittest.main()
