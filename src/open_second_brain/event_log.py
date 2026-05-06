from __future__ import annotations

import fcntl
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

SECRET_ASSIGNMENT_RE = re.compile(
    r"\b(api[_-]?key|token|secret|password|credential)(\s*[:=]\s*)([^\s]+)",
    re.IGNORECASE,
)
EVENT_RE = re.compile(r"^- (\d{2}:\d{2}) — @")
TIME_RE = re.compile(r"^(\d{2}):(\d{2})$")


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


def validate_event_time(value: str) -> str:
    match = TIME_RE.match(value)
    if not match:
        raise ValueError("event time must use HH:MM 24-hour format")
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23 or minute > 59:
        raise ValueError("event time must use HH:MM 24-hour format")
    return value


def append_event(
    vault_dir: Path,
    agent: str,
    message: str,
    *,
    date: str | None = None,
    time: str | None = None,
) -> Path:
    event_date = date or current_date()
    event_time = validate_event_time(time or current_time())
    path = daily_note_path(vault_dir, event_date)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f".{path.name}.lock")

    entry = f"- {event_time} — @{agent} — {redact_text(message).replace(chr(10), ' ')}"
    temp_name: str | None = None

    with lock_path.open("a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            if path.exists():
                content = path.read_text(encoding="utf-8")
            else:
                content = new_daily_note(event_date)

            if "## Raw events" not in content:
                content = content.rstrip() + "\n\n## Raw events\n\n"

            updated = insert_event_entry(content, entry)
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temp_file:
                temp_name = temp_file.name
                temp_file.write(updated)
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_name, path)
            temp_name = None
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
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
