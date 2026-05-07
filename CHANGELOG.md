# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] - 2026-05-07

### Changed

- Rewrote OpenClaw runtime entry in pure JavaScript — all five tools
  (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
  `event_log_append`, `vault_health`) now operate directly on the vault
  filesystem using `node:fs/promises` and `node:path` instead of spawning
  a Python subprocess. This passes the OpenClaw security scanner which
  blocks `child_process` imports.
- Removed `openclaw/o2b-runner.js` subprocess helper (no longer needed).
- Added `openclaw/vault.js` and `openclaw/event-log.js` pure JS modules.
- Switched to `api.pluginConfig` for reading plugin configuration and
  two-arg `api.registerTool(tool, { name })` registration pattern to
  match bundled OpenClaw plugin conventions.

### Removed

- `openclaw/o2b-runner.js` — subprocess runner blocked by security scanner.

## [0.5.1] - 2026-05-07

### Added

- Root `package.json` with `openclaw.extensions` so OpenClaw can install the
  plugin via `git:` and `npm-pack:` resolvers without errors.
- `openclaw/index.js` runtime entry that registers five native OpenClaw tools
  (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
  `event_log_append`, `vault_health`) through `definePluginEntry` and
  `api.registerTool`. Tool execution spawns `python3 -m open_second_brain.cli`
  with `PYTHONPATH` pointing at the plugin's `src/` directory.
- `openclaw/o2b-runner.js` subprocess helper for calling Python from the JS
  entry.
- `tool-call` CLI subcommand that bridges MCP tool handlers to the command
  line, enabling the JS entry to invoke tools like `second_brain_query` and
  `second_brain_capture` without running a full MCP server.
- `check_openclaw_installability` doctor checks that validate `package.json`
  exists, has `openclaw.extensions`, and each extension file is present.
- `uiHints` and `activation` fields in `openclaw.plugin.json`.
- OpenClaw packaging validation step in the CI release workflow.

### Changed

- Bumped package, plugin, and manifest versions to 0.5.1.
- `install.md` OpenClaw branch now uses `openclaw config set` for vault
  configuration instead of manual MCP registration — tools are registered
  natively by the plugin entry.
- `mcpEnabled` default changed to `false` in `openclaw.plugin.json` because
  native tool registration makes the MCP server unnecessary for most OpenClaw
  setups.
- `docs/architecture.md` OpenClaw adapter section now describes the JS entry +
  Python bridge pattern instead of the Bundle-only approach.

## [0.5.0] - 2026-05-07

### Added

- OpenClaw native plugin compatibility through `openclaw.plugin.json` manifest at
  the project root. OpenClaw discovers the plugin via the Bundle format
  (auto-detecting `.claude-plugin/` and `.codex-plugin/`) combined with the
  static manifest for cold discovery. The MCP server serves as the runtime tool
  bridge. See `docs/architecture.md` for the adapter layout.
- `check_openclaw_manifest` health check in `doctor.py` that validates
  `openclaw.plugin.json` has required fields (`id`, `configSchema`) and that the
  declared tool names match the MCP tool table.
- `openclaw_manifest` check in the Hermes adapter health report
  (`plugins/hermes/__init__.py`).
- OpenClaw installation and configuration section in `README.md`.
- OpenClaw post-install steps in `after-install.md`.
- OpenClaw adapter section in `docs/architecture.md`.
- Validation of `openclaw.plugin.json` in the CI release workflow
  (`.github/workflows/release.yml`).
- `tests/test_openclaw_plugin.py` covering manifest validity, required fields,
  tool name consistency with the MCP server, and installability invariants.

### Changed

- Bumped package, plugin, MCP server, and Claude/Codex manifest versions to 0.5.0.
- Updated `pyproject.toml` description to mention OpenClaw alongside Hermes,
  Claude Code, and Codex.
- Updated `.codex-plugin/plugin.json` description to mention OpenClaw.

## [0.4.2] - 2026-05-06

### Changed

- Reworded the `--args` guidance in `after-install.md` and `docs/mcp.md` so
  the docs no longer contain a literal copyable quoted-args anti-example.
  The corrected `hermes mcp add open-second-brain --command o2b --args mcp
  --vault /path/to/vault` example stays; the negative case is now described
  in prose ("do not wrap all of those arguments into one quoted shell
  string and do not repeat `--args` per token") so a careless copy/paste
  cannot pick up the wrong form.
- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.2.

## [0.4.1] - 2026-05-06

### Added

- `o2b uninstall` CLI helper that prints a read-only uninstall plan, including
  the exact Hermes commands the user must run (`hermes mcp remove`,
  `hermes plugins remove`, `hermes gateway restart`) and the location of the
  machine-local config directory.
- `--apply-local` flag for `o2b uninstall` that may remove the machine-local
  config directory only (`~/.config/open-second-brain` or the parent of
  `$OPEN_SECOND_BRAIN_CONFIG`). Refuses to act on directories whose name is
  not a recognized Open Second Brain config dir, paths inside Hermes-owned
  trees, or directories that look like git repositories.
- `after-install.md` at the repository root so Hermes can show post-install
  guidance (init, MCP registration, update, uninstall) right after
  `hermes plugins install`.
- `uninstall` command entry in the Claude Code plugin manifest.
- README now documents an explicit Hermes CLI form for MCP registration
  (`hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault`)
  and adds dedicated **Updating** and **Uninstalling** sections that spell
  out the Hermes-owned vs. machine-local layers.
- `docs/mcp.md` now covers updating and removing the MCP registration, and
  warns against passing `--args` as a single quoted string.
- Dedicated `tests/test_uninstall.py` covering dry-run safety, vault and
  Hermes config preservation, the `--apply-local` allow-list, the
  `OPEN_SECOND_BRAIN_CONFIG` env override, and the help text invariants.

### Changed

- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.1.

### Migration / Uninstall notes

- `o2b uninstall` is read-only by default. It **never** edits
  `~/.hermes/config.yaml`, removes the installed plugin directory, or
  touches the vault — including `Daily/`, `AI Wiki/`, or any Markdown.
- To deregister the MCP server and remove the plugin run the Hermes
  commands yourself (`hermes mcp remove open-second-brain`,
  `hermes plugins remove open-second-brain`, `hermes gateway restart`).
- `o2b uninstall --apply-local` only removes the machine-local
  Open Second Brain config directory; it refuses to delete anything else.
- Existing users do not need to re-register the MCP server after upgrading
  to 0.4.1; the plugin update flow keeps `~/.hermes/config.yaml` untouched.

## [0.4.0] - 2026-05-06

### Added

- Optional Model Context Protocol (MCP) tool server over stdio JSON-RPC 2.0 (`o2b mcp`, `o2b-mcp`).
- Five MCP tools backed by the existing core: `second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`.
- `docs/mcp.md` guide for Hermes `~/.hermes/config.yaml mcp_servers` registration, Claude Code, and Codex.
- `mcp_server` metadata in the top-level Hermes plugin manifest and `plugins/hermes/plugin.yaml`.
- `mcp` command entry in the Claude Code plugin manifest.
- 20 dedicated MCP tests covering handshake, tools listing, every tool, stdio loop, and CLI integration.

### Changed

- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.0.
- Updated README and roadmap to mark v1 as implemented and link to the new MCP guide.

## [0.3.1] - 2026-05-06

### Added

- Top-level Hermes plugin manifest and entrypoint so the repository can be installed from a GitHub or Git URL through Hermes plugin installation.

### Changed

- Reworked README content for end users with a Hermes-first description and concise setup flow.
- Updated package and Hermes plugin metadata to version 0.3.1.

## [0.3.0] - 2026-05-06

### Added

- Deterministic `o2b` CLI foundation with status, init, doctor, append-event, export-config, and index commands.
- Append-only daily Markdown event log backend and `vault-log` compatibility wrapper.
- Vault profile bootstrap for the `AI Wiki` structure and Open Second Brain operating manual.
- Wiki helpers for frontmatter parsing, wikilink extraction, vault page listing, and index regeneration.
- Runtime adapter manifests for Hermes, Claude Code, and Codex.
- Hermes plugin health checks with safe best-effort registration.
- Plugin manifest validation through `o2b doctor --repo`.
- Sandbox vault and plugin manifest fixtures for tests.
- GitHub release workflow for tag-based and manually dispatched releases.

[unreleased]: https://github.com/itechmeat/open-second-brain/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/itechmeat/open-second-brain/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/itechmeat/open-second-brain/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/itechmeat/open-second-brain/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/itechmeat/open-second-brain/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/itechmeat/open-second-brain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/itechmeat/open-second-brain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/itechmeat/open-second-brain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itechmeat/open-second-brain/releases/tag/v0.3.0
