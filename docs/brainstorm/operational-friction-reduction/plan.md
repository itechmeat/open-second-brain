# Operational friction reduction - implementation plan

Four atomic tasks, one feature each. Order does not matter beyond the version bump being last - the features are independent and each tasks lands as a separate conventional commit on `feat/operational-friction-reduction`.

## Tasks

### Task 1: `o2b update` CLI verb

- **Files**: `src/cli/update.ts` (new), `src/core/install/update.ts` (new), `tests/cli/update.test.ts` (new), `tests/core/install/update.test.ts` (new), `src/cli/main.ts` (modified - register subcommand), `CHANGELOG.md` (modified).
- **Acceptance**:
  - `o2b update` detects every installed runtime via `adapter.detect(env)`, generates the current `McpPayload`, compares against the `payload_hash` field in `install.lock.json`, and applies only where the hash differs (or `--force` is set).
  - `--target <name>` runs the same loop against a single runtime.
  - `--dry-run` prints the planned per-target action (`up-to-date | apply | force-apply | skip`) without writing anything.
  - `--json` emits a structured envelope `{targets: [{name, status, reason?, error?}], exit_code}`.
  - Sequential per-target execution; failure on one target reports the error and continues with the next, returning the worst exit code across all targets.
  - Exit codes: `0` all targets updated or already up-to-date; `1` runtime error; `2` usage error; `3` `--check` found drift after update; `4` user-modified-block conflict.
  - Lock-file migration is backward-compatible: an entry without `payload_hash` is treated as "unknown - apply on first run" and the hash is written after the first successful apply.
- **Depends on**: none.

### Task 2: Weekly Brain digest

- **Files**: `src/core/brain/digest.ts` (modified - `windowDays` option, agent-quality summary), `src/cli/brain/verbs/digest.ts` (modified - `--window` parsing), `bin/o2b-discipline-report` (modified - `--window` flag), `src/cli/discipline-install.ts` (modified - `--weekly` flag), `src/core/brain/digest-agent-summary.ts` (new), `tests/core/brain/digest-window.test.ts` (new), `tests/core/brain/digest-agent-summary.test.ts` (new), `CHANGELOG.md` (modified).
- **Acceptance**:
  - `o2b brain digest` without `--window` produces byte-identical output to the previous release (24h default unchanged).
  - `--window 7d` (and bare `--window 7`) renders the 7-day digest with the same section list plus the agent-quality summary.
  - Window parser accepts `Nd` and bare `N` for positive integers; invalid format or non-positive values exit `2` with a clear error.
  - Agent-quality summary lists per-agent: total brain-event count, breakdown by event type, count of confirmed rules in the window where this agent first applied evidence, count of retired rules in the window traceable to this agent's signals.
  - Graceful degradation: missing `Brain/log/<date>.md` files inside the window are skipped silently; the digest still renders with available data.
  - `o2b discipline install --weekly --telegram-target <target> --at "59 8 * * 1"` registers a second Hermes cron job (`osb-weekly-brain-digest`) separate from the daily discipline report.
- **Depends on**: none.

### Task 3: Cursor SQLite deep parsing

- **Files**: `src/core/discipline/transcripts/cursor.ts` (modified - replace mtime probe), `src/core/discipline/transcripts/types.ts` (modified - extend `TranscriptRuntime` return type), `src/core/discipline/transcripts/index.ts` (modified - handle the new shape), `tests/core/discipline/transcripts/cursor-sqlite.test.ts` (new), `CHANGELOG.md` (modified).
- **Acceptance**:
  - Cursor's `state.vscdb` is opened via `bun:sqlite`, queried with `SELECT key, value FROM ItemTable WHERE key LIKE 'sessionData.%'`, and the JSON `value` is parsed to extract session timestamps + message count per session for the day window.
  - Return type carries `session_count` and `message_count` aggregates.
  - Any SQL error (locked DB, missing table, unexpected JSON shape) falls back to the previous mtime-only behaviour and logs a single stderr warning prefixed with `cursor-sqlite:`.
  - No changes to Claude Code or Codex transcript resolvers.
- **Depends on**: none.

### Task 4: Obsidian deep-link in explorer

- **Files**: `src/core/brain/explorer.ts` (modified - pass `vaultPath` to template in live-server mode), `templates/brain-explorer.html` (modified - `__VAULT_PATH__` placeholder + double-click handler), `tests/core/brain/explorer-deeplink.test.ts` (new), `CHANGELOG.md` (modified).
- **Acceptance**:
  - In live mode, double-clicking a canvas node or a listbox item builds `obsidian://open?path=<encodeURIComponent(vaultPath + "/Brain/preferences/pref-<id>.md")>` and calls `window.open(uri, "_blank")`.
  - If `window.open` returns falsy (browser blocked, no Obsidian protocol handler), the handler copies the absolute path to the clipboard and shows a brief tooltip "Obsidian not detected - path copied".
  - Export mode leaves `__VAULT_PATH__` substituted with an empty string and the handler short-circuits.
  - Template substitution is covered by a unit test against the rendered HTML (no browser automation needed).
- **Depends on**: none.

### Task 5: Version bump + CHANGELOG consolidation

- **Files**: `package.json`, runtime manifests via `bun run sync-version`, `CHANGELOG.md`.
- **Acceptance**:
  - `package.json` version `0.10.12`.
  - `bun run sync-version` mirrors the version to every runtime manifest.
  - `CHANGELOG.md` carries a single `[0.10.12]` entry that lists the four features.
- **Depends on**: Task 1, Task 2, Task 3, Task 4.
