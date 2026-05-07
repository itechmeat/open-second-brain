from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    message: str


def check_vault_writeable(vault: Path) -> CheckResult:
    if not vault.exists():
        return CheckResult("vault_writeable", False, f"vault directory missing: {vault}")
    test_path = vault / ".open-second-brain-doctor-test"
    try:
        test_path.touch()
        test_path.unlink()
    except OSError as exc:
        return CheckResult("vault_writeable", False, f"cannot write to vault: {exc}")
    return CheckResult("vault_writeable", True, f"vault exists and is writable: {vault}")


def check_config_writeable(config: Path) -> CheckResult:
    created_for_check = False
    try:
        config.parent.mkdir(parents=True, exist_ok=True)
        if not config.exists():
            created_for_check = True
        with config.open("a", encoding="utf-8"):
            pass
        if created_for_check:
            config.unlink()
    except OSError as exc:
        return CheckResult("config_writeable", False, f"cannot write config {config}: {exc}")
    return CheckResult("config_writeable", True, f"config writable: {config}")


def _load_json_manifest(path: Path, description: str) -> tuple[CheckResult, dict[str, Any] | None]:
    if not path.is_file():
        return CheckResult(description, False, f"missing: {path}"), None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return CheckResult(description, False, f"invalid JSON: {path} ({exc})"), None
    if not isinstance(data, dict):
        return CheckResult(description, False, f"invalid manifest object: {path}"), None
    return CheckResult(description, True, f"valid: {path}"), data


def check_json_manifest(path: Path, description: str) -> CheckResult:
    result, _ = _load_json_manifest(path, description)
    return result


def _validate_required_fields(data: dict[str, Any], required: dict[str, type | tuple[type, ...]]) -> list[str]:
    problems: list[str] = []
    for field, expected_type in required.items():
        if field not in data:
            problems.append(f"missing {field}")
            continue
        value = data[field]
        if not isinstance(value, expected_type):
            if isinstance(expected_type, tuple):
                type_names = "/".join(t.__name__ for t in expected_type)
            else:
                type_names = expected_type.__name__
            problems.append(f"{field} must be {type_names}")
        elif isinstance(value, str) and not value.strip():
            problems.append(f"{field} must not be empty")
        elif isinstance(value, list) and not value:
            problems.append(f"{field} must not be empty")
    return problems


def check_codex_manifest(path: Path) -> CheckResult:
    result, data = _load_json_manifest(path, "codex_manifest")
    if data is None:
        return result
    required = {
        "name": str,
        "version": str,
        "description": str,
        "skills": str,
        "keywords": list,
    }
    problems = _validate_required_fields(data, required)
    if problems:
        return CheckResult("codex_manifest", False, f"schema invalid: {path} ({'; '.join(problems)})")
    return CheckResult("codex_manifest", True, f"valid Codex manifest: {path}")


def check_claude_manifest(path: Path) -> CheckResult:
    result, data = _load_json_manifest(path, "claude_manifest")
    if data is None:
        return result
    required = {
        "name": str,
        "version": str,
        "description": str,
        "author": str,
        "license": str,
        "repository": str,
        "keywords": list,
        "commands": list,
    }
    problems = _validate_required_fields(data, required)
    commands = data.get("commands")
    if isinstance(commands, list):
        for index, command in enumerate(commands):
            if not isinstance(command, dict):
                problems.append(f"commands[{index}] must be object")
                continue
            for field in ("name", "description", "command"):
                value = command.get(field)
                if not isinstance(value, str) or not value.strip():
                    problems.append(f"commands[{index}].{field} must be non-empty string")
            args = command.get("args")
            if args is not None and not (isinstance(args, list) and all(isinstance(arg, str) for arg in args)):
                problems.append(f"commands[{index}].args must be list of strings")
    if problems:
        return CheckResult("claude_manifest", False, f"schema invalid: {path} ({'; '.join(problems)})")
    return CheckResult("claude_manifest", True, f"valid Claude manifest: {path}")


def check_hermes_manifest(path: Path) -> CheckResult:
    if not path.is_file():
        return CheckResult("hermes_manifest", False, f"missing: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        return CheckResult("hermes_manifest", False, f"invalid text: {path} ({exc})")
    required = ("name", "version", "description")
    missing = [field for field in required if not re.search(rf"^{field}\s*:", text, re.MULTILINE)]
    if missing:
        return CheckResult("hermes_manifest", False, f"schema invalid: {path} (missing {', '.join(missing)})")
    return CheckResult("hermes_manifest", True, f"readable Hermes manifest: {path}")


def check_openclaw_manifest(path: Path) -> CheckResult:
    result, data = _load_json_manifest(path, "openclaw_manifest")
    if data is None:
        return result
    problems: list[str] = []

    # Required top-level fields
    if "id" not in data or not isinstance(data["id"], str) or not data["id"].strip():
        problems.append("missing or empty field 'id'")
    schema = data.get("configSchema")
    if not isinstance(schema, dict) or not schema:
        problems.append("missing or empty field 'configSchema'")

    if problems:
        return CheckResult("openclaw_manifest", False, f"schema invalid: {path} ({'; '.join(problems)})")
    return CheckResult("openclaw_manifest", True, f"valid OpenClaw manifest: {path}")


def doctor(
    *,
    vault: Path,
    config: Path | None = None,
    repo_root: Path | None = None,
) -> list[CheckResult]:
    results: list[CheckResult] = []

    # Vault checks
    results.append(check_vault_writeable(vault))

    # Config checks
    if config is not None:
        results.append(check_config_writeable(config))

    # Plugin manifest checks (only if in repo context)
    if repo_root is not None:
        results.append(check_claude_manifest(repo_root / ".claude-plugin" / "plugin.json"))
        results.append(check_codex_manifest(repo_root / ".codex-plugin" / "plugin.json"))
        results.append(check_hermes_manifest(repo_root / "plugins" / "hermes" / "plugin.yaml"))
        results.append(check_openclaw_manifest(repo_root / "openclaw.plugin.json"))

    return results
