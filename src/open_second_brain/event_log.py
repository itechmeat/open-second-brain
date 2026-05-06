from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

SECRET_ASSIGNMENT_RE = re.compile(
    r"\b(api[_-]?key|token|secret|password|credential)(\s*[:=]\s*)([^\s]+)",
    re.IGNORECASE,
)
EVENT_RE = re.compile(r"^- (\d{2}:\d{2}) — @")


def redact_text(text: str) -> str:
    return SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text)


def current_date() -> str:
    return datetime.now().strftime("%Y.%m.%d")


def current_time() -> str:
    return datetime.now().strftime("%H:%M")


def daily_note_path(vault_dir: Path, date: str) -> Path:
    return vault_dir / "Daily" / f"{date}.md"


def new_daily_note(date: str) -> str:
    return f"---\nformatted: false\n---\n\n# {date}\n\n## Raw events\n\n"


def append_event(
    vault_dir: Path,
    agent: str,
    message: str,
    *,
    date: str | None = None,
    time: str | None = None,
) -> Path:
    event_date = date or current_date()
    event_time = time or current_time()
    path = daily_note_path(vault_dir, event_date)
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        content = path.read_text(encoding="utf-8")
    else:
        content = new_daily_note(event_date)

    if "## Raw events" not in content:
        content = content.rstrip() + "\n\n## Raw events\n\n"

    entry = f"- {event_time} — @{agent} — {redact_text(message).replace(chr(10), ' ')}"
    updated = insert_event_entry(content, entry)
    path.write_text(updated, encoding="utf-8")
    return path


def insert_event_entry(content: str, entry: str) -> str:
    marker = "## Raw events"
    before, after = content.split(marker, 1)
    after = after.lstrip("\n")
    lines = [line for line in after.splitlines() if line.strip()]

    entry_time = entry[2:7]
    inserted = False
    output: list[str] = []
    for line in lines:
        match = EVENT_RE.match(line)
        if not inserted and match and match.group(1) > entry_time:
            output.append(entry)
            inserted = True
        output.append(line)
    if not inserted:
        output.append(entry)

    raw_events = "\n".join(output)
    if raw_events:
        raw_events += "\n"
    return before + marker + "\n\n" + raw_events
