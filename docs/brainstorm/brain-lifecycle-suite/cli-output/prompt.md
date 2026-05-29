You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a "Brain lifecycle suite" — a cohesive set of 6 deterministic features that deepen Open Second Brain's nightly consolidation (`dream` pass), make preference mutations auditable, and surface a session-start brief. All features must be DETERMINISTIC (no LLM fan-out, injectable clock, byte-identical given inputs) and LANGUAGE-AGNOSTIC (no hardcoded natural-language word lists, month names, or per-language phrases — handle multilingual input structurally/abstractly).

The 6 features:

1. **Per-preference mutation audit log.** An append-only, structured trail of every mutation to a preference (status change, body edit, promotion, retirement, merge) with: who (agent), what (before/after or a content hash), when (ISO ts), why (reason code). Lets an operator trace the full lifecycle of one preference across dream passes and manual edits. OSB already has `Brain/log/<day>.md` + a JSONL sidecar for narrative events and a timeline projection, but no per-preference mutation audit keyed by pref id.

2. **Multi-phase dream pipeline.** Restructure the single-pass `dream()` into explicit ordered phases — close (day summary) → reconcile (contradictions) → synthesize (promote/confirm) → heal (link orphans, complete metadata, close stale) → log — each emitting a checkpoint summary. Phase ordering must guarantee reconcile-before-synthesize and heal-after-mutations. The existing proven planning/execution logic must be preserved, not rewritten.

3. **Reconcile phase: domain contradiction classification (deterministic).** Replace the current binary same/opposite-sign contradiction handling with a domain-tagged classifier that buckets contradictions into domains (claims / entity / decisions / source-freshness), auto-resolves unambiguous conflicts with a domain-appropriate strategy, and flags ambiguous ones as open questions instead of force-merging. STRICTLY deterministic — NO parallel LLM agents (the upstream inspiration used 4 concurrent LLM agents; we explicitly do not).

4. **Morning brief / day-close summary (deterministic).** A read-only, budgeted summary surfaced at session start: recent digest signals + active preferences + open questions raised by reconcile. Complements the existing on-demand `brain_digest`. The generic external "memory ingest pipeline" from the upstream inspiration is OUT of scope — only the brief.

5. **Temporal extraction from signal text (abstract).** A parser that extracts time constraints from a signal's raw/principle text and attaches them to the EXISTING bi-temporal frontmatter fields (`valid_from` / `valid_until`). Must be abstract: recognise ISO-8601 dates and formal relative offsets (e.g. ISO-8601 durations like `P7D`), NOT localized month/day names or natural-language phrases in any specific language.

6. **Heal phase: deterministic vault enrichment.** In the dream heal phase, complete incomplete frontmatter from content and auto-link orphan pages to existing pages by EXACT title/alias match. LLM-based inference (due-date guessing, workload reasoning) is OUT of scope.

# Project context

Open Second Brain (OSB) — TypeScript on Bun. A single-user, file-based "second brain": a vault of markdown files under `Brain/` (preferences, signals/inbox, retired, log) operated by AI agents through an `o2b` CLI and an MCP server. Byte-identical determinism matters because the vault is synced across devices via Syncthing.

Recent releases (newest first):
- v0.20.0 Recall and ranking quality (Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack)
- v0.17.0 Brain Lifecycle Review Suite (intent review, retention, monthly synthesis, complexity warning)
- v0.14.0 Semantic Brain Health and Self-Maintenance (contradiction detection, concept gaps, stale claims, edit-history, remediation)
- v0.12.0 Brain Integrity Suite (typed collision detection, content-hash drift, durable dream workruns)

Related files (current architecture):
- `src/core/brain/dream.ts` (1974 lines) — the only mutating batch op. Single-pass: `scanBrain` → `planTopics` (same/opposite-sign contradiction handling) → `planRefresh` (counters/confidence/promotion) → `planAutoRetires` → `planSignalMoves` → execute (snapshot → write prefs via `writePreferenceTxn` → `moveToRetired` → move signals to processed/) → emit log events via `writeEvent` → `pruneSnapshots`. Already deterministic on an injected `now`.
- `src/core/brain/dream-workrun.ts` — durable JSONL workrun with `WORKRUN_PHASE` checkpoints (started / cluster_complete / promote_complete / retire_complete / finalized / interrupted) under `Brain/log/dream-runs/<run-id>.jsonl`. Readers must tolerate unknown future phases.
- `src/core/brain/merge.ts` — `mergePreferences(keep, drop)` binary merge with a `MergePlan`.
- `src/core/brain/signal.ts` — `parseSignal`; `BrainSignal` already carries optional bi-temporal `valid_from` / `valid_until` / `recorded_at` fields (added v0.10.18).
- `src/core/brain/preference.ts`, `preference-txn.ts` (`writePreferenceTxn` auto-stamps `_revision` + `_content_hash`), `status.ts`.
- `src/core/brain/log.ts` (`appendLogEvent`, `parseLogDay`), `log-jsonl.ts` (`readLogDay`, JSONL sidecar reader), `types.ts` (`BRAIN_LOG_EVENT_KIND` closed enum + `BRAIN_LOG_EVENT_KIND_SET`).
- `src/core/brain/digest.ts` (1099 lines) — `brain_digest` summary builder.
- `src/core/brain/intent-review.ts` — deterministic pre-dream intent review over signal clusters (two-stage gate, v0.17.0).
- `src/core/brain/timeline.ts` — timeline projection over log events.
- MCP surface: `src/mcp/brain-tools.ts`, `src/mcp/tools.ts`, `src/mcp/instructions.ts`. CLI verbs: `src/cli/brain/verbs/*.ts` (one file per verb, ~45 verbs), dispatched from `src/cli/brain.ts`; shared output helpers in `src/cli/output.ts`.

Conventions:
- TDD with Bun's test runner; tests under `tests/core/brain/` and `tests/mcp/`. Watch RED before GREEN.
- Pure deterministic modules: inject the clock (`now: Date` / `nowMs`), never call `Date.now()` / `Math.random()` in pure code. Byte-identical output for the Syncthing contract.
- New behaviour OFF or no-op by default where it could change existing on-disk output, so a default install stays byte-identical. The dream pass's `changed: false` no-op path must stay a true no-op.
- Additive schema migrations only; tolerate unknown future enum values / phases on read.
- `BRAIN_LOG_EVENT_KIND` is a closed enum — new event kinds extend it and must be added to the validating set.
- One PR = one CHANGELOG version; full project name in public artifacts.

Constraints:
- Do NOT rewrite the proven `dream()` core algorithm — wrap/extend it. Preserve every existing dream invariant (no-op idempotence, pinned-rebut retain, signal suppression, gated retires, guardrail quarantine, workrun checkpoints).
- STRICTLY deterministic — no parallel LLM agents, no network calls, injectable clock everywhere.
- NO hardcoded natural-language word lists / month names / per-language phrases. Multilingual handling must be structural (ISO formats, exact title/alias match, content-shape signals).
- No new external runtime dependencies unless unavoidable.
- Must not duplicate features already shipped (intent review, retention, contradiction *detection*, edit-history `_revision`/`_content_hash`, durable workruns, temporal *storage*).

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
