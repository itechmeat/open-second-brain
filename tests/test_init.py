import tempfile
import unittest
from pathlib import Path

from open_second_brain.init import bootstrap_vault, VAULT_FILES


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
