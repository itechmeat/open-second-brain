# CLI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace placeholder shell scripts with a tested Python CLI foundation for Open Second Brain.

**Architecture:** The repository will expose a small Python package under `src/open_second_brain/`. The CLI entrypoint will be `open_second_brain.cli:main`, with the existing `scripts/o2b` and `scripts/vault-log` shell wrappers delegating to Python modules. v0 keeps dependencies to the Python standard library.

**Tech Stack:** Python 3.11+, argparse, unittest, pathlib, json, datetime, tempfile.

---

## File Structure

- Create `pyproject.toml`: package metadata, Python requirement, console scripts for future installers.
- Create `src/open_second_brain/__init__.py`: package version.
- Create `src/open_second_brain/config.py`: config path discovery and minimal redacted status model.
- Create `src/open_second_brain/event_log.py`: append-only daily Markdown event log backend.
- Create `src/open_second_brain/cli.py`: `o2b` CLI with `status`, `init`, `doctor`, `append-event`, and `export-config` commands.
- Create `src/open_second_brain/vault_log.py`: compatibility CLI for `vault-log`.
- Modify `scripts/o2b`: shell wrapper that runs `python3 -m open_second_brain.cli` with local `src` on `PYTHONPATH`.
- Modify `scripts/vault-log`: shell wrapper that runs `python3 -m open_second_brain.vault_log` with local `src` on `PYTHONPATH`.
- Create `tests/test_config.py`: config path/status tests.
- Create `tests/test_event_log.py`: append-only daily Markdown backend tests.
- Create `tests/test_cli.py`: CLI smoke tests.
- Modify `README.md`: add CLI development/test commands.
- Modify `docs/roadmap.md`: mark CLI foundation as in progress/done after implementation.

## Task 1: Package Metadata

**Files:**
- Create: `pyproject.toml`
- Create: `src/open_second_brain/__init__.py`

- [ ] **Step 1: Add package metadata**

Create `pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "open-second-brain"
version = "0.0.1"
description = "Plugin-first second brain package for AI agents and humans."
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
authors = [{ name = "Open Second Brain contributors" }]
keywords = ["second-brain", "obsidian", "agents", "skills", "event-log"]
dependencies = []

[project.scripts]
o2b = "open_second_brain.cli:main"
vault-log = "open_second_brain.vault_log:main"

[tool.setuptools.packages.find]
where = ["src"]
```

Create `src/open_second_brain/__init__.py`:

```python
"""Open Second Brain core package."""

__version__ = "0.0.1"
```

- [ ] **Step 2: Verify metadata imports**

Run:

```bash
PYTHONPATH=src python3 -c "import open_second_brain; print(open_second_brain.__version__)"
```

Expected output:

```text
0.0.1
```

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml src/open_second_brain/__init__.py
git commit -m "chore: add python package metadata"
```

## Task 2: Config Discovery

**Files:**
- Create: `src/open_second_brain/config.py`
- Create: `tests/test_config.py`

- [ ] **Step 1: Write failing config tests**

Create `tests/test_config.py`:

```python
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from open_second_brain.config import default_config_path, discover_config, redact_mapping


class ConfigTests(unittest.TestCase):
    def test_default_config_path_uses_env_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "custom.yaml"
            with patch.dict(os.environ, {"OPEN_SECOND_BRAIN_CONFIG": str(path)}):
                self.assertEqual(default_config_path(), path)

    def test_default_config_path_uses_xdg_config_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": tmp}, clear=False):
                with patch.dict(os.environ, {"OPEN_SECOND_BRAIN_CONFIG": ""}, clear=False):
                    self.assertEqual(default_config_path(), Path(tmp) / "open-second-brain" / "config.yaml")

    def test_discover_config_reports_missing_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing.yaml"
            result = discover_config(path)
            self.assertFalse(result.exists)
            self.assertEqual(result.path, path)
            self.assertEqual(result.data, {})

    def test_discover_config_reads_simple_key_value_yaml(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.yaml"
            path.write_text("instance_name: Test Brain\nruntime: hermes\n", encoding="utf-8")
            result = discover_config(path)
            self.assertTrue(result.exists)
            self.assertEqual(result.data["instance_name"], "Test Brain")
            self.assertEqual(result.data["runtime"], "hermes")

    def test_redact_mapping_redacts_secret_like_keys(self):
        redacted = redact_mapping({"api_key": "abc", "path": "/tmp/vault", "token": "xyz"})
            
        self.assertEqual(redacted["api_key"], "[REDACTED]")
        self.assertEqual(redacted["token"], "[REDACTED]")
        self.assertEqual(redacted["path"], "/tmp/vault")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
PYTHONPATH=src python3 -m unittest tests.test_config -v
```

Expected: FAIL because `open_second_brain.config` does not exist yet.

- [ ] **Step 3: Implement config module**

Create `src/open_second_brain/config.py` with:

```python
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
    return ConfigDiscovery(path=resolved, exists=True, data=parse_simple_yaml(resolved.read_text(encoding="utf-8")))


def redact_mapping(data: dict[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in data.items():
        lowered = key.lower()
        if any(part in lowered for part in SECRET_KEY_PARTS):
            redacted[key] = "[REDACTED]"
        else:
            redacted[key] = value
    return redacted
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
PYTHONPATH=src python3 -m unittest tests.test_config -v
```

Expected: OK.

- [ ] **Step 5: Commit**

```bash
git add src/open_second_brain/config.py tests/test_config.py
git commit -m "feat: add config discovery"
```

## Task 3: Event Log Backend

**Files:**
- Create: `src/open_second_brain/event_log.py`
- Create: `tests/test_event_log.py`

- [ ] **Step 1: Write failing event log tests**

Create tests for daily Markdown creation, append-only behavior, explicit date/time, and secret redaction.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
PYTHONPATH=src python3 -m unittest tests.test_event_log -v
```

Expected: FAIL because `open_second_brain.event_log` does not exist yet.

- [ ] **Step 3: Implement event log module**

Implement `append_event(vault_dir, agent, message, date, time)` with default daily Markdown backend.

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
PYTHONPATH=src python3 -m unittest tests.test_event_log -v
```

Expected: OK.

- [ ] **Step 5: Commit**

```bash
git add src/open_second_brain/event_log.py tests/test_event_log.py
git commit -m "feat: add daily markdown event log backend"
```

## Task 4: CLI Commands

**Files:**
- Create: `src/open_second_brain/cli.py`
- Create: `src/open_second_brain/vault_log.py`
- Modify: `scripts/o2b`
- Modify: `scripts/vault-log`
- Create: `tests/test_cli.py`

- [ ] **Step 1: Write failing CLI tests**

Test `o2b status`, `o2b init`, `o2b doctor`, `o2b append-event`, and `vault-log --as` using temporary vault directories.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
PYTHONPATH=src python3 -m unittest tests.test_cli -v
```

Expected: FAIL because CLI modules do not exist yet.

- [ ] **Step 3: Implement CLI modules and wrappers**

Use argparse. Keep output stable and plain-text.

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
PYTHONPATH=src python3 -m unittest tests.test_cli -v
```

Expected: OK.

- [ ] **Step 5: Run full tests**

Run:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add src/open_second_brain/cli.py src/open_second_brain/vault_log.py scripts/o2b scripts/vault-log tests/test_cli.py
git commit -m "feat: add cli entrypoints"
```

## Task 5: Documentation Update and PR

**Files:**
- Modify: `README.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Document development commands**

Add commands for running tests and invoking local scripts.

- [ ] **Step 2: Run full verification**

Run:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
python3 -m json.tool .claude-plugin/plugin.json >/dev/null
python3 -m json.tool .codex-plugin/plugin.json >/dev/null
python3 -m py_compile plugins/hermes/__init__.py
bash -n scripts/o2b
bash -n scripts/vault-log
```

Expected: all commands pass.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md docs/roadmap.md docs/plans/2026-05-06-cli-foundation.md
git commit -m "docs: add cli foundation plan and usage notes"
```

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin feat/cli-foundation
gh pr create --base main --head feat/cli-foundation --title "feat: add CLI foundation" --body "..."
```

## Self-review

Spec coverage:

- v0 CLI foundation is covered by package metadata, config discovery, event log backend, CLI entrypoints, tests, and documentation.
- Plugin manifests and skills remain in place.
- MCP and deep runtime hooks remain future work.

Placeholder scan:

- The plan includes concrete files, commands, and expected outcomes for every implementation step.
- Implementation followed strict TDD: tests were written and observed failing before production modules were added.

Type consistency:

- Config module names are consistent: `default_config_path`, `discover_config`, `redact_mapping`.
- Event log command names are consistent: `o2b append-event`, `vault-log --as`.
