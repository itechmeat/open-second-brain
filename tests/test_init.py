import tempfile
import unittest
from pathlib import Path

from open_second_brain.init import AGENTS_PLACEHOLDER, bootstrap_vault, VAULT_FILES


class InitTests(unittest.TestCase):
    def test_bootstrap_vault_creates_structure(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            created = bootstrap_vault(vault, name="Test Brain")
            self.assertGreater(len(created), 0)
            self.assertIn(Path("AI Wiki") / "_OPEN_SECOND_BRAIN.md", created)
            self.assertIn(Path("AI Wiki") / "_open-second-brain.yaml", created)
            self.assertIn(Path("AI Wiki") / "index.md", created)
            self.assertIn(Path("AI Wiki") / "hot.md", created)
            self.assertIn(Path("AI Wiki") / "log.md", created)
            self.assertIn(Path("AI Wiki") / "identity" / "user.md", created)
            self.assertIn(Path("AI Wiki") / "identity" / "agents.md", created)

            # Verify all files exist
            for rel_path in VAULT_FILES:
                self.assertTrue((vault / rel_path).is_file(), f"Missing {rel_path}")

            # Check content has the name
            manual = (vault / "AI Wiki" / "_OPEN_SECOND_BRAIN.md").read_text(encoding="utf-8")
            self.assertIn("Test Brain", manual)

    def test_bootstrap_vault_writes_agent_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            bootstrap_vault(vault, name="Test", agent_name="openclaw-main")
            agents_md = (vault / "AI Wiki" / "identity" / "agents.md").read_text(
                encoding="utf-8"
            )
            self.assertIn("- openclaw-main: primary agent on this server", agents_md)
            self.assertNotIn(AGENTS_PLACEHOLDER, agents_md)

    def test_bootstrap_vault_without_agent_name_keeps_placeholder(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            bootstrap_vault(vault, name="Test")
            agents_md = (vault / "AI Wiki" / "identity" / "agents.md").read_text(
                encoding="utf-8"
            )
            self.assertIn(AGENTS_PLACEHOLDER, agents_md)

    def test_bootstrap_vault_registers_second_agent_when_first_already_present(self):
        # Multi-runtime install: a previous `o2b init --agent-name X`
        # already replaced the placeholder, so this run's agent name
        # has to be APPENDED to the existing list, not skipped. Before
        # this fix the second invocation was a silent no-op: the
        # plugin config got the new identity but the vault registry
        # never learned about it. Both Codex and Claude install
        # sessions hit this in practice.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            bootstrap_vault(vault, name="Test", agent_name="hermes-vps-agent")
            agents_path = vault / "AI Wiki" / "identity" / "agents.md"
            first_text = agents_path.read_text(encoding="utf-8")
            self.assertIn("- hermes-vps-agent: primary agent on this server", first_text)
            self.assertNotIn(AGENTS_PLACEHOLDER, first_text)

            created = bootstrap_vault(vault, name="Test", agent_name="codex-vps-agent")
            self.assertIn(Path("AI Wiki") / "identity" / "agents.md", created)
            text = agents_path.read_text(encoding="utf-8")
            # Both agents are present, in registration order.
            self.assertIn("- hermes-vps-agent: primary agent on this server", text)
            self.assertIn("- codex-vps-agent: primary agent on this server", text)
            self.assertLess(
                text.index("hermes-vps-agent"),
                text.index("codex-vps-agent"),
                "first-registered agent must come first",
            )
            # The "## Scopes" section that follows must still be intact.
            self.assertIn("## Scopes", text)
            self.assertLess(
                text.index("codex-vps-agent"),
                text.index("## Scopes"),
                "new agent must be inserted under '## Registered agents', "
                "not after the next section header",
            )

            # A third register of an already-present name is a no-op.
            created_again = bootstrap_vault(vault, name="Test", agent_name="codex-vps-agent")
            self.assertNotIn(Path("AI Wiki") / "identity" / "agents.md", created_again)
            text_after = agents_path.read_text(encoding="utf-8")
            self.assertEqual(
                text_after.count("- codex-vps-agent: primary agent on this server"),
                1,
                "re-registering an existing agent must not duplicate the entry",
            )

    def test_bootstrap_vault_upgrades_existing_placeholder_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            # First init without agent name leaves placeholder.
            bootstrap_vault(vault, name="Test")
            agents_path = vault / "AI Wiki" / "identity" / "agents.md"
            self.assertIn(AGENTS_PLACEHOLDER, agents_path.read_text(encoding="utf-8"))

            # Second init with agent_name (no --force) must rewrite the placeholder.
            created = bootstrap_vault(vault, name="Test", agent_name="hermes-main")
            self.assertIn(Path("AI Wiki") / "identity" / "agents.md", created)
            text = agents_path.read_text(encoding="utf-8")
            self.assertIn("- hermes-main: primary agent on this server", text)
            self.assertNotIn(AGENTS_PLACEHOLDER, text)

    def test_bootstrap_vault_does_not_overwrite_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            index_path = vault / "AI Wiki" / "index.md"
            index_path.parent.mkdir(parents=True)
            index_path.write_text("custom content", encoding="utf-8")

            created = bootstrap_vault(vault, name="Test")
            # index.md should NOT be in created (already exists)
            self.assertNotIn(Path("AI Wiki") / "index.md", created)
            # But other files should be created
            self.assertIn(Path("AI Wiki") / "_OPEN_SECOND_BRAIN.md", created)
            # Original content preserved
            self.assertEqual(index_path.read_text(encoding="utf-8"), "custom content")

    def test_bootstrap_vault_force_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            index_path = vault / "AI Wiki" / "index.md"
            index_path.parent.mkdir(parents=True)
            index_path.write_text("old", encoding="utf-8")

            created = bootstrap_vault(vault, name="Test", force=True)
            self.assertIn(Path("AI Wiki") / "index.md", created)
            # Content should be overwritten with template
            self.assertNotEqual(index_path.read_text(encoding="utf-8"), "old")


if __name__ == "__main__":
    unittest.main()
