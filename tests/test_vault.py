import tempfile
import unittest
from pathlib import Path

from open_second_brain.vault import (
    extract_wikilinks,
    list_vault_pages,
    parse_frontmatter,
    write_frontmatter,
)


class VaultTests(unittest.TestCase):
    def test_parse_frontmatter_extracts_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            path.write_text(
                "---\ntitle: Hello World\ntags: test, example\n---\n\nBody text.\n",
                encoding="utf-8",
            )
            meta, body = parse_frontmatter(path)
            self.assertEqual(meta["title"], "Hello World")
            self.assertEqual(meta["tags"], "test, example")
            self.assertEqual(body, "Body text.")

    def test_parse_frontmatter_no_frontmatter(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            path.write_text("Just a note.", encoding="utf-8")
            meta, body = parse_frontmatter(path)
            self.assertEqual(meta, {})
            self.assertEqual(body, "Just a note.")

    def test_parse_frontmatter_missing_file(self):
        meta, body = parse_frontmatter(Path("/nonexistent/file.md"))
        self.assertEqual(meta, {})
        self.assertEqual(body, "")

    def test_write_frontmatter_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            write_frontmatter(path, {"title": "Roundtrip"}, "The body.")
            meta, body = parse_frontmatter(path)
            self.assertEqual(meta["title"], "Roundtrip")
            self.assertEqual(body, "The body.")

    def test_write_frontmatter_serializes_list_values_as_inline_array(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            write_frontmatter(
                path,
                {"title": "Tagged", "tags": ["draft", "demo"]},
                "Body.",
            )
            text = path.read_text(encoding="utf-8")
            self.assertIn("tags: [draft, demo]", text)

    def test_write_frontmatter_quotes_list_values_with_special_chars(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            write_frontmatter(
                path,
                {"tags": ["plain", "needs, comma"]},
                "Body.",
            )
            text = path.read_text(encoding="utf-8")
            self.assertIn('tags: [plain, "needs, comma"]', text)

    def test_write_frontmatter_quotes_scalar_with_colon_space(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            write_frontmatter(path, {"title": "Hello: world"}, "Body.")
            text = path.read_text(encoding="utf-8")
            self.assertIn('title: "Hello: world"', text)

    def test_write_frontmatter_escapes_control_characters(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            write_frontmatter(path, {"summary": "line one\nline two"}, "Body.")
            text = path.read_text(encoding="utf-8")
            self.assertIn(r'summary: "line one\nline two"', text)

    def test_extract_wikilinks_simple(self):
        content = "See [[Target]] and [[Other]] for details."
        links = extract_wikilinks(content)
        self.assertEqual(links, ["Target", "Other"])

    def test_extract_wikilinks_ignores_media(self):
        content = "Look at ![[photo.png]] and [[concept]]."
        links = extract_wikilinks(content)
        self.assertEqual(links, ["concept"])

    def test_extract_wikilinks_ignores_code_blocks(self):
        content = "```\n[[not-a-link]]\n```\nReal: [[real-link]]"
        links = extract_wikilinks(content)
        self.assertEqual(links, ["real-link"])

    def test_extract_wikilinks_deduplicates(self):
        content = "[[A]] [[A]] [[B]]"
        links = extract_wikilinks(content)
        self.assertEqual(links, ["A", "B"])

    def test_list_vault_pages_discovers_markdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "page1.md").write_text("---\ntitle: Alpha\n---\n\nContent.", encoding="utf-8")
            (vault / "page2.md").write_text("Beta content without frontmatter.", encoding="utf-8")
            pages = list_vault_pages(vault)
            self.assertEqual(len(pages), 2)
            titles = [t for t, _, _ in pages]
            self.assertIn("Alpha", titles)
            self.assertIn("page2", titles)  # stem, no frontmatter title

    def test_list_vault_pages_skips_excluded_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "page.md").write_text("Content.", encoding="utf-8")
            (vault / ".obsidian").mkdir()
            (vault / ".obsidian" / "hidden.md").write_text("Hidden.", encoding="utf-8")
            pages = list_vault_pages(vault)
            self.assertEqual(len(pages), 1)

    def test_list_vault_pages_skips_excluded_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "page.md").write_text("Content.", encoding="utf-8")
            (vault / "index.md").write_text("Index.", encoding="utf-8")
            pages = list_vault_pages(vault)
            self.assertEqual(len(pages), 1)
            self.assertEqual(pages[0][0], "page")


if __name__ == "__main__":
    unittest.main()
