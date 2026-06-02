# Token diet - cut per-session context overhead of the MCP surface and hooks

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The Open Second Brain plugin spends context tokens before an agent does any work, and keeps spending them on every file edit. A 2026-06-02 audit measured: 71 MCP tools serializing to 44,912 chars (~12K tokens); a 16,550-byte `Brain/active.md` injected verbatim on every SessionStart with 31% internal duplication and escaping corruption; a ~1.3KB reminder injected after every successful Write/Edit; and a PostCompact hook whose output the current Claude Code rejects outright - the re-injection silently fails while the validation error echoes the full 16KB payload to stdout. The preview-budget seam that protects context from oversized tool results covers only 9 of 71 tools.

## Scope

Six kanban children under epic t_5e6826f3, shipped as one PR / one release:

1. **PostCompact hook fix** (t_a1602738, P4 bugfix). Current Claude Code has no `PostCompact` hook event at all; `SessionStart` supports a `compact` matcher instead (verified against https://code.claude.com/docs/en/hooks on 2026-06-02). Move re-injection to `SessionStart` with matcher `startup|resume|clear|compact`; teach `active-inject.ts` to emit `additionalContext` only under event names known to accept it (`SessionStart`, `UserPromptSubmit`) and exit silently otherwise; keep the `PostCompact` registration in `hooks.json` only as a silent no-op for older runtimes. Contract test pins which event names may carry `additionalContext`.
2. **Slim active.md** (t_40eb1de7, P3). Render `## Most-applied (Nd)` entries as one-liners (`- \`pref-id\` (scope, applied_in_window: N)`) without repeating principle bodies; sanitize principle text at the write seam (strip leaked tool-call XML fragments, collapse multi-level `\\"` escaping) plus a doctor warning and an idempotent `planUpgrade`/`applyUpgrade` migration step that rewrites already-corrupted preference files once (it already runs hands-off via `ensureVaultCurrent` on SessionStart); add a deterministic character budget to the injected body (new shared `text-budget` core), truncating lowest-priority sections first.
3. **Compress post-write-reminder** (t_9cc4f400, P3). Full reminder once per session (it teaches the contract), then a short steady-state nudge (<= 200 chars). Session-scoped marker state keyed by the payload `session_id`, stored under the vault state dir, best-effort and fail-soft. Codex runtime keeps the full text always (one-shot exec has no second turn).
4. **Consolidate MCP read tools** (t_3920db77, P3). Three families merge behind discriminator params: 6 summary tools -> `brain_brief` (`view: morning|daily|weekly|monthly|operator|digest`), 5 analytics tools -> `brain_analytics` (`view: timeline|recurrence|attention_flows|belief_evolution|concept_synthesis`), 7 schema read tools -> `schema_inspect` (`view: graph|lint|stats|orphans|explain_type|active_pack|packs`). Old names stay registered as deprecated delegating aliases for at least one minor release; alias descriptions are one line ("Deprecated alias for X with view=Y") so the surface still shrinks.
5. **Description diet** (t_352fd7f6, P2). Cap tool descriptions at 300 chars; move parameter nuance into per-property `inputSchema` descriptions and long-form guidance into `instructions.ts`/docs; new `registry-guard` test fails on any over-cap description.
6. **Preview budget by default** (t_c967abaf, P2). Opt the verbose read tools (`brain_query`, `brain_audit`, `brain_backlinks`, `brain_unlinked_mentions`, `second_brain_query`, `schema_inspect`, `brain_session_grep`, `brain_session_expand`, `brain_recall_telemetry`) into `MCP_PREVIEW_BUDGET`; the registry-guard test enumerates tools without a budget and requires an explicit exempt-list entry with a reason.

A small measurement script (`scripts/measure-token-surface.ts`) records serialized registry size and active.md size so regressions are visible; its output lands in the PR body and CHANGELOG.

## Out of scope

- Adaptive per-request tool-surface selection (t_20dcb192 owns it).
- Removing deprecated aliases (a later minor release).
- Any change to the writer-scope surface (5 tools, unchanged).
- LLM-based summarization anywhere in the pipeline.

## Chosen approach

Variant 1 from the consultant pass: two thin reusable seams plus independent slices. A pure `text-budget` core (`src/core/brain/text/text-budget.ts`), generalized from the head-budget logic in `pre-compress-pack.ts`, owns deterministic truncation for both the active.md injection budget and the steady-state reminder; a `registry-guard` module (`src/mcp/registry-guard.ts`) walks `buildToolTable("full")` once and exposes the description-cap and preview-budget-exemption checks that two new contract tests assert. The PostCompact fix and the tool consolidation remain standalone slices that consume these primitives. Rationale for not choosing the alternatives is recorded in `variants.md`.

## Design decisions

- **SessionStart `compact` matcher replaces PostCompact** - it is the documented mechanism in current Claude Code; the PostCompact event no longer exists. The hooks.json `PostCompact` block stays (harmless on current runtimes, useful on older ones) but `active-inject` emits nothing under that event name, eliminating both the broken injection and the 16KB error echo.
- **Allowlist of context-bearing event names lives in one exported constant** (`hooks/lib/context-events.ts`) so the contract test and the hook share a single source of truth.
- **Most-applied one-liners keep ids and counts only** - the full principle text is always present in the `## Confirmed` section of the same document; duplication carries zero information.
- **Sanitization happens at the write seam, not at render** - `signal.ts`/`preference.ts` normalize principle text when persisting (strip `</principle>`-style tool-call fragments, collapse `\\\\"`-chains to a single `"`); `regenerateActive` stays a pure projection. A `brain_doctor` warning flags stored files that still carry artifacts, and a `planUpgrade`/`applyUpgrade` migration step rewrites them once - that path is idempotent and already runs hands-off on SessionStart, unlike the opt-in dream heal phase which targets vault pages, not `Brain/preferences/`.
- **Injection budget defaults to 8,000 chars (~2K tokens)** configurable via `_brain.yaml:active.inject_budget_chars`; truncation order drops sections by priority (retired -> quarantine -> most-applied -> confirmed tail), never mid-line, and appends a one-line pointer to `brain_context` for the full view. Deterministic: same input bytes, same output bytes.
- **Reminder session state is a marker file** under `<vault>/.open-second-brain/state/reminder-<session_id>` written fail-soft; absence of a session_id (or any IO error) falls back to the full text, because over-reminding is safer than never teaching the contract.
- **Consolidated tools reuse the exact handler functions of the tools they replace** - dispatch by `view` param only; output shapes per view are byte-identical to the predecessor tools so existing consumers can migrate by renaming the call.
- **Aliases are data, not copies**: a `deprecatedAlias(name, target, view)` helper produces a ToolDefinition with a one-line description delegating to the consolidated handler, keeping the alias cost ~40 tokens each instead of ~150-600.
- **Registry guard is a test-time module, not a runtime gate** - runtime behavior never changes because of a long description; the cap is enforced where regressions are caught, in `bun test`.

## File changes

New:
- `src/core/brain/text/text-budget.ts` (+ test) - pure deterministic section-aware truncation.
- `src/mcp/registry-guard.ts` (+ test) - description cap, preview-budget exemption walk.
- `hooks/lib/context-events.ts` (+ test) - allowlisted context-bearing hook event names.
- `scripts/measure-token-surface.ts` - serialized registry + active.md size report.
Extended (tests already exist - no new hook test files): `tests/hooks/active-inject.test.ts`, `tests/hooks/post-write-reminder.test.ts`, `tests/hooks/hooks-json-shape.test.ts`.

Modified:
- `hooks/active-inject.ts` (event allowlist, injection budget), `hooks/hooks.json` (SessionStart matcher gains `compact`), `hooks/post-write-reminder.ts` + `hooks/lib/messages.ts` (cadence), `hooks/lib/detect.ts` (if session id extraction needs a helper).
- `src/core/brain/active.ts` (Most-applied one-liners, budget application), `src/core/brain/most-applied.ts` (no principle text needed in entries - keep struct, render changes only).
- `src/core/brain/signal.ts`, `src/core/brain/preference.ts` (principle sanitization at write), `src/core/brain/doctor.ts` (corruption warning), `src/core/brain/upgrade.ts` (one-shot migration rewrite).
- `src/mcp/brain-tools.ts`, `src/mcp/schema-tools.ts` (consolidated tools + aliases + preview budgets + trimmed descriptions), `src/mcp/tools.ts` (registry assembly), `src/mcp/instructions.ts` (relocated guidance, updated tool list), `src/mcp/search-tools.ts`, `src/mcp/pay-memory-tools.ts` (description trims).
- `tests/mcp/mcp.test.ts` (registry contract: new names + aliases + count), affected tool tests.
- `README.md`, `docs/mcp.md`, `docs/cli-reference.md`, `CHANGELOG.md`.

## Risks and open questions

- **Alias count vs surface goal**: keeping 18 aliases means the tool *count* rises before it falls; the token win comes from one-line alias descriptions. The measurement script reports both count and serialized size; acceptance keys on size.
- **Codex hook payloads** may carry different event names; the allowlist must default-closed (no emission for unknown events) while session-capture remains unaffected.
- **Existing tests asserting full descriptions** (e.g. capability report snapshots) may need updates; treat as part of each slice's TDD loop.
- **Live-vault heal** of corrupted preference files must preserve frontmatter round-tripping for fields it does not touch; covered by fixture tests built from the real corrupted shapes found in the audit.
- **mcp.test.ts count churn**: consolidation (+3 new, names kept) and guard tests land in separate commits so each registry change is reviewable on its own.
