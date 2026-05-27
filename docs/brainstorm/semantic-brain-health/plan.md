# Semantic Brain Health & Self-Maintenance - implementation plan

Each task is one atomic unit, implemented RED-GREEN-REFACTOR on the
`feat/semantic-brain-health` branch, one conventional commit per task.
Detectors are pure and land before the surfaces that consume them.

## Tasks

### Task 1: Shared sign-of-record helper
- **Files**: `src/core/brain/health/sign.ts`, extract from `src/core/brain/dream.ts`; `tests/core/brain/health/sign.test.ts`
- **Acceptance**: `dominantSign(evidencedBy, signalsById)` returns `positive | negative | unknown` matching dream's existing derivation; dream.ts uses it with no behavior change (existing dream tests stay green).
- **Depends on**: none

### Task 2: Contradiction detector (F1)
- **Files**: `src/core/brain/health/contradiction.ts`; `tests/core/brain/health/contradiction.test.ts`
- **Acceptance**: `detectContradictions(prefs, signalsById, {jaccard})` returns findings for same-scope confirmed pref pairs with principle jaccard >= threshold and opposite resolved sign; skips unknown-sign prefs; deterministic ordering (a.id < b.id).
- **Depends on**: Task 1

### Task 3: Concept-gap detector (F2)
- **Files**: `src/core/brain/health/concept-gap.ts`; `tests/core/brain/health/concept-gap.test.ts`
- **Acceptance**: `detectConceptGaps(corpus, {minFrequency})` counts multi-codepoint tokens across signal + preference principles and returns terms at/above frequency with no covering preference topic/principle; language-agnostic; stable order (frequency desc, then term).
- **Depends on**: none

### Task 4: Stale-claim detector (F3)
- **Files**: `src/core/brain/health/stale-claim.ts`; `tests/core/brain/health/stale-claim.test.ts`
- **Acceptance**: `detectStaleClaims(prefs, {maxAgeDays, now})` flags confirmed prefs whose `last_evidence_at` is older than the window; injectable `now`; prefs without evidence date are skipped (reported elsewhere).
- **Depends on**: none

### Task 5: Edit-history sidecar (F4)
- **Files**: `src/core/brain/health/edit-history.ts`; `tests/core/brain/health/edit-history.test.ts`
- **Acceptance**: `appendEditHistory` writes one JSONL line per `(revision, field)` change and is idempotent (re-append of same revision+field+after is a no-op); `readEditHistory` round-trips; `renderEditHistory` produces a deterministic timeline; malformed lines are skipped.
- **Depends on**: none

### Task 6: Wire edit-history into the write chokepoint (F4)
- **Files**: `src/core/brain/preference-txn.ts`; `tests/core/brain/preference-txn-history.test.ts`
- **Acceptance**: a `writePreferenceTxn` call that changes bytes appends field-level before/after entries; a no-op rewrite appends nothing; first write after upgrade seeds from current state; search-index ignore covers `*.history.jsonl`.
- **Depends on**: Task 5

### Task 7: Reconciliation surface (F6)
- **Files**: `src/core/brain/health/reconcile.ts`; `tests/core/brain/health/reconcile.test.ts`
- **Acceptance**: `reconcileSemanticHealth(...)` runs the three detectors partitioned into domains and returns `{ domains: {...}, verdict }` in a single deterministic pass; verdict escalates clean -> watch -> investigate by finding severity/count.
- **Depends on**: Tasks 2, 3, 4

### Task 8: Doctor integration
- **Files**: `src/core/brain/doctor.ts`, `src/core/brain/types.ts`; `tests/core/brain/doctor-semantic.test.ts`
- **Acceptance**: `runDoctor` calls the three detectors best-effort, merges findings as warnings with new codes (`contradictory-preferences`, `concept-gap`, `stale-claim`), and attaches an optional `semantic_health` report; a broken detector cannot mask others; clean vault stays clean.
- **Depends on**: Tasks 2, 3, 4, 7

### Task 9: Remediation planner + executor (F5)
- **Files**: `src/core/brain/health/remediation.ts`; `tests/core/brain/health/remediation.test.ts`
- **Acceptance**: `planRemediation(findings, {stepCap})` emits a deterministically-ordered plan with `auto-safe | needs-review` classification; `applyRemediation(vault, plan, {dryRun})` mutates nothing under `dryRun`, applies only auto-safe steps through `writePreferenceTxn` otherwise, and stops at `stepCap`.
- **Depends on**: Task 8

### Task 10: MCP + CLI surfaces
- **Files**: `src/mcp/brain-tools.ts`, `src/cli/brain/verbs/health.ts`, `src/cli/brain/verbs/history.ts`, `src/cli/brain/verbs/doctor.ts`, barrel exports; `tests/mcp/brain-health.test.ts`, `tests/cli/brain-health.test.ts`
- **Acceptance**: `brain_health` MCP tool returns the reconcile report; `o2b brain health`, `o2b brain history <slug>`, and `o2b brain doctor --remediate [--dry-run]` work end-to-end against a temp vault.
- **Depends on**: Tasks 7, 8, 9

### Task 11: Config thresholds
- **Files**: brain config schema + loader, defaults; `tests/core/brain/config-health.test.ts`
- **Acceptance**: `contradiction_jaccard`, `concept_gap_min_frequency`, `stale_claim_max_age_days`, `remediation_step_cap` parse with safe defaults and feed the detectors; absent config falls back to defaults without throwing.
- **Depends on**: Tasks 2, 3, 4, 9
