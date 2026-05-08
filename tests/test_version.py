"""Lock the contract that ``__version__`` reads from ``pyproject.toml``.

The package version is the single source of truth in ``pyproject.toml``.
Several other files (manifests, package.json) carry a synced copy and are
kept aligned by ``scripts/sync-version.py``. These tests guard the two
properties that matter:

  - ``open_second_brain.__version__`` matches the canonical value in
    ``pyproject.toml`` (so a bump there is visible at runtime without a
    pip reinstall).
  - ``MCPServer`` advertises the same value in its ``serverInfo.version``.
  - The synced manifests (root ``plugin.yaml`` etc.) all carry the same
    string — i.e. nothing has drifted in the working tree.
"""

import json
import re
import tomllib
import unittest
from pathlib import Path

from open_second_brain import __version__
from open_second_brain.mcp import SERVER_VERSION

ROOT = Path(__file__).resolve().parents[1]


def _canonical_version() -> str:
    with (ROOT / "pyproject.toml").open("rb") as fh:
        return tomllib.load(fh)["project"]["version"]


class VersionResolutionTests(unittest.TestCase):
    def test_package_version_matches_pyproject(self):
        self.assertEqual(__version__, _canonical_version())

    def test_mcp_server_version_matches_package(self):
        self.assertEqual(SERVER_VERSION, __version__)


class ManifestVersionSyncTests(unittest.TestCase):
    """Re-implement the read part of ``scripts/sync-version.py`` to assert
    that every manifest in the working tree currently equals the canonical
    version. If this fails, ``python3 scripts/sync-version.py`` from the
    repo root will fix it.
    """

    def setUp(self):
        self.canonical = _canonical_version()

    def _read_yaml_version(self, rel: str) -> str:
        text = (ROOT / rel).read_text(encoding="utf-8")
        match = re.search(r'^version:\s*"([^"]+)"', text, re.MULTILINE)
        self.assertIsNotNone(match, f"no version line in {rel}")
        return match.group(1)

    def _read_json_version(self, rel: str) -> str:
        data = json.loads((ROOT / rel).read_text(encoding="utf-8"))
        version = data.get("version")
        self.assertIsInstance(version, str, f"no version key in {rel}")
        return version

    def test_root_plugin_yaml(self):
        self.assertEqual(self._read_yaml_version("plugin.yaml"), self.canonical)

    def test_inner_plugins_hermes_yaml(self):
        self.assertEqual(self._read_yaml_version("plugins/hermes/plugin.yaml"), self.canonical)

    def test_package_json(self):
        self.assertEqual(self._read_json_version("package.json"), self.canonical)

    def test_claude_plugin_json(self):
        self.assertEqual(self._read_json_version(".claude-plugin/plugin.json"), self.canonical)

    def test_codex_plugin_json(self):
        self.assertEqual(self._read_json_version(".codex-plugin/plugin.json"), self.canonical)

    def test_openclaw_plugin_json(self):
        self.assertEqual(self._read_json_version("openclaw.plugin.json"), self.canonical)


if __name__ == "__main__":
    unittest.main()
