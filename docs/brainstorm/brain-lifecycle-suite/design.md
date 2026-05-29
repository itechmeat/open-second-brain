# Brain lifecycle suite - deterministic consolidation, audit, and brief

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's nightly consolidation (`dream`) is a single opaque pass,
preference mutations leave no per-preference trail, contradictions collapse to
one flat topic list, and there is no session-start brief. This suite makes the
dream pass an explicit ordered pipeline, gives every preference an authoritative
mutation history, classifies contradictions by domain, surfaces a budgeted
brief, and extracts formal temporal constraints from signal text - all
deterministically and without any hardcoded natural language.

## Scope

Six deterministic, language-agnostic features (chosen set, implemented one-by-one via TDD):

1. **Per-preference mutation audit log** - append-only JSONL per pref id, captured at the mutation chokepoints (`writePreferenceTxn`, `moveToRetired`, `mergePreferences`), recording op / agent / reason / revision + content-hash before-after. Read surface: `brain_audit` (MCP) + `o2b brain audit <pref-id>` (CLI).
2. **Multi-phase dream pipeline** - the proven `dream()` internals stay verbatim; a thin orchestration layer names the existing seams as ordered phases (close -> reconcile -> synthesize -> heal -> log), emits one workrun checkpoint + one structured summary per phase, and exposes `DreamRunSummary.phases`.
3. **Reconcile domain classification** - a deterministic classifier buckets the run's contradictions into domains (claims / entity / decisions / source-freshness) from structural signals only, auto-resolves the unambiguous source-freshness case, and flags the rest as `open_questions` instead of force-merging. Replaces the flat `contradictions` topic list (kept as a derived view for back-compat).
4. **Morning brief / day-close** - a read-only, budgeted summary (recent activity + top confirmed preferences + open questions from the last reconcile). Read surface: `brain_morning_brief` (MCP) + `o2b brain morning-brief` (CLI). Reuses the v0.20.0 `recall-budget` char primitive.
5. **Temporal extraction from signal text** - a pure parser that recognises ISO-8601 dates, intervals, and durations (relative to an injected `now`) in a signal's text and fills the EXISTING bi-temporal `valid_from` / `valid_until` fields on the promoted preference when empty. ISO tokens only - no localized month/day names.
6. **Heal-phase vault enrichment** - in the dream heal phase, complete a missing `title` from the page's first H1 and insert wikilinks for exact title/alias matches to existing pages. Opt-in (`dream.heal_enrich_enabled`, default false) because it rewrites user files; disabled = no-op.

## Out of scope

- Rewriting or relocating the proven `dream()` plan/execute logic (Variant 2 rejected).
- Any LLM fan-out / parallel reconciliation agents (the upstream inspiration's 4-agent design is explicitly NOT adopted).
- Generic external "memory ingest pipeline" beyond the brief.
- LLM-based enrichment inference (due-date guessing, workload reasoning).
- Localized natural-language temporal parsing (only formal ISO tokens).
- A frontend / UI for reviewing open questions.

## Chosen approach

**Variant 1 - orchestration wrapper with chokepoint audit.** The phase
pipeline is a thin orchestrator over the existing `scanBrain` -> `planTopics`
-> `planRefresh` -> `planAutoRetires` -> execute seams: each seam is labelled a
phase, emits a `WORKRUN_PHASE` checkpoint, and contributes a structured
`DreamPhaseSummary`. No proven logic moves. The new deterministic capabilities
(domain classifier, temporal extractor, heal enrichment) are pure functions
called inside their owning phase. The audit trail is captured at the write
primitives so it is authoritative (true before/after content hashes) and also
catches non-dream manual edits.

## Design decisions

- **Audit at the chokepoint, not by projection.** `writePreferenceTxn` /
  `moveToRetired` / `mergePreferences` already compute `_revision` and
  `_content_hash`; they gain an optional audit sink and append one record
  **only when the content hash actually changes** (before != after). A no-op
  dream run touches no preference content, so it writes no audit line -> the
  default byte-identical contract holds.
- **Per-pref-id JSONL file** (`Brain/log/pref-audit/<pref-id>.jsonl`) so an
  operator can `cat` one preference's whole lifecycle. Append-only, same
  atomic-append assumption as `dream-workrun`. The op kind is a small closed
  enum tolerant of unknown values on read.
- **Phases are additive labels, not control-flow surgery.** `WORKRUN_PHASE`
  gains `close_complete` / `reconcile_complete` / `synthesize_complete` /
  `heal_complete`; readers already must tolerate unknown phases.
  `DreamRunSummary.phases` is a new optional-shaped array; existing fields are
  unchanged and the no-op path returns `phases: []`.
- **Domain classification is structural.** Domain is derived from signal shape:
  `source-freshness` when the contradiction is resolvable by `recorded_at` /
  `created_at` recency beyond a margin; `entity` when signals carry entity
  wikilinks in `source`; `decisions` when scope marks a decision; else
  `claims`. Only `source-freshness` auto-resolves (toward the strictly fresher
  side); everything else becomes an open question. No language inspection.
- **Temporal extraction is ISO-only and additive.** Recognises `YYYY-MM-DD`,
  `YYYY-MM-DD/YYYY-MM-DD`, and ISO-8601 durations (`P7D`, `P2W`, `P1M`, `P1Y`)
  computed against the injected `now`. Fills `valid_from`/`valid_until` on a
  promoted preference only when the field is empty; never overwrites.
- **Heal enrichment is opt-in.** It rewrites user vault files, so it is gated
  behind `dream.heal_enrich_enabled` (default false). Disabled = the heal phase
  is a checkpoint-only no-op. Linking is exact title/alias match only.
- **Morning brief reuses primitives.** Char budgeting via the existing
  `applyCharBudget` (recall-budget.ts); preference ordering by confidence then
  recency (same comparator family as `pre-compress-pack.ts`).

## File changes

New core modules:
- `src/core/brain/pref-audit.ts` - audit record type, `appendPrefAudit`, `readPrefAudit`.
- `src/core/brain/dream-phases.ts` - `DREAM_PHASE` order, `DreamPhaseSummary`, phase-summary builders.
- `src/core/brain/reconcile-domains.ts` - `classifyContradiction`, `resolveContradiction`, `DreamOpenQuestion`.
- `src/core/brain/morning-brief.ts` - `buildMorningBrief`.
- `src/core/brain/temporal-extract.ts` - `extractTemporalConstraints`.
- `src/core/brain/heal-enrich.ts` - `deriveTitleFromContent`, `linkExactMentions`, `planHealEnrichment`.

Modified core:
- `src/core/brain/dream.ts` - phase checkpoints + summaries; call classifier in reconcile, temporal-extract in synthesize promote, heal-enrich in heal; thread audit sink.
- `src/core/brain/preference-txn.ts`, `merge.ts`, `preference.ts` (`moveToRetired`) - optional audit sink param.
- `src/core/brain/dream-workrun.ts` - new phase constants.
- `src/core/brain/types.ts` - `DreamRunSummary.phases`, `open_questions`; new `BRAIN_LOG_EVENT_KIND.reconcile`; audit op enum; config fields.
- `src/core/brain/paths.ts` - `prefAuditDir` / `prefAuditPath`.
- `src/core/brain/policy.ts` - `dream.heal_enrich_enabled` config resolution.
- `src/core/brain/morning-brief.ts` (new, self-contained) - composes the brief from existing read helpers (`readLogDay`, confirmed-preference scan, `open_questions`); does NOT modify `digest.ts`.

Note: `BrainPreference` already carries optional `valid_from` / `valid_until` /
`recorded_at` (added v0.10.18), so feature 5 only fills those existing fields on
the promoted preference - no schema change, no migration.

MCP + CLI surface:
- `src/mcp/brain-tools.ts` (+ `instructions.ts`, `tools.ts`) - `brain_audit`, `brain_morning_brief` (tool count 42 -> 44).
- `src/cli/brain/verbs/audit.ts`, `morning-brief.ts` + `src/cli/brain.ts`, `help-text.ts`.

Docs:
- `README.md`, `docs/how-it-works.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`.

## Risks and open questions

- **Byte-identical default.** Audit (mutation-gated), phases (additive), open
  questions (replace a derived list), temporal (fill-when-empty), heal (opt-in)
  are each designed to leave a default no-op dream run byte-identical. The QA
  phase must assert a no-op run produces zero new files.
- **Concurrent-device audit appends.** Per-pref JSONL append from two devices
  could interleave; acceptable under the single-primary-agent dream convention
  (same assumption as `dream-runs/`). Documented, not solved here.
- **Domain classifier conservatism.** Auto-resolving only source-freshness
  keeps false auto-merges at zero; all judgemental domains stay operator-facing
  open questions. This is intentional under the "no cheap wins" rule.
