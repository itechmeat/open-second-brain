# Brain lifecycle suite - implementation plan

Each task is one atomic unit, implemented RED -> GREEN -> REFACTOR with its own
commit. Tasks are ordered so foundational primitives land before the dream
integration that consumes them. Every task keeps a default no-op dream run
byte-identical.

## Task 1: Per-preference mutation audit primitive
- **Files**: `src/core/brain/pref-audit.ts`, `src/core/brain/paths.ts` (+ `prefAuditDir`/`prefAuditPath`), `src/core/brain/types.ts` (`PrefAuditOp` enum, `PrefAuditRecord`), `tests/core/brain/pref-audit.test.ts`
- **Acceptance**: pure `renderPrefAuditLine` + `appendPrefAudit({pref_id, op, agent, reason, revision_before/after, hash_before/after}, {now})` writes one JSONL line under `Brain/log/pref-audit/<pref-id>.jsonl`; `readPrefAudit(vault, prefId)` round-trips records and tolerates unknown op kinds; appending with `hash_before === hash_after` is a no-op (returns false, writes nothing).
- **Depends on**: none

## Task 2: Wire audit into mutation chokepoints
- **Files**: `src/core/brain/preference-txn.ts`, `src/core/brain/preference.ts` (`moveToRetired`), `src/core/brain/merge.ts`, tests `tests/core/brain/pref-audit-chokepoints.test.ts`
- **Acceptance**: each chokepoint accepts an optional `audit?: { agent, reason }` sink; when provided AND content hash changed, it appends exactly one audit record with correct before/after; when content unchanged, zero records; existing call sites without the sink are unaffected (back-compat).
- **Depends on**: Task 1

## Task 3: Audit read surface (CLI + MCP)
- **Files**: `src/cli/brain/verbs/audit.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/mcp/brain-tools.ts`, `src/mcp/instructions.ts`, tests `tests/mcp/mcp.test.ts` (tool count), `tests/cli/brain-audit.test.ts`
- **Acceptance**: `o2b brain audit <pref-id> [--json]` prints the lifecycle; `brain_audit` MCP tool returns the same; tool count 42 -> 43.
- **Depends on**: Task 1

## Task 4: Temporal extraction primitive
- **Files**: `src/core/brain/temporal-extract.ts`, `tests/core/brain/temporal-extract.test.ts`
- **Acceptance**: `extractTemporalConstraints(text, {now})` returns `{valid_from?, valid_until?}` for ISO date `YYYY-MM-DD`, interval `A/B`, and ISO-8601 duration (`P7D`/`P2W`/`P1M`/`P1Y`, relative to `now`); returns `{}` for text with no ISO token (incl. localized month names); never throws; deterministic on injected `now`.
- **Depends on**: none

## Task 5: Reconcile domain classifier
- **Files**: `src/core/brain/reconcile-domains.ts`, `src/core/brain/types.ts` (`RECONCILE_DOMAIN`, `DreamOpenQuestion`), `tests/core/brain/reconcile-domains.test.ts`
- **Acceptance**: `classifyContradiction({topic, scope, positives, negatives})` returns a domain from structural signals only; `resolveContradiction(...)` auto-resolves the source-freshness case (strictly fresher side wins beyond a margin) and returns an open question for every other domain; no language inspection anywhere; pure + deterministic.
- **Depends on**: none

## Task 6: Heal-enrichment primitive
- **Files**: `src/core/brain/heal-enrich.ts`, `src/core/brain/policy.ts` (`dream.heal_enrich_enabled`, default false), `src/core/brain/types.ts` (config field), `tests/core/brain/heal-enrich.test.ts`
- **Acceptance**: `deriveTitleFromContent(md)` returns the first H1 text or null; `linkExactMentions(body, knownTitlesAndAliases)` wraps only exact whole-token title/alias matches in `[[...]]` (idempotent, skips already-linked, skips code spans); `planHealEnrichment(page, known)` returns a pure plan; nothing runs unless the config flag is on.
- **Depends on**: none

## Task 7: Dream phase orchestration
- **Files**: `src/core/brain/dream-phases.ts`, `src/core/brain/dream-workrun.ts` (new phase constants), `src/core/brain/dream.ts`, `src/core/brain/types.ts` (`DreamRunSummary.phases`), tests `tests/core/brain.dream.phases.test.ts` + existing dream tests stay green
- **Acceptance**: a changed dream run emits ordered checkpoints `close_complete` -> `reconcile_complete` -> `synthesize_complete` -> `heal_complete` in the workrun and returns a `phases` array with one summary each; a no-op run returns `phases: []` and writes no workrun; ALL existing dream invariants/tests unchanged.
- **Depends on**: Tasks 1-2 (audit sink available to thread)

## Task 8: Reconcile integration (domains + open questions)
- **Files**: `src/core/brain/dream.ts`, `src/core/brain/types.ts` (`DreamRunSummary.open_questions`, `BRAIN_LOG_EVENT_KIND.reconcile`), `tests/core/brain.dream.reconcile.test.ts`
- **Acceptance**: the reconcile phase classifies the run's contradictions, auto-resolves source-freshness, emits `reconcile` open-question log events, and populates `open_questions`; the legacy `contradictions` field stays a derived view (back-compat); no force-merge ever happens.
- **Depends on**: Tasks 5, 7

## Task 9: Temporal + heal integration into dream
- **Files**: `src/core/brain/dream.ts`, `tests/core/brain.dream.temporal.test.ts`, `tests/core/brain.dream.heal.test.ts`
- **Acceptance**: on promotion, an empty `valid_from`/`valid_until` is filled from the source signal's text via Task 4 (never overwrites); the heal phase, when `dream.heal_enrich_enabled` is on, applies Task 6 enrichment and records it; with the flag off (default) the dream output is byte-identical to pre-suite.
- **Depends on**: Tasks 4, 6, 7

## Task 10: Morning brief
- **Files**: `src/core/brain/morning-brief.ts`, `src/cli/brain/verbs/morning-brief.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/mcp/brain-tools.ts`, `src/mcp/instructions.ts`, tests `tests/core/brain/morning-brief.test.ts` + `tests/mcp/mcp.test.ts` (count -> 44)
- **Acceptance**: `buildMorningBrief(vault, {now, topK, maxChars})` composes recent activity + top confirmed preferences (confidence then recency) + open questions, char-budgeted via `applyCharBudget`; read-only; `o2b brain morning-brief [--json]` + `brain_morning_brief` expose it; tool count -> 44.
- **Depends on**: Task 8 (open questions source)

## Task 11: QA, docs, version bump, release prep
- **Files**: `README.md`, `docs/how-it-works.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`, `package.json` + manifests (via sync-version), tests for config parsing
- **Acceptance**: full `bun run validate` green; a no-op dream run asserted byte-identical; docs describe all 6 features; one `[0.21.0]` CHANGELOG entry; version synced across manifests.
- **Depends on**: Tasks 1-10
