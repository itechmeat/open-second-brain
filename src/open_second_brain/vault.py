from __future__ import annotations

import re
from pathlib import Path
from typing import Any

# ── Frontmatter parsing ───────────────────────────────────────────────────────

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_KEY_VALUE_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$")


def parse_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    """Return (metadata dict, body text) from a Markdown file with YAML-like frontmatter.

    Handles the standard Obsidian format:
        ---
        key: value
        ---
        body text

    Only simple key: value lines are supported (no nested YAML, no lists).
    Returns (metadata dict, body text) from a Markdown file with YAML-like frontmatter.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}, ""

    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text.strip()

    fm_block = match.group(1)
    body = text[match.end():].strip()
    metadata: dict[str, Any] = {}

    for line in fm_block.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        kv = _KEY_VALUE_RE.match(line)
        if kv:
            key = kv.group(1)
            value = kv.group(2)
            metadata[key] = value.strip("'\"")

    return metadata, body


_PLAIN_SCALAR_RE = re.compile(r"^[A-Za-z0-9_./-](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$")


def _format_yaml_scalar(value: Any) -> str:
    text = str(value)
    if (
        text
        and _PLAIN_SCALAR_RE.match(text)
        and ": " not in text
        and " #" not in text
    ):
        return text
    escaped = (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def _format_yaml_value(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(_format_yaml_scalar(item) for item in value) + "]"
    return _format_yaml_scalar(value)


def write_frontmatter(path: Path, metadata: dict[str, Any], body: str) -> None:
    """Write a Markdown file with YAML-like frontmatter and body text.

    Lists are serialized as YAML inline arrays (``key: [a, b]``) so they round-trip
    cleanly through Obsidian and the project's simple frontmatter parser.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["---"]
    for key, value in metadata.items():
        lines.append(f"{key}: {_format_yaml_value(value)}")
    lines.append("---")
    if body:
        lines.append("")
        lines.append(body)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── Wikilink extraction ───────────────────────────────────────────────────────

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
_MEDIA_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tiff", ".avif",
    ".mp4", ".webm", ".ogv", ".mov", ".mkv", ".avi",
    ".mp3", ".wav", ".ogg", ".flac", ".m4a",
    ".pdf",
})


def extract_wikilinks(content: str) -> list[str]:
    """Return unique [[target]] titles from content, excluding media file targets.

    Also skips targets inside fenced code blocks and inline code spans.
    """
    # Mask code blocks to avoid false positives inside code samples
    code_blocks_re = re.compile(r"```[\s\S]*?```|`[^`]+`")
    masked = code_blocks_re.sub(" ", content)
    raw = _WIKILINK_RE.findall(masked)
    seen: set[str] = set()
    result: list[str] = []
    for target in raw:
        if any(target.lower().endswith(ext) for ext in _MEDIA_EXTENSIONS):
            continue
        if target not in seen:
            seen.add(target)
            result.append(target)
    return result


# ── Vault page listing ────────────────────────────────────────────────────────

def list_vault_pages(
    vault_dir: Path,
    *,
    skip_dirs: tuple[str, ...] = (".git", ".obsidian", ".trash", ".stversions"),
    skip_files: tuple[str, ...] = ("index.md", "log.md"),
) -> list[tuple[str, Path, dict[str, Any]]]:
    """Walk a vault directory and return all Markdown pages with their metadata.

    Returns list of (title, path, metadata) sorted by title (case-insensitive).
    Title is resolved from frontmatter 'title' key, else filename stem.
    """
    pages: list[tuple[str, Path, dict[str, Any]]] = []

    for md_path in sorted(vault_dir.rglob("*.md")):
        # Skip excluded directories
        parts = set(str(p) for p in md_path.relative_to(vault_dir).parts)
        if parts & set(skip_dirs):
            continue
        # Skip excluded files (check filename only, case-insensitive)
        if md_path.name.lower() in skip_files:
            continue
        try:
            meta, body = parse_frontmatter(md_path)
        except Exception:
            continue
        title = meta.get("title", md_path.stem)
        pages.append((title, md_path, meta))

    pages.sort(key=lambda t: t[0].lower())
    return pages
