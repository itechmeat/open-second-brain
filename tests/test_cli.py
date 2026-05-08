import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "PYTHONPATH": str(ROOT / "src")}

from tests.fixtures import create_plugin_repo, create_sandbox_vault


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
    # Isolate ``OPEN_SECOND_BRAIN_CONFIG`` per call by default. ``o2b init``
    # always persists ``vault``/``agent_name``/``timezone`` to the config
    # file at this path, and without isolation init-tests would silently
    # write to the host's real ``~/.config/open-second-brain/config.yaml``
    # — clobbering whatever the developer has set up locally. Tests that
    # specifically want to verify default-config behavior pass their own
    # ``OPEN_SECOND_BRAIN_CONFIG`` in ``env`` to override this guard.
    actual_env = dict(env or {})
    cleanup_dir: Path | None = None
    if "OPEN_SECOND_BRAIN_CONFIG" not in actual_env:
        cleanup_dir = Path(tempfile.mkdtemp(prefix="o2b-test-"))
        actual_env["OPEN_SECOND_BRAIN_CONFIG"] = str(cleanup_dir / "isolated-config.yaml")
    try:
        return run_module("open_second_brain.cli", *args, env=actual_env)
    finally:
        if cleanup_dir is not None:
            import shutil
            shutil.rmtree(cleanup_dir, ignore_errors=True)


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

    def test_init_with_agent_name_writes_identity_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            config = Path(tmp) / "config.yaml"
            result = run_cli(
                "init",
                "--vault",
                str(vault),
                "--name",
                "Test",
                "--agent-name",
                "openclaw-main",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(config)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("agent name registered: openclaw-main", result.stdout)
            agents_md = (vault / "AI Wiki" / "identity" / "agents.md").read_text(
                encoding="utf-8"
            )
            self.assertIn("- openclaw-main: primary agent on this server", agents_md)
            self.assertNotIn("(add your agents here", agents_md)

    def test_init_with_agent_name_persists_to_plugin_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            config = Path(tmp) / "config.yaml"
            result = run_cli(
                "init",
                "--vault",
                str(vault),
                "--name",
                "Test",
                "--agent-name",
                "hermes-vps-agent",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(config)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("agent name persisted to:", result.stdout)
            self.assertTrue(config.is_file())
            self.assertIn("agent_name", config.read_text(encoding="utf-8"))
            self.assertIn("hermes-vps-agent", config.read_text(encoding="utf-8"))

    def test_append_event_errors_when_no_vault_anywhere(self):
        # ``o2b append-event`` is a write command. Before this fix, omitting
        # both ``--vault`` and ``VAULT_DIR`` made it silently fall back to
        # the current working directory, so an agent invoking
        # ``o2b append-event "..."`` would write to ``$(pwd)/Daily/<date>.md``
        # instead of the user's actual vault — quiet data loss. Fail closed.
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            env = {"OPEN_SECOND_BRAIN_CONFIG": str(cfg)}
            result = run_cli(
                "append-event", "msg",
                "--as", "tester",
                env=env,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no vault configured", result.stderr.lower())

    def test_append_event_prints_absolute_path_on_success(self):
        # The success line was historically ``appended: Daily/<date>.md``,
        # which gave no signal when the entry had landed in the wrong
        # vault. Always print the absolute path so a misconfiguration
        # is immediately visible.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            cfg = Path(tmp) / "config.yaml"
            result = run_cli(
                "append-event", "absolute-path-test",
                "--vault", str(vault),
                "--as", "tester",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(cfg)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            # Output line: ``appended: <abs path to Daily/<date>.md>``.
            self.assertIn("appended: ", result.stdout)
            # The reported path must start with the vault root, not be
            # a bare ``Daily/...`` relative segment.
            output_path = result.stdout.split("appended: ", 1)[1].strip().splitlines()[0]
            self.assertTrue(
                Path(output_path).is_absolute(),
                f"reported path is not absolute: {output_path!r}",
            )
            self.assertTrue(output_path.startswith(str(vault.resolve())),
                            f"path {output_path!r} not under vault {vault.resolve()}")

    def test_doctor_errors_when_no_vault_anywhere(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            result = run_cli("doctor", env={"OPEN_SECOND_BRAIN_CONFIG": str(cfg)})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no vault configured", result.stderr.lower())

    def test_index_errors_when_no_vault_anywhere(self):
        # ``o2b index`` writes to the vault (regenerates AI Wiki/index.md).
        # Same fail-closed semantics as append-event.
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            result = run_cli("index", env={"OPEN_SECOND_BRAIN_CONFIG": str(cfg)})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no vault configured", result.stderr.lower())

    def test_vault_log_errors_when_no_vault_anywhere(self):
        # The ``vault-log`` CLI is the original write entry point used
        # by older skill workflows. It hit the same quiet-cwd bug —
        # vault-log "msg" without --vault wrote to $(pwd)/Daily/.
        # Fail closed too.
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            env = {
                **os.environ,
                "OPEN_SECOND_BRAIN_CONFIG": str(cfg),
                "PYTHONPATH": str(ROOT / "src"),
            }
            env.pop("VAULT_DIR", None)
            result = subprocess.run(
                [sys.executable, "-m", "open_second_brain.vault_log",
                 "test message", "--as", "tester"],
                cwd=ROOT, env=env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no vault configured", result.stderr.lower())

    def test_vault_log_prints_absolute_path_on_success(self):
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            cfg = Path(tmp) / "config.yaml"
            env = {
                **os.environ,
                "OPEN_SECOND_BRAIN_CONFIG": str(cfg),
                "PYTHONPATH": str(ROOT / "src"),
                "VAULT_DIR": str(vault),
            }
            result = subprocess.run(
                [sys.executable, "-m", "open_second_brain.vault_log",
                 "absolute-path-test", "--as", "tester"],
                cwd=ROOT, env=env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("appended: ", result.stdout)
            output_path = result.stdout.split("appended: ", 1)[1].strip().splitlines()[0]
            self.assertTrue(Path(output_path).is_absolute())
            self.assertTrue(output_path.startswith(str(vault.resolve())))

    def test_mcp_command_errors_when_no_vault_anywhere(self):
        # When ``--vault`` is omitted, ``VAULT_DIR`` is unset, and the
        # plugin config has no ``vault`` field, ``o2b mcp`` must fail
        # fast with a clear hint. This is the safety net for users
        # who installed the plugin but forgot to run ``o2b init``.
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.yaml"
            env = {
                **os.environ,
                "OPEN_SECOND_BRAIN_CONFIG": str(cfg),
                "PYTHONPATH": str(ROOT / "src"),
            }
            env.pop("VAULT_DIR", None)
            result = subprocess.run(
                [sys.executable, "-m", "open_second_brain.cli", "mcp"],
                cwd=ROOT, env=env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no vault configured", result.stderr.lower())
            self.assertIn("o2b init", result.stderr)

    def test_init_persists_vault_path_to_plugin_config(self):
        # The vault path is the third value plugin config caches alongside
        # ``agent_name`` and ``timezone`` after ``o2b init``. Without it,
        # ``o2b mcp`` (called with no args by Claude's ``.mcp.json``
        # auto-register, or by Hermes/Codex MCP entries that omit
        # ``--vault``) cannot find a vault and exits with an error.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            config = Path(tmp) / "config.yaml"
            result = run_cli(
                "init",
                "--vault",
                str(vault),
                "--name",
                "Test",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(config)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("vault path persisted to:", result.stdout)
            text = config.read_text(encoding="utf-8")
            self.assertIn("vault", text)
            # Path is persisted resolved (absolute) so MCP subprocesses
            # don't depend on the cwd they happen to be spawned in.
            self.assertIn(str(vault.resolve()), text)

    def test_init_with_timezone_persists_to_plugin_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            config = Path(tmp) / "config.yaml"
            result = run_cli(
                "init",
                "--vault",
                str(vault),
                "--name",
                "Test",
                "--agent-name",
                "hermes-vps-agent",
                "--timezone",
                "Europe/Belgrade",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(config)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("timezone registered: Europe/Belgrade", result.stdout)
            self.assertIn("timezone persisted to:", result.stdout)
            text = config.read_text(encoding="utf-8")
            self.assertIn("agent_name", text)
            self.assertIn("hermes-vps-agent", text)
            self.assertIn("timezone", text)
            self.assertIn("Europe/Belgrade", text)

    def test_init_rejects_invalid_timezone(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            config = Path(tmp) / "config.yaml"
            result = run_cli(
                "init",
                "--vault",
                str(vault),
                "--name",
                "Test",
                "--timezone",
                "NotARealTimezone",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(config)},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not a valid IANA name", result.stderr)
            # Vault must NOT be created when timezone validation fails up front
            # — we don't want a half-initialized state from a typo.
            self.assertFalse(vault.exists() and any(vault.iterdir()))

    def test_init_persist_survives_re_init_on_existing_vault(self):
        # Re-running `o2b init --agent-name X` on an already-bootstrapped vault
        # must still update the plugin config, not just exit early.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            config = Path(tmp) / "config.yaml"
            run_cli("init", "--vault", str(vault), "--name", "Test")
            # vault is now fully initialised; second invocation should still persist
            result = run_cli(
                "init",
                "--vault",
                str(vault),
                "--name",
                "Test",
                "--agent-name",
                "hermes-vps-agent",
                env={"OPEN_SECOND_BRAIN_CONFIG": str(config)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("agent name persisted to:", result.stdout)
            self.assertIn("hermes-vps-agent", config.read_text(encoding="utf-8"))

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
            result = run_cli(
                "doctor",
                "--vault",
                str(vault),
                env={
                    "OPEN_SECOND_BRAIN_CONFIG": "",
                    "XDG_CONFIG_HOME": "",
                    "VAULT_DIR": "",
                },
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("[OK]", result.stdout)
            self.assertIn("vault", result.stdout.lower())

    def test_doctor_reports_missing_vault(self):
        result = run_cli("doctor", "--vault", "/nonexistent/path")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("[FAIL]", result.stdout)

    def test_doctor_with_repo_checks_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = create_sandbox_vault(Path(tmp))
            repo = create_plugin_repo(Path(tmp), valid=True)
            result = run_cli("doctor", "--vault", str(vault), "--repo", str(repo))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("claude_manifest", result.stdout)
            self.assertIn("codex_manifest", result.stdout)
            self.assertIn("hermes_manifest", result.stdout)

    def test_doctor_with_repo_rejects_invalid_manifest_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = create_sandbox_vault(Path(tmp))
            repo = create_plugin_repo(Path(tmp), valid=False)
            result = run_cli("doctor", "--vault", str(vault), "--repo", str(repo))
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("[FAIL] claude_manifest", result.stdout)
            self.assertIn("[FAIL] codex_manifest", result.stdout)

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

    def test_index_generates_wikilink_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "AI Wiki").mkdir(parents=True)
            (vault / "Concept.md").write_text(
                "---\ntitle: Concept\n---\n\nBody.", encoding="utf-8"
            )
            (vault / "Other.md").write_text("No frontmatter.", encoding="utf-8")
            result = run_cli("index", "--vault", str(vault))
            self.assertEqual(result.returncode, 0, result.stderr)
            index_path = vault / "AI Wiki" / "index.md"
            self.assertTrue(index_path.is_file())
            content = index_path.read_text(encoding="utf-8")
            self.assertIn("[[Concept]]", content)
            self.assertIn("[[Other]]", content)


if __name__ == "__main__":
    unittest.main()
