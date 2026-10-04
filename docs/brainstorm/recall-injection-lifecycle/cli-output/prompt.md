You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Release "recall-injection lifecycle" for Open Second Brain (v1.71.0 candidate). Four kanban cards, each already premise-checked against the live source. Build ONLY the verified residue listed under each card; the refuted parts are recorded and not built.

## Card t_5528ab98 (verdict: corrected) - per-session recall dedupe

Upstream (mem0) dedupes recalled context within a session and gates capture to completed turns.
- BUILD: per-session dedupe of the recall-inject brief. Today `hooks/recall-inject.ts` reads only `hook_event_name` and `prompt`; it never reads `session_id`, so the same notes are re-injected on every prompt. Filter already-injected notes after the confidence-floor check (which is measured over the unchanged 4-row retrieval) and before the `maxNotes` slice; if every surviving note was already injected, abstain with a new closed-vocabulary reason (for example `all_already_injected`). Disable dedupe when the host sends no session id (all such hosts share the `default` hook-state scope). Reset on a SessionStart `compact` (the context that held the earlier briefs is gone).
- DO NOT BUILD: the completed-turn-only capture gate. Capture mines only user-authored prompt text at UserPromptSubmit time, and an interrupted SessionEnd deliberately re-reads the transcript so in-flight user turns DO reach capture (shipped durability decision t_c181f92b). Repeated capture is already prevented by content-keyed dedupe. Also not built: flipping `recall_inject_enabled` to default ON.

## Card t_e9da6b7e (verdict: refuted, residue buildable) - confidence-gated volunteering

The core ask (a mid-conversation, confidence-gated, budget-capped relevance lane) already ships as recall-inject (UserPromptSubmit, floor 0.35 on idf-weighted coverage, 4 notes, 900 chars, 2500 ms, default OFF, fail-closed, audited).
- BUILD residue R1: config knobs for the four caps, next to `recall_inject_enabled` in the flat global config with env overrides: `recall_inject_max_notes` (1..10), `recall_inject_max_chars` (200..8000), `recall_inject_time_budget_ms` (250..8000), `recall_inject_confidence_floor` (0..1). Lenient: an invalid value falls back to the constant and is named in the audit line; a hook never throws. Unset keys keep output byte-identical.
- BUILD residue R2: cross-lane dedup against the active digest. active-inject (SessionStart) must record into per-session hook-state what it actually emitted (the body is budget-truncated, so the active.md file is NOT the delivered set), and recall-inject filters candidates whose vault-relative path is in that set (preference bullets render as `- \`pref-<slug>\` ...`, matching `Brain/preferences/pref-<slug>.md`).
- DO NOT BUILD: a second kill switch, default ON, fail-open replay of a cached brief, a 0.7 score gate, entity-pointer dedup (no such lane exists).

## Card t_2d19157e (verdict: corrected) - user-shapeable injection slices

- BUILD: operator-declared named slices for recall-inject only. Each slice: name, optional heading, filter mapped onto existing `SearchOptions` fields (`pathPrefix`, `properties` frontmatter filter, e.g. `type`), optional limit and char budget. Validation at config load (unknown keys, duplicate names, non-positive budgets). One shared time budget split across slices (never 2.5 s each), the global notes/chars caps clamp the sum, the floor applies per slice, one fence, one audit record with per-slice counts. No slices declared = exactly today's single implicit relevance slice.
- DO NOT BUILD: reshaping active-inject's fixed source list (already budget-configurable, not query-shaped).

## Card t_55ee804e (verdict: corrected) - chunked post-compaction re-delivery

Re-grounding after compaction already ships (SessionStart matcher `compact` re-runs active-inject; PostCompact is registered but silenced by the context-event allowlist). Priority order (standing rules first) and a budget already exist.
- BUILD: the overflow lane. When the joined SessionStart context exceeds a per-host part ceiling (default about 9000 UTF-16 units; JS `.length` already counts UTF-16), emit part 1 (block-boundary split, headers and continuation markers inside the budget) and queue the remaining parts in per-session hook-state with a compaction epoch. A carrier hands out exactly one part per subsequent tool-use event, exactly once, under a lock; a real user prompt cancels the queue; a new SessionStart overwrites it (new epoch). The lock must never stall a hook past its time budget: on contention, skip this tool event's delivery. Meter: add UTF-16 length, the part ceiling and an `over_budget` flag to the existing size receipt. When the payload fits, output stays byte-identical. Host limit is configuration with a conservative default; it cannot be measured from host binaries.

# Project context

Open Second Brain: TypeScript on Bun (>=1.1, CI pinned 1.4.0), Markdown vault plus SQLite index; host hooks for Claude Code, Codex and grok live in `hooks/` and run as one short-lived bun process per hook event (10 s host timeout, 8 s self-ceiling).

Recent commits:
39c2f225 feat: scoped operator rules per project, harness and host, per-profile Hermes settings on a multiplexed gateway and readers that answer at the caller's reach (v1.70.0) (#229)
d49c4697 feat: ingest that reads CSV, TSV and HTML into table and parts sections, names the formats it skips and previews with o2b brain extract (v1.69.0) (#228)
f5c46615 feat: dependency facts from project manifests, Terraform seeds in the pre-extractor and readers that answer at the caller's reach (v1.68.0) (#227)
400b20ea feat: distillation pages that prove what they quote and say how much of their source the vault holds (v1.67.0)
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0) (#225)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0) (#224)

Related files (verified anchors):
- `hooks/recall-inject.ts` (opt-out at :209 before any read; decide call :246-250 passes only `decisionFilter`; stdout :255-261)
- `src/core/brain/recall-inject.ts` (pure core: constants MAX_NOTES 4, MAX_CHARS 900, TIME_BUDGET_MS 2500, CONFIDENCE_FLOOR 0.35; `RecallInjectOptions` already accepts maxNotes/maxChars/timeBudgetMs/confidenceFloor; `RecallAbstainReason` closed union; `renderRecallBrief`; `defaultRecallRetriever(configPath, vault, limit)` calls `searchAcrossVaults`, its limit equals MAX_NOTES; `idfWeightedCoverage` is computed over delivered rows, so over-fetching shifts the floor input)
- `hooks/active-inject.ts` (SessionStart assembly: standing block exempt from budget, scoped block, active.md body and lessons each budgeted; `joinBlocks` then a single stdout write; `recordInjectionSize` receipt after stdout; `resolveInjectionLimits` reads `_brain.yaml` `active:` block)
- `hooks/lib/session-state.ts` (one JSON per session scope under `<vault>/.open-second-brain/hook-state/<scope>.json`; `readHookStamp`, `writeHookStamp` read-merge-write under a per-scope advisory lock via `acquireLockSync`, 20 x 5 ms bounded retry, fail-soft; missing session id -> shared scope `default`; no GC of old files)
- `hooks/lib/context-events.ts` (allowlist: only SessionStart and UserPromptSubmit may emit additionalContext; `hooks/post-write-reminder.ts` already emits PostToolUse additionalContext outside it)
- `hooks/hooks.json` (PreToolUse `*` already spawns `pretool-orient` on every tool call; PostToolUse has only `brain_feedback` and write-tool matchers) and the generated Codex mirror `plugins/codex/hooks/hooks.json` (`bun run sync-plugin-mirrors`)
- `src/core/config.ts` (flat `key: value` global config, `resolveConfigFlag`, lenient numeric precedent `resolveNavTierCadenceMinutes`)
- `src/core/brain/policy/blocks/*.ts` (vault `_brain.yaml`: two-level parser, each block a flat map of scalars and simple inline arrays; `KNOWN_KEYS`, hard errors on out-of-range; `active.ts` already flat-encodes grouped keys as `most_applied_window_days`)
- `src/core/search/types.ts` (`SearchOptions.pathPrefix`, `SearchOptions.properties: ReadonlyMap<string, ReadonlyArray<string>>`)
- tests: `tests/core/brain/recall-inject.test.ts` (pure, fake retriever), `tests/hooks/recall-inject.test.ts` (spawned hook, no real inject stdout today), `tests/hooks/active-inject*.test.ts`, `tests/hooks/session-state.test.ts`, `tests/hooks/hooks-json-shape.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`

Conventions:
- Every new behaviour is opt-in or inert by default; default output stays byte-identical (pinned by tests).
- Hooks are fail-closed for injection (error or timeout injects nothing) and fail-soft for state (a state error degrades to "absent", never throws).
- Closed vocabularies for verdicts and faults, enforced by a census test.
- Version bump, CHANGELOG entry and docs ride inside the feature PR; `bun run sync-plugin-mirrors` after any `hooks/hooks.json` change.
- TDD with bun:test; spawned-hook tests with temp vaults.

Constraints:
- No new external dependencies.
- Do not change existing public APIs or MCP tool names; no new MCP tool.
- `recall_inject_enabled` stays default OFF and stays the master gate; flag off = zero output and no state read.
- Implementation runs as parallel lanes with disjoint file ownership, so the design should separate a small shared substrate (hook-state helpers, config resolvers) from per-feature code.
- A lock or state write must never push a hook past its time budget.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
