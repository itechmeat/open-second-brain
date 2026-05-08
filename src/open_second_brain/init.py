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
        "{agents_block}\n\n"
        "## Scopes\n\n"
        "- Write scope: AI Wiki/, Daily/\n"
        "- Read scope: whole vault\n"
    ),
}

AGENTS_PLACEHOLDER = "- (add your agents here, e.g., my-agent: operator on my-server)"


def _agents_block(agent_name: str | None) -> str:
    if agent_name:
        return f"- {agent_name}: primary agent on this server"
    return AGENTS_PLACEHOLDER


def bootstrap_vault(
    vault_dir: Path,
    *,
    name: str = "Second Brain",
    agent_name: str | None = None,
    force: bool = False,
) -> list[Path]:
    created: list[Path] = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    agents_block = _agents_block(agent_name)

    for rel_path in VAULT_FILES:
        target = vault_dir / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and not force:
            if rel_path == Path("AI Wiki") / "identity" / "agents.md" and agent_name:
                upgraded = _upgrade_agents_file(target, agent_name)
                if upgraded:
                    created.append(rel_path)
            continue
        template = TEMPLATES.get(rel_path, "")
        content = template.format(name=name, created=now, agents_block=agents_block)
        target.write_text(content, encoding="utf-8")
        created.append(rel_path)

    return created


_AGENTS_REGISTERED_HEADING = "## Registered agents"


def _upgrade_agents_file(path: Path, agent_name: str) -> bool:
    """Register ``agent_name`` in ``AI Wiki/identity/agents.md``.

    Three cases this handles, in order:

      * The file still contains the bootstrap placeholder
        (``- (add your agents here, …)``): replace the placeholder with
        ``- <agent_name>: primary agent on this server``.

      * The file already contains an entry for ``agent_name``: no-op.
        This makes ``o2b init --agent-name X`` idempotent on a vault
        that already has X registered.

      * Neither of the above — the file has already been initialised
        with **another** agent's entry, and this is a multi-runtime
        / multi-agent setup. Append the new entry under
        ``## Registered agents``, before the next ``##`` section
        heading. Previously this case was a silent no-op, so users
        running ``o2b init --agent-name codex-vps-agent`` after a
        prior ``--agent-name claude-vps-agent`` saw their identity
        recorded in the plugin config but never written into the
        vault registry. Fixed.

    Returns True when the file was actually rewritten.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False

    entry = f"- {agent_name}: primary agent on this server"
    if entry in text:
        return False

    if AGENTS_PLACEHOLDER in text:
        new_text = text.replace(AGENTS_PLACEHOLDER, entry)
        path.write_text(new_text, encoding="utf-8")
        return True

    # Multi-agent path: append under "## Registered agents". Locate the
    # heading and the next "##" that follows it (or end-of-file), and
    # insert the new bullet right before that boundary so subsequent
    # sections (e.g. "## Scopes") stay where the user expects them.
    heading_idx = text.find(_AGENTS_REGISTERED_HEADING)
    if heading_idx == -1:
        return False
    after_heading = heading_idx + len(_AGENTS_REGISTERED_HEADING)
    rest = text[after_heading:]
    next_section_relative = rest.find("\n## ")
    if next_section_relative == -1:
        head = text[:after_heading] + rest.rstrip()
        new_text = head + f"\n{entry}\n"
    else:
        boundary = after_heading + next_section_relative
        before = text[:boundary].rstrip()
        after = text[boundary:]
        new_text = before + f"\n{entry}\n" + after
    path.write_text(new_text, encoding="utf-8")
    return True
