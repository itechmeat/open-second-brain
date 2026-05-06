from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

VAULT_FILES: list[Path] = [
    Path("AI Wiki") / "_OPEN_SECOND_BRAIN.md",
    Path("AI Wiki") / "_open-second-brain.yaml",
    Path("AI Wiki") / "index.md",
    Path("AI Wiki") / "hot.md",
    Path("AI Wiki") / "log.md",
    Path("AI Wiki") / "identity" / "user.md",
    Path("AI Wiki") / "identity" / "agents.md",
]

TEMPLATES: dict[Path, str] = {
    Path("AI Wiki") / "_OPEN_SECOND_BRAIN.md": (
        "---\n"
        "open_second_brain_version: 1\n"
        "name: {name}\n"
        "created: {created}\n"
        "---\n\n"
        "# {name}\n\n"
        "This vault is managed by Open Second Brain.\n\n"
        "## Rules\n\n"
        "- Raw operational evidence goes into event log (Daily/).\n"
        "- Synthesized knowledge goes into the wiki (AI Wiki/).\n"
        "- Never write secrets, tokens, or credentials here.\n"
        "- Read the identity files before acting on this vault.\n"
    ),
    Path("AI Wiki") / "_open-second-brain.yaml": (
        "version: 1\n"
        "name: {name}\n"
        "created: {created}\n"
    ),
    Path("AI Wiki") / "index.md": (
        "# {name}\n\n"
        "Welcome to the {name} second brain.\n\n"
        "## Key pages\n\n"
        "- [[hot]] — short-term priority items.\n"
        "- [[log]] — durable operation log.\n"
        "- [[identity/user]] — owner profile.\n"
        "- [[identity/agents]] — allowed agents and scopes.\n"
    ),
    Path("AI Wiki") / "hot.md": (
        "# Hot\n\n"
        "Short-term items, current focus, active decisions.\n\n"
        "Items fade to cold over time.\n"
    ),
    Path("AI Wiki") / "log.md": (
        "# Operation Log\n\n"
        "Durable operations, major decisions, and infrastructure changes.\n\n"
        "The event log (Daily/) is raw chronological evidence.\n"
        "This page is synthesized operational knowledge.\n"
    ),
    Path("AI Wiki") / "identity" / "user.md": (
        "# User Identity\n\n"
        "Owner of this vault.\n\n"
        "## Profile\n\n"
        "- Name: (set your name)\n"
        "- Timezone: (set your timezone)\n"
        "- Contact: (set your primary contact)\n\n"
        "## Preferences\n\n"
        "(add durable preferences here so agents can read them)\n"
    ),
    Path("AI Wiki") / "identity" / "agents.md": (
        "# Agent Identity\n\n"
        "Allowed agents and their scopes.\n\n"
        "## Registered agents\n\n"
        "- (add your agents here, e.g., my-agent: operator on my-server)\n\n"
        "## Scopes\n\n"
        "- Write scope: AI Wiki/, Daily/\n"
        "- Read scope: whole vault\n"
    ),
}


def bootstrap_vault(
    vault_dir: Path,
    *,
    name: str = "Second Brain",
    force: bool = False,
) -> list[Path]:
    created: list[Path] = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    for rel_path in VAULT_FILES:
        target = vault_dir / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and not force:
            continue
        template = TEMPLATES.get(rel_path, "")
        content = template.format(name=name, created=now)
        target.write_text(content, encoding="utf-8")
        created.append(rel_path)

    return created
