"""Tests for the Claude Code single-plugin marketplace setup.

Claude Code 2.x installs plugins via ``claude plugin marketplace add``
followed by ``claude plugin install <plugin>@<marketplace>``. The
marketplace step expects ``.claude-plugin/marketplace.json``; the install
step then reads ``.claude-plugin/plugin.json`` for the plugin manifest.

When Claude installs the plugin, it also auto-registers any MCP servers
declared in ``.mcp.json`` at the plugin root — no separate ``claude mcp
add`` is needed when the file is present.

These tests pin the contract of all three artifacts so that
install.md branch D continues to describe a working flow.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ClaudeMarketplaceManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = ROOT / ".claude-plugin" / "marketplace.json"
        cls.manifest = json.loads(cls.path.read_text(encoding="utf-8"))

    def test_file_present(self):
        self.assertTrue(self.path.is_file(), f"missing: {self.path}")

    def test_top_level_required_fields(self):
        self.assertEqual(self.manifest["name"], "open-second-brain")
        owner = self.manifest["owner"]
        self.assertIsInstance(owner, dict)
        self.assertIsInstance(owner.get("name"), str)
        self.assertIsInstance(self.manifest.get("plugins"), list)
        self.assertGreaterEqual(len(self.manifest["plugins"]), 1)

    def test_self_marketplace_plugin_entry(self):
        plugin = self.manifest["plugins"][0]
        # Same name as the marketplace — this is the documented
        # "self-marketplace" pattern for single-plugin repos.
        self.assertEqual(plugin["name"], "open-second-brain")
        # ``./`` (or ``.``) means "this repository is the plugin"; it
        # resolves to the directory containing ``marketplace.json``'s repo
        # root, where ``.claude-plugin/plugin.json`` already lives.
        self.assertIn(plugin["source"].rstrip("/"), {"", "."})
        self.assertIn("description", plugin)


class ClaudePluginManifestTests(unittest.TestCase):
    """The Claude 2.x manifest schema requires ``author`` to be an
    object (``{"name": ...}``); the legacy string form was rejected by
    the validator with ``author: Invalid input``. Embedded slash command
    arrays are likewise no longer accepted; they must be authored as
    Markdown files under ``commands/`` at the plugin root.
    """

    @classmethod
    def setUpClass(cls):
        cls.path = ROOT / ".claude-plugin" / "plugin.json"
        cls.manifest = json.loads(cls.path.read_text(encoding="utf-8"))

    def test_required_fields(self):
        self.assertEqual(self.manifest["name"], "open-second-brain")
        self.assertIsInstance(self.manifest["version"], str)
        self.assertIsInstance(self.manifest["description"], str)

    def test_author_is_object_form(self):
        author = self.manifest.get("author")
        if author is not None:
            self.assertIsInstance(
                author, dict,
                "author must be object form per Claude 2.x schema",
            )
            self.assertIsInstance(author.get("name"), str)

    def test_legacy_commands_array_absent(self):
        # The historical ``commands: [{name, command, args, ...}]`` array
        # is rejected by current Claude as ``Invalid input``. If it
        # creeps back in, install will start failing again on every
        # 2.x install.
        self.assertNotIn(
            "commands", self.manifest,
            "embedded 'commands' array is deprecated; author them as "
            "Markdown files under commands/ at plugin root instead",
        )


class ClaudeMcpJsonTests(unittest.TestCase):
    """``.mcp.json`` at the plugin root is auto-registered by Claude
    when the plugin is installed. The ``${CLAUDE_PLUGIN_ROOT}`` variable
    is expanded by Claude to the cached plugin path, so no absolute
    path lives in the file.
    """

    @classmethod
    def setUpClass(cls):
        cls.path = ROOT / ".mcp.json"
        cls.data = json.loads(cls.path.read_text(encoding="utf-8"))

    def test_file_present(self):
        self.assertTrue(self.path.is_file(), f"missing: {self.path}")

    def test_declares_open_second_brain_server(self):
        servers = self.data["mcpServers"]
        self.assertIn("open-second-brain", servers)
        entry = servers["open-second-brain"]
        self.assertIn("${CLAUDE_PLUGIN_ROOT}", entry["command"])
        self.assertIn("scripts/o2b", entry["command"])
        self.assertEqual(entry["args"], ["mcp"])

    def test_no_vault_or_env_baked_in(self):
        # The plugin's MCP entry must be portable — agent name, vault,
        # and timezone all come from the on-disk plugin config (set by
        # ``o2b init``), not from ``.mcp.json``. If somebody puts those
        # back here, the auto-register flow becomes machine-specific
        # and the install.md instructions break for new users.
        entry = self.data["mcpServers"]["open-second-brain"]
        self.assertNotIn("--vault", entry.get("args", []))
        env = entry.get("env", {})
        self.assertNotIn("VAULT_AGENT_NAME", env)
        self.assertNotIn("VAULT_TIMEZONE", env)
        self.assertNotIn("VAULT_DIR", env)


if __name__ == "__main__":
    unittest.main()
