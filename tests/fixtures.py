from __future__ import annotations

from pathlib import Path


def create_sandbox_vault(root: Path, *, name: str = "Sandbox Brain") -> Path:
    """Create a small Obsidian-compatible sandbox vault for tests."""

    vault = root / "sandbox-vault"
    (vault / "AI Wiki").mkdir(parents=True, exist_ok=True)
    (vault / "Daily").mkdir(parents=True, exist_ok=True)
    (vault / "AI Wiki" / "_OPEN_SECOND_BRAIN.md").write_text(
        f"---\ntitle: {name}\ntype: operating-manual\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    (vault / "AI Wiki" / "Concept.md").write_text(
        "---\ntitle: Sandbox Concept\n---\n\nLinked to [[Other]].\n",
        encoding="utf-8",
    )
    (vault / "Other.md").write_text("# Other\n", encoding="utf-8")
    return vault


def create_plugin_repo(root: Path, *, valid: bool = True) -> Path:
    """Create a minimal repo fixture containing plugin manifests."""

    repo = root / "plugin-repo"
    (repo / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (repo / ".codex-plugin").mkdir(parents=True, exist_ok=True)
    (repo / "plugins" / "hermes").mkdir(parents=True, exist_ok=True)
    if valid:
        (repo / ".claude-plugin" / "plugin.json").write_text(
            """{
  "name": "test",
  "version": "1.0.0",
  "description": "test manifest",
  "author": "tests",
  "license": "MIT",
  "repository": "https://example.invalid/test",
  "keywords": ["test"],
  "commands": [
    {"name": "status", "description": "status", "command": "scripts/o2b", "args": ["status"]}
  ]
}
""",
            encoding="utf-8",
        )
        (repo / ".codex-plugin" / "plugin.json").write_text(
            """{
  "name": "test",
  "version": "1.0.0",
  "description": "test manifest",
  "skills": "./skills",
  "keywords": ["test"]
}
""",
            encoding="utf-8",
        )
        (repo / "plugins" / "hermes" / "plugin.yaml").write_text(
            "name: test\nversion: \"1.0.0\"\ndescription: test manifest\n",
            encoding="utf-8",
        )
        (repo / "openclaw.plugin.json").write_text(
            """{
  "id": "test-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
""",
            encoding="utf-8",
        )
        # Native OpenClaw plugin packaging: package.json + extension entry
        entry_js = repo / "openclaw" / "index.js"
        entry_js.parent.mkdir(parents=True, exist_ok=True)
        entry_js.write_text("// plugin entry\n", encoding="utf-8")
        (repo / "package.json").write_text(
            """{"name": "test-plugin", "openclaw": {"extensions": ["./openclaw/index.js"]}}""",
            encoding="utf-8",
        )
    else:
        (repo / ".claude-plugin" / "plugin.json").write_text("{\"name\": \"test\"}", encoding="utf-8")
        (repo / ".codex-plugin" / "plugin.json").write_text("{\"name\": \"test\"}", encoding="utf-8")
        (repo / "plugins" / "hermes" / "plugin.yaml").write_text("name: test\n", encoding="utf-8")
        (repo / "openclaw.plugin.json").write_text("{}", encoding="utf-8")
    return repo
