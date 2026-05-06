# open-second-brain

Open Second Brain is an open-source, plugin-first second brain package for AI agents and humans.

It is designed to give Hermes Agent, Claude Code, OpenAI Codex, and other agentic runtimes a shared, portable way to remember durable project knowledge, append operational event logs, query an Obsidian-compatible vault, and carry the same workflow across machines without locking knowledge into one agent runtime.

Status: experimental v0.3. The repository currently includes documentation, a tested Python CLI foundation, skills, plugin manifests, and lightweight runtime health checks. Deeper runtime integrations and MCP support are planned for later versions.

## Goals

- Provide a filesystem-first second brain that works with Obsidian-compatible Markdown vaults.
- Keep mutable user data and configuration separate from immutable plugin/package code.
- Support multiple agent runtimes through adapters instead of a single runtime-specific implementation.
- Treat daily logs as one backend for an append-only agent event log.
- Make setup, status checks, redacted config export, and future migrations deterministic through CLI tools.
- Avoid storing secrets, tokens, credentials, or private connection strings in the vault.

## Non-goals for v0

- No always-on daemon.
- No mandatory MCP server.
- No automatic self-rewriting maintenance jobs.
- No replacement of an existing personal vault.
- No hidden background writes outside the configured agent-owned area.

## Planned v0 shape

```text
open-second-brain/
  docs/
    idea.md
    architecture.md
    roadmap.md
  skills/
    open-second-brain/
      SKILL.md
    agent-event-log/
      SKILL.md
  scripts/
    o2b
    vault-log
  plugins/
    hermes/
      plugin.yaml
      __init__.py
  .claude-plugin/
    plugin.json
  .codex-plugin/
    plugin.json
```

## Runtime strategy

Open Second Brain is plugin-first, but not plugin-only.

- Plugins provide installation, discovery, lifecycle integration, and runtime adapters.
- Skills teach agentic runtimes the protocol and safety rules.
- CLI tools provide deterministic operations that should not depend on model reasoning.
- MCP can be added later as a shared tool API over the same core.

## CLI foundation

Run the local CLI without installing the package:

```bash
scripts/o2b status
scripts/o2b init --vault /path/to/vault --name "My Second Brain"
scripts/o2b doctor --vault /path/to/vault --repo .
scripts/o2b index --vault /path/to/vault
scripts/o2b append-event --vault /path/to/vault --as agent-name --date 2026.05.06 --time 10:15 "created first entry"
scripts/o2b export-config --config ~/.config/open-second-brain/config.yaml --output /tmp/open-second-brain-config.json
scripts/vault-log --vault /path/to/vault --as agent-name "compatibility event entry"
```

The current CLI is intentionally small and dependency-free. It supports:

- config path discovery through `OPEN_SECOND_BRAIN_CONFIG`, `XDG_CONFIG_HOME`, or `~/.config/open-second-brain/config.yaml`;
- vault bootstrap with an agent-owned `AI Wiki` profile;
- vault, config, and plugin manifest health checks;
- wiki index regeneration for Markdown pages;
- redacted config export;
- append-only daily Markdown event logging;
- a `vault-log` compatibility wrapper.

Common setup flow:

```bash
git clone https://github.com/itechmeat/open-second-brain.git
cd open-second-brain
scripts/o2b init --vault ~/SecondBrainSandbox --name "Sandbox Brain"
scripts/o2b doctor --vault ~/SecondBrainSandbox --repo .
scripts/o2b append-event --vault ~/SecondBrainSandbox --as setup "initialized sandbox vault"
scripts/o2b index --vault ~/SecondBrainSandbox
```

The CLI is safe to run directly from the checkout. For shell use, add the repo's
`scripts` directory to `PATH`, or call `scripts/o2b` and `scripts/vault-log`
explicitly. For Python module use, set `PYTHONPATH=src` and run
`python3 -m open_second_brain.cli ...`.

## Plugin and runtime install notes

The runtime adapters are intentionally thin. They advertise deterministic CLI
commands and health checks; they do not start daemons, MCP servers, or background
automation.

- Claude Code: `.claude-plugin/plugin.json` contains command metadata for
  `status`, `doctor`, `init`, `index`, `append-event`, `export-config`, and the
  `vault-log` compatibility wrapper. Commands point at portable repo-relative
  scripts.
- Codex: `.codex-plugin/plugin.json` declares package metadata and the skills
  directory. `scripts/o2b doctor --repo .` validates required Codex manifest
  fields.
- Hermes: `plugins/hermes/__init__.py` exposes `health(repo_root=None)` and
  `check_health(repo_root=None)`. `register(ctx)` makes a best-effort attachment
  to common context shapes such as `register_health_check(...)`,
  `add_health_check(...)`, or a `health_checks` dict/list.

Create disposable test vaults with `scripts/o2b init --vault /tmp/o2b-sandbox`.
Keep secrets outside the vault and use `scripts/o2b export-config` when sharing
debug snapshots so sensitive keys are redacted.

## Releases

Releases are published by GitHub Actions from `.github/workflows/release.yml`.

Automatic release from a tag:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.3.0 -m "Release v0.3.0"
git push origin v0.3.0
```

Manual release from GitHub Actions:

1. Open **Actions → Release → Run workflow**.
2. Leave `version` empty to use `pyproject.toml`, or enter the same version with or
   without the leading `v`.
3. Set `prerelease` only for prerelease builds.

The release workflow verifies the test suite, plugin manifests, shell wrappers,
Hermes plugin syntax, and `scripts/o2b doctor --vault . --repo .` before building
source and wheel distributions and publishing a GitHub release.

Before changing `pyproject.toml` version for a future release, update
`CHANGELOG.md` using Keep a Changelog sections.

## Development

Run the test suite with the Python standard library:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Run static syntax checks used by the initial PRs:

```bash
python3 -m json.tool .claude-plugin/plugin.json >/dev/null
python3 -m json.tool .codex-plugin/plugin.json >/dev/null
python3 -m py_compile plugins/hermes/__init__.py
bash -n scripts/o2b
bash -n scripts/vault-log
```

## License

MIT. See `LICENSE`.
