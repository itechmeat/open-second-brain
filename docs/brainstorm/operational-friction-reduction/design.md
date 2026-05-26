# Operational friction reduction - one update command, weekly trend visibility, deeper transcript probes

**Status:** shipped (v0.10.12)
**Shipped:** v0.10.12 (2026-05-20)
**Author:** Sisyphus (via brainstorming)
**Audience:** implementation

## Problem statement

Two pain points in daily Open Second Brain operation:

1. **Manual per-runtime update on every release.** Operator runs five to seven steps per machine to update the Open Second Brain installation across all runtimes (Claude Code, Codex, Hermes, Cursor, ...). Error-prone and tedious.
2. **No trend visibility.** The daily discipline report gives a single-day snapshot. There is no understanding of "how the agent learns over a week" - confidence trends, agent engagement quality, rule adoption patterns.

A third papercut surfaced during scoping: the Cursor transcript probe uses mtime only, so the discipline report cannot say how many sessions or messages happened. And a fourth: double-clicking a node in `o2b brain explorer` does nothing - the operator has to context-switch into Obsidian by hand to inspect the underlying preference file.

## Scope

Four features, one PR, one release (v0.10.12):

| # | Feature | Priority |
|---|---------|----------|
| 1 | `o2b update` CLI verb | Primary |
| 2 | Weekly Brain digest (`--window 7d`) | Primary |
| 3 | Cursor SQLite deep parsing | Companion |
| 4 | Obsidian deep-link in explorer | Companion |

## Out of scope

- Window-triggers for Hermes cron (§25). Weekly digest relies on standard cron; if the VPS is offline during the Monday window, the digest is skipped. Window-trigger support (fire-on-next-boot-after-missed-window) is Hermes-side, not Open Second Brain core. Tracked separately.
- `--scope project` for Cursor / opencode / kiro. Already deferred, trigger not met.
- Live-refresh in explorer (SSE / WS). Already deferred, trigger not met.
- Obsidian deep-link in export mode. Static export cannot provide the vault path; deep-link is live-mode only. If operators later request deep-link in exported HTML, an `--vault-path` flag at export time can opt in. Trigger: explicit request.

## Chosen approach

All four features layer on top of existing machinery; no new adapter interface, no new core abstraction.

- **`o2b update`** is orchestration over the existing `InstallAdapter` pipeline (`detect -> plan -> apply -> verify`). A new additive `payload_hash` field in each runtime's `install.lock.json` lets the orchestrator skip targets whose payload has not changed.
- **Weekly digest** reuses `o2b brain digest` with a parameterised window; the existing 24h default stays untouched. A new agent-quality summary section reads `Brain/log/<date>.md` plus the JSONL sidecar for the configured window. A second Hermes cron job (`osb-weekly-brain-digest`) delivers it on Mondays.
- **Cursor SQLite parsing** replaces the mtime-only probe with a `bun:sqlite` read against `state.vscdb`. Any failure (schema drift, locked DB, missing table) falls back to mtime and logs a single stderr warning. No new dependencies.
- **Explorer deep-link** is a ~30-line client-side handler that builds `obsidian://open?path=<absolute>` on double-click. The live HTTP server passes the absolute vault path through a new `__VAULT_PATH__` template placeholder; export mode keeps the placeholder empty and the handler is a no-op.

## Design decisions

- **Reuse InstallAdapter machinery entirely.** No new adapter interface, no new registry. The update logic is orchestration over existing `detect / plan / apply / verify`.
- **Payload comparison via sidecar manifest.** `install.lock.json` already stores `applied_at`, `operation`, `owned_keys`, `owned_paths`. Extending it with `payload_hash` (sha256 of canonical `McpPayload` JSON) is backward-compatible: entries without the hash are treated as "unknown - apply on first update run", and the hash is written after the first successful update.
- **Sequential, not parallel.** Runtimes share filesystem state (the vault, the skill symlinks). Sequential execution avoids race conditions; total time is still sub-second for most setups.
- **`--force` bypasses payload-hash check.** Useful when the operator knows the payload changed but the hash did not (e.g. an env-variable update that does not affect the `McpPayload` struct but does affect runtime behaviour).
- **`--window` not `--weekly`.** More general - the operator can request any window (`7d`, `14d`, `30d`). `--weekly` would lock the API into a boolean.
- **Agent quality belongs in digest, not discipline.** Discipline answers "is the agent writing to Brain at all". Digest answers "what changed in Brain". The agent-quality summary references confirmed / retired rules, not just event counts, so digest is the right home.
- **`bun:sqlite` only for Cursor.** Already in the stack. No new dependencies.
- **`path=` not `vault=` for the Obsidian link.** `obsidian://open?path=<absolute>` works regardless of how the vault is registered in Obsidian. `vault=<name>` requires the registered name to match the directory basename, which is often not true.
- **Silent fallback in the explorer.** If `window.open` does not trigger Obsidian (not installed, blocked by browser), copy the absolute path to the clipboard and show a brief tooltip. No modal dialogs.

## File changes

### Feature 1 - `o2b update`

- **New:** `src/cli/update.ts` - CLI verb handler, arg parsing, orchestration loop.
- **New:** `src/core/install/update.ts` - core update logic (detect -> plan -> compare -> apply -> verify).
- **New:** `tests/cli/update.test.ts`, `tests/core/install/update.test.ts`.
- **Modify:** `src/cli/main.ts` - register `update` subcommand.
- **Modify:** `CHANGELOG.md` - v0.10.12 entry.

Exit codes: `0` all targets updated or already up-to-date; `1` runtime error; `2` usage error; `3` `--check` found drift after update; `4` user-modified-block conflict (use `--force`).

### Feature 2 - Weekly Brain digest

- **Modify:** `src/core/brain/digest.ts` - accept `windowDays` in `RenderDigestOptions`; adjust the `since` calculation; add the agent-quality summary section to both Markdown and JSON output.
- **Modify:** `src/cli/brain/verbs/digest.ts` - parse `--window`.
- **Modify:** `bin/o2b-discipline-report` - accept `--window`, route to `o2b brain digest --window` when set.
- **Modify:** `src/cli/discipline-install.ts` - add `--weekly` to the install verb.
- **New:** `src/core/brain/digest-agent-summary.ts` - pure read over `Brain/log/`.
- **New:** `tests/core/brain/digest-window.test.ts`, `tests/core/brain/digest-agent-summary.test.ts`.
- **Modify:** `CHANGELOG.md`.

Window parser accepts `Nd` (positive integer + `d`) and bare `N`. Invalid format or non-positive values exit `2` with an error message.

### Feature 3 - Cursor SQLite deep parsing

- **Modify:** `src/core/discipline/transcripts/cursor.ts` - replace the mtime probe with SQLite parsing.
- **Modify:** `src/core/discipline/transcripts/types.ts` - extend `TranscriptRuntime` return type with session and message counts.
- **Modify:** `src/core/discipline/transcripts/index.ts` - handle the new result shape.
- **New:** `tests/core/discipline/transcripts/cursor-sqlite.test.ts`.
- **Modify:** `CHANGELOG.md`.

Query pattern: `SELECT key, value FROM ItemTable WHERE key LIKE 'sessionData.%'` against `state.vscdb`. Errors and unexpected JSON shapes fall back to mtime with a single stderr warning.

### Feature 4 - Obsidian deep-link in explorer

- **Modify:** `src/core/brain/explorer.ts` - pass `vaultPath` to the template in live-server mode only.
- **Modify:** `templates/brain-explorer.html` - add `__VAULT_PATH__` placeholder plus the double-click handler.
- **New:** `tests/core/brain/explorer-deeplink.test.ts`.
- **Modify:** `CHANGELOG.md`.

Path construction: `<vaultPath>/Brain/preferences/pref-<id>.md` URI-encoded into `obsidian://open?path=...`. Export mode leaves `__VAULT_PATH__` empty and the handler short-circuits.

## Risks and open questions

- Cursor's `state.vscdb` schema is private to the vendor and may change between versions. Mitigated by an aggressive fall-back to mtime on any error. Operators on older or newer Cursor builds see the same behaviour as before the change, plus one stderr warning.
- `payload_hash` is sha256 of canonical JSON, but the canonicalisation routine has to be deterministic across Bun versions. Tests pin the canonical form (key sort + no whitespace) against a fixed expected hash.
- Weekly cron silently skips runs when the host is offline (no window-trigger). Documented in §25 deferred work; the agent-quality summary itself is resilient to missing log days.
- Obsidian deep-link relies on the OS having Obsidian installed and the `obsidian://` URI scheme registered. The silent clipboard fallback covers headless servers and locked-down workstations.
