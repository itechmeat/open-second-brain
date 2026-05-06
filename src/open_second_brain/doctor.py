from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


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


def check_json_manifest(path: Path, description: str) -> CheckResult:
    if not path.is_file():
        return CheckResult(description, False, f"missing: {path}")
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return CheckResult(description, False, f"invalid JSON: {path} ({exc})")
    return CheckResult(description, True, f"valid: {path}")


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
        results.append(check_json_manifest(repo_root / ".claude-plugin" / "plugin.json", "claude_manifest"))
        results.append(check_json_manifest(repo_root / ".codex-plugin" / "plugin.json", "codex_manifest"))

    return results
