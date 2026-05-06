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
    if not resolved.exists():
        return ConfigDiscovery(path=resolved, exists=False, data={})
    data = parse_simple_yaml(resolved.read_text(encoding="utf-8"))
    return ConfigDiscovery(path=resolved, exists=True, data=data)


def redact_mapping(data: dict[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in data.items():
        lowered = key.lower()
        if any(part in lowered for part in SECRET_KEY_PARTS):
            redacted[key] = "[REDACTED]"
        else:
            redacted[key] = value
    return redacted
