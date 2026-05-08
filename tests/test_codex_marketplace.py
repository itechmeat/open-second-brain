"""Tests for the Codex single-plugin marketplace manifest.

Codex 0.129+ installs plugins via ``codex plugin marketplace add``, which
expects a marketplace catalog at ``.agents/plugins/marketplace.json``. A
single-plugin repo like Open Second Brain still has to ship one — without
it, the install command fails with ``marketplace root does not contain a
supported manifest``.

These tests pin the contract of our shipped manifest: structure, required
fields, and that the relative ``source.path`` resolves to a directory
containing the Codex plugin manifest (``.codex-plugin/plugin.json``).
"""

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CodexMarketplaceManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest_path = ROOT / ".agents" / "plugins" / "marketplace.json"
        cls.manifest = json.loads(cls.manifest_path.read_text(encoding="utf-8"))

    def test_manifest_file_present(self):
        self.assertTrue(
            self.manifest_path.is_file(),
            f"marketplace manifest missing at {self.manifest_path}",
        )

    def test_top_level_required_fields(self):
        # Per the empirically-verified Codex schema (matched against the
        # bundled ``openai-curated`` marketplace), top-level requires
        # ``name``, ``interface.displayName``, and a list of ``plugins``.
        self.assertIsInstance(self.manifest.get("name"), str)
        self.assertEqual(self.manifest["name"], "open-second-brain")
        interface = self.manifest.get("interface")
        self.assertIsInstance(interface, dict)
        self.assertIsInstance(interface.get("displayName"), str)
        self.assertIsInstance(self.manifest.get("plugins"), list)
        self.assertGreaterEqual(len(self.manifest["plugins"]), 1)

    def test_single_plugin_entry_shape(self):
        plugin = self.manifest["plugins"][0]
        self.assertEqual(plugin["name"], "open-second-brain")
        source = plugin["source"]
        self.assertEqual(source["source"], "local")
        self.assertIsInstance(source["path"], str)
        policy = plugin["policy"]
        self.assertEqual(policy["installation"], "AVAILABLE")

    def test_plugin_source_path_lands_at_codex_plugin_manifest(self):
        # Codex resolves ``source.path`` relative to the marketplace's
        # repository root — not relative to ``.agents/plugins/``. Verified
        # against the curated marketplace where ``./plugins/linear`` lands
        # at ``<root>/plugins/linear``. Our ``.`` therefore lands at the
        # repo root, and the repo root is where ``.codex-plugin/plugin.json``
        # lives. If those assumptions ever drift, this test fails fast.
        plugin = self.manifest["plugins"][0]
        path = plugin["source"]["path"]
        target = (ROOT / path).resolve()
        self.assertTrue(
            (target / ".codex-plugin" / "plugin.json").is_file(),
            f"plugin source path {path!r} (resolved to {target}) does not "
            f"contain .codex-plugin/plugin.json",
        )

    def test_plugin_name_matches_codex_plugin_manifest(self):
        # Codex namespaces installed plugins as ``<plugin>@<marketplace>``.
        # Both halves come from JSON files in this repo: marketplace name
        # from this manifest's top-level ``name``, and plugin name from
        # ``.codex-plugin/plugin.json`` ``name``. They must agree, or the
        # install instructions in ``install.md`` Branch C will name a
        # plugin Codex cannot resolve.
        plugin_manifest_path = ROOT / ".codex-plugin" / "plugin.json"
        plugin_manifest = json.loads(plugin_manifest_path.read_text(encoding="utf-8"))
        marketplace_plugin_name = self.manifest["plugins"][0]["name"]
        self.assertEqual(marketplace_plugin_name, plugin_manifest["name"])


if __name__ == "__main__":
    unittest.main()
