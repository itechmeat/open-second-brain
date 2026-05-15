# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - YYYY-MM-DD

Brain: a new top-level vault layer for observing, accreting memory.
Agents record taste signals from conversation and per-artifact
evidence of preference application; a deterministic `dream` pass
turns repeat signals into rules whose confidence grows from real use
and decays when nothing applies them. Filesystem-first, Obsidian-
native, no LLM inside the algorithm — counters, thresholds, atomic
file operations only. Conceptually mirrors Anthropic's *Dreaming*
research preview (2026-05-06) but stays runtime-agnostic and
deterministic.

The previous agent-facing write paths (`event_log_append` and
`second_brain_capture` MCP tools, the `agent-event-log` skill) are
soft-deprecated in v0.9.0: the handlers remain in the codebase and
the CLI counterparts (`o2b append-event`, `vault-log`) keep working
for humans on the shell, but agents through the plugin surface no
longer see them. Brain replaces them as the writable surface.

Pay Memory is **unchanged** in v0.9.0 — it remains agent-visible as
an orthogonal audit layer for paid actions.

### Added

- **Brain layer** at top-level `Brain/` directory in the vault.
  Subdirectories: `inbox/`, `preferences/`, `retired/`, `log/`,
  `.snapshots/`. Plus `_brain.yaml` (schema-versioned config with
  thresholds for `candidate_threshold`, `unconfirmed_window_days`,
  `contradiction_window_days`, `stale_evidence_days`,
  `high_freshness_factor`, `snapshots.retention_count`) and
  `_BRAIN.md` (agent-facing operating manual, rendered by `o2b
  brain init`, kept under 200 lines).
- **CLI namespace `o2b brain *`** with 11 verbs: `init`,
  `feedback`, `dream`, `apply-evidence`, `digest`, `query`,
  `reject`, `pin`, `unpin`, `rollback`, `doctor`.
- **MCP tool namespace `brain_*`** with 6 tools: `brain_feedback`,
  `brain_dream`, `brain_apply_evidence`, `brain_digest`,
  `brain_query`, `brain_doctor`. `init`, `reject`, `pin`, `unpin`,
  `rollback` are intentionally CLI-only (admin / destructive
  operations are not exposed to autonomous agents).
- **Pre-run snapshots**: each `dream` run that mutates state writes
  `Brain/.snapshots/<run_id>.tar.zst` of the entire `Brain/` tree
  (excluding `.snapshots/` itself) before any mutation. Retention
  is configurable in `_brain.yaml` (default 10 most-recent).
  `o2b brain rollback <run_id>` restores from a snapshot.
- **Pin protection**: preferences marked `pinned: true` are exempt
  from automatic retirement (`stale-no-evidence`,
  `expired-unconfirmed`, `rebutted`). Only `o2b brain reject` can
  retire a pinned preference (with an extra warning). CLI verbs
  `o2b brain pin` and `o2b brain unpin` toggle the flag; both are
  CLI-only — the MCP surface intentionally does not expose them.
- **Skill `brain-memory`** (`skills/brain-memory/SKILL.md`):
  instructs agents when to call `brain_feedback` (taste signals
  from dialogue) and `brain_apply_evidence` (per durable artifact).
  Loaded automatically alongside the existing `open-second-brain`
  skill.
- **Brain digest**: `o2b brain digest` renders a Markdown or JSON
  summary of new unconfirmed preferences, confirmations,
  retirements, confidence shifts, and contradictions in a window.
  Exit code `2` when empty and `--silent-if-empty` is set — fits
  Hermes cron `--no-agent --script` jobs cleanly. Recipe in
  [`docs/hermes-cron.md`](docs/hermes-cron.md).

### Changed

- **`AI Wiki/_OPEN_SECOND_BRAIN.md`** is now overwritten by
  `o2b brain init` to a Brain-first operating manual; the file
  previously described agent-owned write conventions for
  `AI Wiki/` itself. With approximately zero non-author users at
  this stage no backup of the prior file is taken — by design.
- **`hooks/lib/messages.ts` PostToolUse reminder** rewritten:
  no longer references `event_log_append`. Points the agent at
  `brain_feedback` (when the turn contained a user preference)
  and `brain_apply_evidence` (when an active preference scopes
  to the artifact just produced).
- **`skills/open-second-brain/SKILL.md`** body rewritten to
  describe the three-layer model (`Brain/` writable, `AI Wiki/` +
  `Daily/` read-only, Pay Memory orthogonal). Cross-references
  the new `brain-memory` skill.

### Removed (from agent-facing surface; handlers retained in code)

- **`Stop` lifecycle hook** that previously blocked the turn once
  on missing `event_log_append`. The entry is removed from
  `hooks/hooks.json`; the handler file
  `hooks/stop-log-guardrail.ts` remains in the codebase. No
  Brain-specific Stop guardrail is added in v0.9.0 — the
  PostToolUse reminder is the only nudge.

### Deprecated (agent-facing only, code and CLI retained)

- **MCP tool `event_log_append`** — no longer in the advertised
  tool list returned by `src/mcp/tools.ts`. Handler stays on disk.
  The CLI counterparts `o2b append-event` and `vault-log` remain
  fully functional for human shell use.
- **MCP tool `second_brain_capture`** — same pattern: removed
  from advertisement, handler retained.
- **Skill `agent-event-log`** moved to `docs/legacy-skills/` so
  the runtime skill scanner stops loading it. The Markdown remains
  accessible as documentation.

### Notes

- Pay Memory is unchanged. All 11 Pay Memory CLI commands and
  8 MCP tools work exactly as in v0.8.1.
- `AI Wiki/` and `Daily/` remain on disk and stay readable for
  agents via `second_brain_query`. Agents do not write to them
  in v0.9.0+.
- OpenClaw native JavaScript parity for Brain tools is deferred
  to v0.9.1 (tracked as BRAIN-FUT-007 in
  [`docs/plans/2026-05-15-brain-roadmap.md`](docs/plans/2026-05-15-brain-roadmap.md)).
  v0.9.0 ships Brain through the TypeScript CLI + MCP path used by
  Hermes, Claude Code, and Codex.
- Hard removal of the deprecated v0.8.x agent-facing write code
  is deferred to v0.10 or later, gated on observed usage of Brain
  (BRAIN-FUT-009).
- Full design and implementation plan:
  [`docs/plans/2026-05-15-brain-observing-memory.md`](docs/plans/2026-05-15-brain-observing-memory.md).

## [0.8.1] - 2026-05-14

Plugin-bundled lifecycle hooks for Claude Code and Codex that close a
real silent-skip bug: the MCP server's `instructions` reminder to call
`event_log_append` after a durable artifact was being dropped under
load with no visible signal — agent finished the turn, the vault's
Daily log stayed empty, no stderr trail. This release moves the
reminder out of soft instructions and into a runtime-side guardrail.

Hermes and OpenClaw are unaffected: Hermes already injects the
equivalent reminder through its `pre_llm_call` shim, and OpenClaw's
native JS plugin format predates the hook schema. The new hooks are
loaded only by Claude Code and Codex.

### Added

- **Lifecycle hooks** (`hooks/`):
  - `PostToolUse` (matcher `Write|Edit|MultiEdit|apply_patch`) — emits
    a developer-context reminder right after the file-mutating tool
    returns. Skipped when `tool_response` reports `is_error: true` or
    `success: false` so failed edits do not generate noise.
  - `Stop` — parses the runtime's transcript JSONL, decides whether
    the turn produced a durable artifact AND whether
    `event_log_append` was called (recognising both the bare Codex
    name `event_log_append` and the Claude-decorated
    `mcp__plugin_open-second-brain_open-second-brain__event_log_append`,
    matched via `/(?:^|__)event_log_append$/` so future prefix
    renames keep working). Emits `{"decision":"block","reason":…}`
    once per turn; respects `stop_hook_active === true` so the next
    Stop passes unconditionally — the agent decides whether to log
    or just finish, no deadlocks.
  - Bash logging counts: if the agent ran `o2b append-event …` or
    `vault-log …` through `Bash` (Claude) or `exec_command` /
    `shell` (Codex), the parser pulls the command string out of the
    transcript and the guardrail treats it as a valid log call.
- **`scripts/o2b-hook`** — PATH-deployed shim that both runtimes
  invoke from `hooks/hooks.json`. Resolves its own location, runs
  the Bun precheck, and execs `hooks/<name>.ts`. `o2b install-cli`
  now symlinks `o2b-hook` alongside `o2b` and `vault-log`. One
  PATH-discoverable entry point works in both runtimes without a
  per-runtime `${PLUGIN_ROOT}` env var (Codex 0.129 exposes none).
- **Codex manifest wiring**: `"hooks": "./hooks/hooks.json"` added to
  both `.codex-plugin/plugin.json` and
  `plugins/codex/.codex-plugin/plugin.json`; `plugins/codex/hooks`
  symlinked to `../../hooks` (mirrors the existing
  `plugins/codex/skills` pattern).
- **Tests** (`tests/hooks/`): 52 new bun:test cases covering format
  detection, Claude / Codex transcript shapes, artifact / log
  classification (including the prefix-decorated MCP names),
  Bash-as-log paths, the trailing-newline JSON contract, malformed
  JSONL, empty transcripts, missing `transcript_path`,
  `stop_hook_active`, failed-edit suppression.
- **Documentation**:
  - `hooks/README.md` — full design notes (cross-runtime detection,
    PATH-based shim rationale, symlink caveat for Codex marketplace
    staging, cwd contract for test subprocesses).
  - `install.md` branches C (Codex) and D (Claude Code) — new
    `### 6b. Lifecycle hooks (auto-enabled)` sections; step 3 in
    every branch now mentions the `o2b-hook` symlink.
  - `install.md` readiness checklist — split the `VAULT_AGENT_NAME`
    line so it requires the env var for Hermes / Codex only;
    Claude Code derives identity from the persisted plugin config
    that `o2b init --agent-name` writes.
  - `README.md` rewritten to be runtime-neutral — removed Hermes-first
    framing and duplication with `install.md`, added a
    Supported-runtimes table and a Lifecycle-hooks section.

### Fixed

- Silent `event_log_append` skips after a durable artifact landed,
  visible in real Claude Code sessions where a Write or Edit was
  followed by no log call and no warning. The `Stop` guardrail now
  blocks the turn once with a clear reason; the agent must either
  log or explicitly skip by sending its final reply a second time.

### Changed

- `sync-version` now also updates `plugins/codex/.codex-plugin/plugin.json`
  (it was stuck at 0.7.0). All seven manifests stay in lockstep with
  `package.json`.
- `tsconfig.json` `include` extended to cover `hooks/**/*.ts`.

## [0.8.0] - 2026-05-10

Pay Memory: a memory and audit layer for paid agent actions. Hermes (or any
other supported runtime) makes a paid API call through `pay.sh`; Open Second
Brain saves the reason, the policy check, the receipt, the generated asset,
the spending policy decision, the human-approval state, and a per-task
report — all as plain Markdown inside the configured vault.

This release does not execute payments and does not hold wallet keys. The
payment still happens through the agent's local `pay` CLI; Open Second Brain
records what happened.

### Added

- **Core Pay Memory module** (`src/core/pay-memory/`):
  - filesystem helpers (`paymentsDateDir`, `receiptPath`, `assetPath`,
    `reportPath`) and `validateSlug` (defense-in-depth against path
    traversal in user-supplied slugs);
  - best-effort raw-output redactor for `api_key` / `token` / `secret` /
    `bearer` / `authorization` / `private_key` / `password` / `passwd` /
    `pwd` / `credential` / `session_token` in env, YAML, JSON, and
    HTTP-header shapes;
  - deterministic Markdown receipt / asset / report writers with
    frontmatter; bracket and backtick sanitisation in wikilinks /
    inline-code spans;
  - spending policy template renderer (`spending.md`) plus a separate,
    optional **machine-readable policy** (`spending.json`) with
    allowlist, single-call cap, daily budget cap, per-category receipt
    quotas, and "require approval above" threshold;
  - daily payment digest (`buildPaymentDigest` +
    `renderPaymentDigestTelegram`) for cron-friendly 4-line summaries;
  - **approval workflow** (`pending-payment-request` artifact under
    `AI Wiki/payments/_pending/`) with `pending → approved/rejected →
    consumed` state machine.
- **Path-safety helpers** (`src/core/path-safety.ts`): `ensureInsideVault`
  and `vaultRelative` use `path.sep` so the prefix check works on Windows
  too; replaces the duplicated POSIX-only versions previously inlined in
  `src/mcp/tools.ts` and `src/core/pay-memory/paths.ts`.
- **Atomic / race-safe writers** (`atomicCreateFileSyncExclusive`,
  `writeFrontmatterAtomic`): Pay Memory artifacts are written via
  `link(2)` semantics so "refuse to overwrite" is enforced atomically
  even with concurrent CLI + MCP server processes.
- **CLI commands** (eleven new in this version):
  - `init-pay-memory` — bootstrap `AI Wiki/{policies,payments,assets,drafts,reports}/`
    and write `policies/spending.md`.
  - `append-payment-receipt` — save a Markdown receipt; `--raw-output-file`
    is redacted before persisting.
  - `capture-asset` — save a Markdown note for a generated asset.
  - `payment-report` — aggregate a date's receipts into a Markdown report.
  - `check-payment-policy` — evaluate a prospective paid call against
    `spending.json`; exit 0 / 1 / 3 = allowed / denied / approval_required.
  - `request-payment-approval` — create a pending request the user must
    sign off on before the agent runs `pay`.
  - `approve-payment-request`, `reject-payment-request`,
    `consume-payment-request`, `list-pending-payments` — human / agent
    sides of the approval workflow.
  - `payment-digest` — render a Telegram-friendly 4-line summary for a
    date (with `--empty-mode silent|empty|summary`).
- **MCP tools** (eight new in this version): `payment_memory_init`,
  `payment_receipt_append`, `asset_capture`, `payment_report_generate`,
  `payment_policy_check`, `payment_request_approval`,
  `payment_request_status`, `payment_request_consume`. Server
  `initialize.instructions` describes the suggested call chain.
- **Documentation**: `docs/hermes-cron.md` (wiring `payment-digest` into a
  Hermes cron `--script --no-agent` job for daily Telegram delivery),
  `examples/hermes-payment-digest.sh` reference wrapper,
  `docs/plans/2026-05-10-pay-memory.md` (implementation plan), and
  `tests/e2e/pay-memory-sandbox.sh` (manual end-to-end smoke test against
  the real `pay --sandbox` CLI).

### Changed

- The MCP tool server now advertises **thirteen** tools (the previous five
  plus eight Pay Memory tools).
- `core/vault.ts` exposes `formatFrontmatter` (pure renderer) and
  `writeFrontmatterAtomic` (race-safe writer used by Pay Memory). The
  legacy `writeFrontmatter` keeps its non-atomic semantics for non-critical
  callers (`init.ts`, the `o2b index` command, etc.).

### Out of scope

- On-chain anchoring of vault hashes (Solana memo, web3 RPC) is
  intentionally excluded from this project. Pay Memory continues to record
  `payment_proof` strings opaquely for whatever upstream system produced
  them; the audit trail lives in the vault, not on a blockchain.

## [0.7.0] - 2026-05-09

Single TypeScript source of truth on the [Bun](https://bun.sh) runtime.
Hermes, Claude Code, Codex, and OpenClaw all consume the same `src/core/`
modules; the duplicate JavaScript copy under `openclaw/*.js` and the
parallel Python implementation under `src/open_second_brain/*.py` are gone.

### Added

- TypeScript core (`src/core/`) for config, event-log, vault, init, doctor.
- `bun:test` suite (176 cases) + Python shim tests (13 cases). Includes a
  12-worker multi-process append-event lock test.
- Per-runtime install flows for local marketplaces (Claude `claude plugin
  marketplace add <path>`, Codex `codex plugin marketplace add <path>`,
  Hermes via plugin-dir symlink, OpenClaw `openclaw plugins install <path>`).
- `agent-event-log` skill: stronger trigger description and a language
  policy that follows the user's session language.
- `scripts/sync-version.ts` and `bun run sync-version:check` to keep all
  manifests aligned with `package.json`.
- `bun.lock` for reproducible dependency resolution.

### Changed (BREAKING)

- **Runtime:** `o2b` CLI requires [Bun](https://bun.sh) (>=1.1.0). The
  wrapper script aborts with an install hint if `bun` is not on PATH.
- **Source layout:** Python `src/open_second_brain/*` replaced by TypeScript
  `src/core/*`, `src/cli/*`, `src/mcp/*`.
- **OpenClaw plugin:** `openclaw/index.js` is now a `bun build` bundle
  (target=node) of `src/openclaw/index.ts`; no more hand-translated JS.
  CI rebuilds and diffs the committed bundle.
- **Hermes plugin:** `plugins/hermes/__init__.py` slimmed to a thin shim
  (`pre_llm_call` + minimal health). Identity reminder template lives in
  `templates/identity-reminder.txt`, shared with the OpenClaw
  `before_prompt_build` hook.
- **Version source of truth:** `package.json`. `pyproject.toml` and the
  five plugin manifests carry synced copies.
- **CI:** `oven-sh/setup-bun@v2`, `bun test`, `bun run typecheck`,
  Python-shim tests, manifest + bundle freshness checks.

### Fixed

- **Security — path traversal in `event_log_append`:** `date` parameter is
  now validated against `^\d{4}\.\d{2}\.\d{2}$` and rejects non-existent
  calendar dates and `..` segments. Previously `date: "../AI Wiki/notes/pwn"`
  could write outside `Daily/`.
- **Identity hallucination:** placeholder blacklist extended to include
  `codex`, `codex-cli`, `codex-exec`, `claude-code`, `hermes`, `openclaw`.
  When the model echoes its runtime name as the `agent` argument the server
  now falls back to the persisted `agent_name` instead of writing
  `@codex` / `@hermes` / etc.
- **Cross-platform paths:** `fs-atomic`, `install-cli`, `uninstall` use
  `node:path` `basename` / `sep` instead of hard-coded `/`.
- **Test reliability:** `expect(Bun.file(...).text()).resolves` now awaited
  — assertion was silently dropped.
- **Hermes shim:** `__init__.py` tolerates both relative and absolute
  `plugins.hermes` import paths (Hermes loads it as a file directly).

### Removed (BREAKING)

- Python `open_second_brain` package and its pip entry points
  (`o2b`, `vault-log`, `o2b-mcp`).
- `openclaw/event-log.js` and `openclaw/vault.js` (rolled into the bundle).

### Migration

1. Install Bun (`curl -fsSL https://bun.sh/install | bash`).
2. `git pull` the plugin checkout.
3. Re-run `o2b install-cli` to refresh symlinks.
4. `o2b doctor --vault <path> --repo <repo>` to verify.

Hermes / Claude Code / Codex / OpenClaw configurations do not change.

## [0.6.2] - 2026-05-08

### Added

- install.md `## Verification — identity registry` block. Confirms
  the chosen agent name appears in
  `<vault>/AI Wiki/identity/agents.md` after `o2b init`. Multi-runtime
  installs grow the list incrementally.
- install.md prelude note: `o2b` CLI on PATH is a single shared
  symlink across runtimes — first-installed wins, subsequent
  `install-cli` refuses to overwrite. Manual repointing is allowed
  but unnecessary.

### Changed

- install.md "Agent name" subsection (branches A–D): installer agent
  **MUST** ask the user, **MUST** first check
  `~/.config/open-second-brain/config.yaml`,
  `<vault>/AI Wiki/identity/agents.md`, and `<vault>/Daily/*.md` for
  a previously-set identity and surface it as a reuse-or-change
  question. Defaults list only shown if no prior identity is found.
- install.md "no version pin" guidance: replaced the ambiguous
  "tracks `main`" framing with "**latest released version**" plus an
  explicit `v0.6.1` vs `v0.6.0` example, and a direct statement that
  manually appending `@v...` freezes the install at the literal tag
  you typed.
- install.md prelude: `o2b init` idempotency description updated to
  describe the new multi-agent append behavior on
  `AI Wiki/identity/agents.md`.

### Fixed

- Multi-agent registration in `AI Wiki/identity/agents.md`. Second and
  later `o2b init --agent-name <name>` runs now append under
  `## Registered agents` instead of being a silent no-op once the
  placeholder is gone. Idempotent for already-registered names.
- install.md Branch C steps 2–3: Codex CLI 0.129+ caches the
  marketplace under `~/.codex/.tmp/marketplaces/<name>/`, not the
  previously documented `~/.codex/plugins/cache/<marketplace>/<plugin>/<hash>/`.
  Step 3 now uses a `find` pattern that works on either layout.
- install.md Branch D step 3: Claude Code caches plugins under a
  `<version>` segment (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/scripts/o2b`).
  Same `find`-based fix as Branch C.

## [0.6.1] - 2026-05-08

### Added

- `pre_llm_call` hook in the Hermes-side adapter. Each turn the plugin
  injects a compact identity + workflow nudge into the user message —
  the LLM learns its `@agentName` and the contract for
  `event_log_append` (plain message text; the server prepends timestamp
  and identity). Skips injection silently when the agent identity is
  not configured, so the literal `@agent` placeholder never reaches
  the LLM.
- `.claude-plugin/marketplace.json` — single-plugin Claude Code
  marketplace manifest. Claude Code 2.x install flow is
  `claude plugin marketplace add` → `claude plugin install <plugin>@<marketplace>`,
  and the marketplace step expects this catalog file. Without it, the
  install fails with `Marketplace file not found`. Manifest declares
  the repository as a one-plugin marketplace pointing at itself
  (`source: "./"`), so the same Git URL works for every other runtime
  without restructuring.
- `.mcp.json` at the repo root — Claude auto-registers MCP servers
  declared here when the plugin is installed, so users never run
  `claude mcp add` manually. The entry uses `${CLAUDE_PLUGIN_ROOT}` to
  stay portable, and intentionally carries no `--vault` arg or env
  vars: the MCP server reads vault/agent/timezone from the persisted
  plugin config (see `vault` field below). Same `.mcp.json` works on
  every user's machine without per-host customization.
- `o2b init --vault <path>` now also persists the vault path into the
  plugin config (`vault` field, alongside `agent_name` and `timezone`).
  `o2b mcp` invoked without `--vault` (Claude `.mcp.json`
  auto-register, Hermes/Codex MCP entries that omit the flag) reads
  from this field — falling back to `VAULT_DIR` env, then to a clear
  error referencing `o2b init`.
- `config.resolve_vault(config_path)` — public helper, mirroring the
  existing `resolve_agent_name` and `resolve_timezone` shape.
- install.md Branch D is rewritten end-to-end against current Claude
  Code CLI (2.x): step 2 uses `claude plugin marketplace add` plus
  `claude plugin install <plugin>@<marketplace>` (the legacy
  `claude plugins install <git-ref>` form was removed in 2.x); step 5
  collapses to a no-op because Claude auto-registers MCP servers from
  the bundled `.mcp.json`; step 6 verifies via `claude plugin list` and
  `claude mcp list`; step 7 uses the marketplace + plugin update
  commands; step 8 uses the matching uninstall/remove pair.

- `.agents/plugins/marketplace.json` — single-plugin Codex marketplace
  manifest at the repo root. Codex 0.129+ has dropped the legacy
  `codex plugins install <git-ref>` command; the only documented install
  path is `codex plugin marketplace add <source>`, which validates a
  marketplace catalog at this exact location. Without this file the
  install fails with `marketplace root does not contain a supported
  manifest`. The manifest declares the repository as a one-plugin
  marketplace pointing at itself (`path: "."`), so the same Git URL
  that worked for `hermes plugins install` works for the new Codex
  flow without restructuring the repo.
- install.md Branch C is rewritten end-to-end against current Codex CLI
  (0.129+): step 2 uses `codex plugin marketplace add` plus a manual
  `[plugins."open-second-brain@open-second-brain"] enabled = true`
  stanza in `~/.codex/config.toml` (Codex has no `plugin enable`
  subcommand); step 5 uses `codex mcp add ... -- o2b mcp --vault ...`
  with both `VAULT_AGENT_NAME` and `VAULT_TIMEZONE` env vars; step 7
  uses `codex plugin marketplace upgrade`; step 8 uses
  `codex mcp remove` + `codex plugin marketplace remove`. The previous
  text referenced commands (`codex plugins install/update/uninstall`)
  that simply do not exist on current Codex.
- Timezone support for Daily event log entries. The plugin now stamps
  `HH:MM` and the day-file selection in the user's local timezone
  instead of the host's clock — important when the host runs in UTC
  but the user lives in a different zone, or when Daily entries
  straddle midnight in the user's local time. Resolution order:
  `VAULT_TIMEZONE` env var → `timezone` field in the plugin config →
  fallback to system local. Invalid names are silently treated as not
  configured (entries still land, just stamped in server time) so a
  typo never breaks logging.
- `o2b init --timezone <iana-name>` validates the IANA name via stdlib
  `zoneinfo` and persists it to the plugin config alongside
  `agent_name`. Invalid input is rejected before any vault scaffolding
  is written, so a typo cannot leave the install in a half-configured
  state.
- `open_second_brain.config.resolve_agent_name()` and
  `resolve_timezone()` — public helpers used by both the MCP server
  and the Hermes hook so identity and timezone reads stay consistent
  across every runtime / CLI surface.
- `scripts/sync-version.py` — propagates the canonical version from
  `pyproject.toml` into every runtime manifest (`plugin.yaml` × 2,
  `package.json`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `openclaw.plugin.json`). Idempotent;
  ships a `--check` mode for CI drift detection.

### Changed

- `.claude-plugin/plugin.json` modernized to current Claude 2.x schema:
  `author` is now an object (`{ "name": "..." }`) per the docs (Claude
  2.1.x rejected the legacy string form with `author: Invalid input`),
  and the embedded `commands` array is removed (Claude no longer
  parses in-manifest slash command definitions; they are authored as
  Markdown files under `commands/` at the plugin root if needed).
- `o2b doctor` `claude_manifest` check rewritten to validate the new
  schema. It accepts the modern `author` object form and reports a
  clear error when an old-style `commands` array is present.
- OpenClaw native plugin entry brought to parity with the Python /
  MCP side for the features added in this release. `openclaw/index.js`
  now uses `resolveTimezone(api)` (reads `api.pluginConfig.timezone`,
  falls back to `VAULT_TIMEZONE` env) and a `normalizeAgentArgument`
  helper (strips leading `@`, treats common LLM self-name guesses
  like `agent` / `assistant` / `claude` / `gpt` as "no value" so the
  resolved default identity is used instead). `openclaw/event-log.js`
  `currentDate(tz)` / `currentTime(tz)` use `Intl.DateTimeFormat` so
  Daily entries are stamped in the user's local timezone instead of
  the host's clock — matching the Python `current_date(tz)` /
  `current_time(tz)` behavior. The `appendEvent(...)` signature gains
  a trailing optional `tz` argument; backward-compatible.
  `openclaw.plugin.json` `configSchema` and `uiHints` now declare a
  `timezone` field so OpenClaw users can set it via
  `openclaw config set plugins.entries.open-second-brain.config.timezone "..."`.
- install.md Branch B step 1 corrected: previously claimed the
  OpenClaw native plugin reads timezone from
  `~/.config/open-second-brain/config.yaml`. It does not — the JS
  plugin reads exclusively from `api.pluginConfig` (OpenClaw's own
  per-plugin store, populated by `openclaw config set`). Step 5 now
  includes a fourth `openclaw config set` line for the timezone, and
  the worked example JSON shows `timezone` alongside `agentName`.
- Removed the unused, drifting `PLUGIN_VERSION = "0.6.0"` constant
  from `openclaw/index.js`. The two unused local helpers
  `currentDate()` / `currentTime()` in the same file were also
  deleted (the active versions live in `openclaw/event-log.js` and
  are now timezone-aware).
- Hardened vault resolution across every write-mode CLI entry point.
  Previously `vault-log`, `o2b append-event`, `o2b doctor`,
  `o2b index`, `o2b tool-call`, and `o2b mcp` (the standalone
  `open_second_brain.mcp:main` console script) all fell back to the
  current working directory (`Path(os.environ.get("VAULT_DIR", "."))`)
  when neither `--vault` nor `VAULT_DIR` was set. That fallback was
  silent: an agent invoking `vault-log "..."` from `$HOME` would
  write `~/Daily/<date>.md` instead of the user's actual vault, and
  the success line `appended: Daily/...` gave no signal that the
  entry had landed in the wrong place. Now every one of these entry
  points resolves the vault via `--vault → VAULT_DIR → persisted
  plugin config (vault field)`, and exits with a clear
  `error: no vault configured. Pass --vault ... or run o2b init ...`
  if none of those is set. The shared resolver lives in
  `cli._require_vault`; the `vault-log` and standalone-`o2b mcp`
  paths use the same logic inline because they don't share the cli
  module's argparse setup.
- `vault-log` and `o2b append-event` now print the **absolute** path
  of the appended Daily file (`appended: /abs/.../Daily/<date>.md`),
  not a relative `Daily/<date>.md`. The relative form was the visual
  disguise that hid the silent-cwd-fallback bug above.
- install.md step 1 in every branch is now "Collect installation
  parameters (vault path + agent name + timezone)" — three values
  instead of two. The new "Vault path" subsection tells the
  installer agent how to discover the user's Obsidian vault on the
  target machine: scan common roots (`~/`, `~/Documents/`,
  `~/Sync/`, iCloud paths, Syncthing mounts), look for the
  `.obsidian/` marker subdirectory, list candidates and ask the user
  to pick one, or ask for a path if none are found. The agent must
  confirm the resolved absolute path with the user before passing it
  to `o2b init`. No vault location is hard-coded in the docs — the
  example `/path/to/vault` placeholder remains generic.
- `docs/architecture.md` example config snippet no longer hard-codes
  `/root/vault` / `hermes-vps-agent` / `vps-techmeat`. Replaced with
  generic placeholders so the doc reads correctly on any machine.
- `set_config_value` (`config.py`) is now atomic and stricter:
  contents go through a sibling temp file with `fsync` + `os.replace`,
  so an interrupt during the write leaves either the previous config
  or the new one intact — never a half-written hybrid. Values
  containing characters that the simple parser cannot round-trip
  (`"`, `\\`, `\n`, `\r`) are rejected with a clear `ValueError`
  instead of being silently corrupted on the next read. The fields
  this helper persists (`vault` paths, IANA timezone names, agent
  identifiers) never legitimately contain those characters; the
  rejection is a guardrail against future callers passing arbitrary
  strings through. Surfaced by an autonomous CodeRabbit review pass.
- OpenClaw `resolveTimezone(api)` now validates the candidate against
  `Intl.DateTimeFormat` before returning it. An invalid IANA name in
  `api.pluginConfig.timezone` or `VAULT_TIMEZONE` would otherwise
  crash every `event_log_append` call inside `Intl.DateTimeFormat`
  with `RangeError`. The Python side already had this fallback
  (`config.resolve_timezone` swallows `ZoneInfoNotFoundError`); the
  JS side now matches.
- `o2b doctor`'s `claude_manifest` author check rejects an empty
  `name` (e.g. `{"author": {"name": ""}}`) with the same error
  message used for missing or wrong-typed `author`. Previously
  ``isinstance(author.get("name"), str)`` accepted the empty string.
- The two timezone-aware MCP tests now capture the local-tz wall
  clock **before** invoking the tool. The previous order computed
  `now_local` after the tool returned, which around midnight could
  flake: tool stamps day N, assertion looks for day N+1. Tightened.
- New install.md **Branch E — Generic adapter (other runtimes)**. For
  any runtime not covered by branches A–D (a new MCP-aware client, a
  different agent platform, or a supported runtime after a breaking
  CLI rename), Branch E describes the install **contract** the
  plugin needs — directory layout, `o2b` on PATH, `o2b mcp` registered
  as stdio MCP server, persisted plugin config — instead of literal
  commands. It instructs the installer agent to consult the target
  runtime's own plugin / MCP documentation and translate each step
  into the runtime-specific equivalent, asking the user before
  guessing on any step that has no obvious analogue. The document
  prelude was updated to list E as the fallback option alongside
  A–D.
- "When to log" criteria broadened in both surfaces the LLM sees:
  the per-turn `pre_llm_call` nudge and the MCP server's
  `serverInfo.instructions`. The previous wording only listed concrete
  artifacts (feature/fix/config/instruction-file/content) and instructed
  the LLM to skip "exploration, planning, or pure discussion". This
  caused agents to refuse logging substantial-but-non-tangible work —
  research findings, design decisions, investigations that surfaced
  facts worth recalling. The rules now treat any **durable artifact**
  as loggable, including research outcomes, design decisions, and
  external-fact discoveries (CLI behaviour change, API quirk, etc.),
  and end with a self-test prompt: *"would future-me want to find this
  in the log by searching for it later?"*. Skip-list is unchanged in
  spirit but reworded around "did not produce an artifact" rather
  than against specific activity types.
- `tests/test_cli.py` `run_cli` helper now isolates
  `OPEN_SECOND_BRAIN_CONFIG` per call by default. With `o2b init` now
  unconditionally persisting `vault` / `agent_name` / `timezone` into
  the config file, init-tests without explicit isolation were silently
  writing to the developer's real `~/.config/open-second-brain/config.yaml`.
  Tests that specifically exercise the default-config path can still
  pass `env={"OPEN_SECOND_BRAIN_CONFIG": ...}` to override the guard.
- The package version is now a single source of truth in
  `pyproject.toml`. `open_second_brain.__version__` reads it
  dynamically (live `pyproject.toml` first, `importlib.metadata`
  fallback) so a version bump shows up at runtime without a pip
  reinstall. `mcp.SERVER_VERSION` re-exports the same value.
- `event_log.append_event(..., tz=...)` accepts an optional
  `datetime.tzinfo` parameter; `current_date` and `current_time` are
  likewise tz-aware. Backward-compatible: omitting `tz` keeps the
  previous server-local behavior.
- install.md step 1 in every branch is now "Collect identity (agent
  name + timezone)" — a single up-front step that asks the user for
  both values before any commands run. The instructions tell the
  installer agent to accept free-form timezone input (city, country,
  abbreviation) and translate it to canonical IANA before passing to
  `o2b init`.
- `event_log_append` accepts and normalizes a wider set of LLM-supplied
  values for the optional `agent` argument: leading `@` is stripped
  (so `@hermes-vps-agent` no longer becomes `@@hermes-vps-agent`), and
  common placeholder/self-name guesses (`agent`, `assistant`, `claude`,
  `gpt`, …) fall back to the server-resolved default identity instead
  of being written verbatim into Daily.
- `event_log_append` and other tools that take optional string
  arguments now treat empty strings the same as omitted arguments.
  LLMs in tool-use mode frequently emit `""` for fields they want to
  skip; the previous behavior rejected `time=""` / `date=""` with a
  validator error.
- `o2b init --agent-name <name>` now also persists the chosen identity
  into the plugin config (`~/.config/open-second-brain/config.yaml` by
  default), not only into `AI Wiki/identity/agents.md`. Resolution
  order in `event_log_append` is unchanged
  (`VAULT_AGENT_NAME` env → plugin config → literal `agent`
  placeholder), but persistence now survives runtimes that do not
  propagate the env into the MCP subprocess.
- The MCP `initialize` response's `serverInfo.instructions` field now
  carries an identity + workflow block (you-are-@&lt;agent&gt;, when to
  call `event_log_append`, message format rules) rather than a plain
  list of tool names. Clients that surface MCP `instructions` to the
  LLM benefit immediately; clients that ignore the field are unaffected.

## [0.6.0] - 2026-05-08

### Added

- Daily-log agent identity workflow. Each runtime install now selects an
  agent name (e.g. `openclaw-main`, `hermes-vps-agent`, `<hostname>-codex`,
  …) that is used as the `@agent-name` prefix in `Daily/*.md` event log
  entries.
- `o2b init --agent-name <name>` writes the chosen identity into
  `AI Wiki/identity/agents.md` and replaces the template placeholder
  (`(add your agents here, …)`). Existing vaults are upgraded in place
  without `--force`: the placeholder line is rewritten.
- `agentName` field in `openclaw.plugin.json` `configSchema` and `uiHints`
  alongside `vault` / `instanceName`. The OpenClaw native plugin reads
  `api.pluginConfig.agentName` and uses it as the default agent for
  `event_log_append` calls that omit the `agent` argument.
- `event_log_append` (Python MCP) now resolves the default agent from
  `VAULT_AGENT_NAME`, then from `agent_name` / `agentName` in the
  discovered config file, then falls back to `agent`.
- New "Verification — daily identity" step in `install.md` and
  `after-install.md`. Calls `event_log_append` without an explicit
  `agent` and asserts the daily entry shows `@<chosen-agent-name>` rather
  than `@agent`.
- `install.md` now covers all four runtimes (Hermes, OpenClaw, Codex,
  Claude Code) with runtime-appropriate agent name defaults.
- Installation readiness criteria now require `agentName` to be configured
  (or `VAULT_AGENT_NAME` exported), the placeholder removed from
  `agents.md`, and the daily-identity check to pass.

### Changed

- Bumped package, plugin, MCP server, OpenClaw plugin, and Hermes adapter
  versions to 0.6.0.

## [0.5.5] - 2026-05-08

### Added

- `o2b install-cli` subcommand: creates symlinks for `o2b` and `vault-log`
  in `~/.local/bin` pointing to the wrapper scripts inside the plugin
  checkout. Run once after `hermes plugins install` to make bare `o2b`
  available on PATH. Symlinks survive `hermes plugins update` because they
  point into the git-managed checkout.
- `o2b uninstall --remove-cli` flag: removes the symlinks created by
  `install-cli` during uninstall.

### Fixed

- Installation instructions (`install.md`, `after-install.md`, `README.md`)
  now include the `install-cli` step between `hermes plugins install` and
  `o2b init`, closing the gap where bare `o2b` was not found on PATH after
  a clean plugin install.

## [0.5.4] - 2026-05-07

### Fixed

- Added `name` field inside each tool object passed to `api.registerTool()`.
  OpenClaw 2026.5.6 reads `tool.name` during normalization and calls `.trim()`
  on it — omitting it caused `TypeError: Cannot read properties of undefined`.

## [0.5.3] - 2026-05-07

### Fixed

- Changed `register(api)` from `async` to synchronous in `openclaw/index.js`.
  OpenClaw requires `register` to be synchronous — only `execute()` callbacks
  inside tools may be async.

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

[0.7.0]: https://github.com/itechmeat/open-second-brain/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/itechmeat/open-second-brain/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/itechmeat/open-second-brain/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/itechmeat/open-second-brain/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/itechmeat/open-second-brain/compare/v0.5.4...v0.5.5
[0.5.2]: https://github.com/itechmeat/open-second-brain/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/itechmeat/open-second-brain/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/itechmeat/open-second-brain/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/itechmeat/open-second-brain/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/itechmeat/open-second-brain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/itechmeat/open-second-brain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/itechmeat/open-second-brain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itechmeat/open-second-brain/releases/tag/v0.3.0
