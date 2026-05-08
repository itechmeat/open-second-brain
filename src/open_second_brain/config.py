from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SECRET_KEY_PARTS = ("key", "token", "secret", "password", "credential")


@dataclass(frozen=True)
class ConfigDiscovery:
    path: Path
    exists: bool
    data: dict[str, str]


def default_config_path() -> Path:
    override = os.environ.get("OPEN_SECOND_BRAIN_CONFIG")
    if override:
        return Path(override).expanduser()

    config_home = os.environ.get("XDG_CONFIG_HOME")
    if config_home:
        return Path(config_home).expanduser() / "open-second-brain" / "config.yaml"

    return Path.home() / ".config" / "open-second-brain" / "config.yaml"


def parse_simple_yaml(text: str) -> dict[str, str]:
    data: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            data[key] = value
    return data


def discover_config(path: Path | None = None) -> ConfigDiscovery:
    resolved = path or default_config_path()
    if not resolved.is_file():
        return ConfigDiscovery(path=resolved, exists=False, data={})
    try:
        data = parse_simple_yaml(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return ConfigDiscovery(path=resolved, exists=False, data={})
    return ConfigDiscovery(path=resolved, exists=True, data=data)


_CONFIG_VALUE_REJECTED_CHARS = ('"', "\\", "\n", "\r")


def set_config_value(key: str, value: str, path: Path | None = None) -> Path:
    """Persist a single ``key: value`` pair into the plugin config file.

    Reads any existing keys, merges/overrides ``key`` with ``value``, writes the
    full set back. Creates parent directories if missing. Used by ``o2b init``
    to make ``agent_name`` survive without relying on the ``VAULT_AGENT_NAME``
    env, which not every runtime propagates to the MCP subprocess.

    Values are written as ``key: "value"`` and read back by the simple
    parser in ``parse_simple_yaml``. The parser does not understand
    escape sequences, so values containing characters that would break
    the line shape (``"``, ``\\``, ``\\n``, ``\\r``) are rejected up
    front rather than being silently corrupted on round-trip. The
    fields this helper is used for in practice (``vault`` paths,
    IANA timezone names, agent identifiers) never legitimately contain
    those characters.

    The write is atomic: contents are first written to a sibling temp
    file in the same directory, ``fsync``'d, then ``os.replace``'d
    over the target. An interrupted run leaves either the previous
    config or the new one — never a half-written hybrid.
    """
    if not isinstance(value, str):
        raise TypeError(f"config value for {key!r} must be a string, got {type(value).__name__}")
    for bad in _CONFIG_VALUE_REJECTED_CHARS:
        if bad in value:
            raise ValueError(
                f"config value for {key!r} contains a disallowed character "
                f"({bad!r}); reject rather than silently corrupting on read-back"
            )

    resolved = path or default_config_path()
    discovery = discover_config(resolved)
    data = dict(discovery.data)
    data[key] = value
    resolved.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(f'{k}: "{v}"' for k, v in data.items()) + "\n"

    import tempfile

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{resolved.name}.",
        suffix=".tmp",
        dir=str(resolved.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, resolved)
    except BaseException:
        # Clean up the temp file if anything went wrong before the
        # atomic replace landed; fdopen takes ownership of the fd, so
        # only the path needs explicit cleanup here.
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise
    return resolved


def resolve_timezone(config_path: Path | None = None):
    """Resolve the user's preferred timezone for Daily event log entries.

    Resolution order (first hit wins):
      1. ``VAULT_TIMEZONE`` environment variable (IANA name, e.g.
         ``Europe/Belgrade``).
      2. ``timezone`` field in the plugin config file.
      3. ``None`` — caller falls back to the system's local time
         (``datetime.now()`` without ``tz``).

    Returns either a ``zoneinfo.ZoneInfo`` instance or ``None``. Invalid
    names are silently treated as not configured rather than raised, so a
    typo in the env or config never breaks logging — entries still land,
    just stamped in server-local time.
    """
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    except ImportError:
        return None

    name = os.environ.get("VAULT_TIMEZONE")
    if not name:
        discovery = discover_config(config_path)
        name = discovery.data.get("timezone")
    if not name:
        return None
    try:
        return ZoneInfo(str(name))
    except (ZoneInfoNotFoundError, ValueError):
        return None


def resolve_vault(config_path: Path | None = None) -> Path | None:
    """Resolve the vault directory the plugin should operate on.

    Resolution order (first hit wins):
      1. ``VAULT_DIR`` environment variable (legacy, kept for backward
         compatibility with older runner scripts).
      2. ``vault`` field in the plugin config file.
      3. ``None`` — caller decides whether to error out or accept a
         positional ``--vault`` argument.

    The plugin config holds the ``vault`` field after a successful
    ``o2b init --vault <path>``. This lets MCP entrypoints (Claude's
    ``.mcp.json`` auto-register, Hermes' ``mcp_servers`` block, Codex's
    ``mcp_servers`` TOML) launch ``o2b mcp`` with no arguments — the
    plugin discovers the vault on its own.
    """
    env_value = os.environ.get("VAULT_DIR")
    if env_value:
        return Path(env_value).expanduser()
    discovery = discover_config(config_path)
    cfg_value = discovery.data.get("vault")
    if cfg_value:
        return Path(str(cfg_value)).expanduser()
    return None


def resolve_agent_name(config_path: Path | None = None) -> str:
    """Resolve the agent identity used when no explicit ``agent`` is supplied.

    Resolution order (first hit wins):
      1. ``VAULT_AGENT_NAME`` environment variable
      2. ``agent_name`` (or ``agentName``) in the plugin config file
      3. literal placeholder ``"agent"`` (last-resort sentinel)

    Shared between the MCP server's ``event_log_append`` default-agent
    resolution and the Hermes ``pre_llm_call`` hook so identity reads stay
    consistent across runtimes.
    """
    env_value = os.environ.get("VAULT_AGENT_NAME")
    if env_value:
        return env_value
    discovery = discover_config(config_path)
    config_value = discovery.data.get("agent_name") or discovery.data.get("agentName")
    if config_value:
        return config_value
    return "agent"


def redact_mapping(data: dict[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in data.items():
        lowered = key.lower()
        if any(part in lowered for part in SECRET_KEY_PARTS):
            redacted[key] = "[REDACTED]"
        else:
            redacted[key] = value
    return redacted
