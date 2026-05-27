# Semantic Brain Health & Self-Maintenance - design

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

`brain_doctor` today validates only structural vault invariants (frontmatter validity, duplicate IDs, ISO parsing, dangling wikilinks, near-duplicate preferences, content-hash drift) and never mutates state. It cannot tell when two confirmed preferences contradict each other, when a recurring concept has no home, or when a confirmed rule is running on stale evidence - and it cannot repair anything it finds. As a vault grows, contradictory preferences and orphaned signals accumulate silently. This bundle turns the doctor into a genuine semantic quality gate and adds a bounded, deterministic self-maintenance path.

## Scope

- **F1 - Cross-preference contradiction detection.** Surface pairs of confirmed preferences about the same subject that carry an opposite sign of record (positive vs negative). Language-agnostic: pairing uses token overlap (`similarity.ts`); polarity uses the sign derived from each preference's `evidenced_by` signals - never a negation word list.
- **F2 - Concept-gap detection.** Terms that recur across the signal + preference corpus at or above a configured frequency yet have no dedicated preference topic. Reuses `tokenise`; multi-codepoint terms only.
- **F3 - Stale-claim flagging.** Confirmed preferences whose newest supporting evidence (`last_evidence_at`) is older than a configured age window relative to the injected clock.
- **F4 - Per-preference edit-history audit trail.** Append-only `Brain/preferences/<slug>.history.jsonl` sidecar capturing one entry per content mutation `{ts, agent, revision, field, before, after}`. Written from the `writePreferenceTxn` chokepoint; rendered as a timeline on demand. Excluded from the search index.
- **F5 - Dependency-ordered remediation with dry-run.** A standalone planner turns doctor findings into an ordered repair plan, classifies each step `auto-safe` (deterministic) vs `needs-review`, applies only auto-safe steps outside dry-run through `writePreferenceTxn`, and refuses past a bounded step cap. No background worker, no paid LLM call.
- **F6 - Semantic-health reconciliation surface.** A single deterministic pass that runs the three detectors partitioned into domains (preferences / evidence / retirement) and returns one structured report plus a verdict. No sub-agent spawning.
- MCP + CLI surfaces for the above (`brain_health` tool, `o2b brain health`, `o2b brain doctor --remediate [--dry-run]`, `o2b brain history <slug>`).

## Out of scope

- Background-job / minion worker systems and any paid LLM remediation (explicitly excluded by the upstream-task constraints).
- Sub-agent spawning for reconciliation (upstream does this; we do a single deterministic pass instead).
- Vector / semantic-embedding contradiction detection - we stay structural and dependency-free.
- Multi-vault or cross-agent reconciliation.

## Chosen approach

Variant 2 (consultant recommendation, adopted): a new pure-core module layer `src/core/brain/health/` with one detector module per concern, a reconciliation aggregator, an edit-history sidecar reader/writer, and a standalone remediation engine. `doctor.ts` stays non-mutating - it calls the detectors best-effort (one `try` boundary each, mirroring the existing hygiene lints) and merges their findings into its `warnings`/`errors` stream and an optional semantic-health report. Every mutation funnels through the existing `writePreferenceTxn` chokepoint, so revision bump, content-hash bookkeeping, and the new edit-history append all happen in one place.

This mirrors the shipped `assess-rule-quality.ts` pure-gate pattern and the "pure core + thin MCP/CLI shell" convention, and avoids both the non-mutating-contract blur of cramming `remediate()` into `doctor.ts` (Variant 1) and the regression risk of retrofitting the v0.12 structural `check*` helpers into a new findings registry (Variant 3).

## Design decisions

- **Polarity without a dictionary.** A confirmed preference's sign is the dominant sign of the signals in its `evidenced_by` (the same "sign of record" derivation `dream.ts` already uses). Contradiction = same `(scope)` bucket + principle jaccard >= threshold + opposite sign. Extract the dominant-sign helper so detector and dream share one definition (DRY); fall back to "unknown" sign when no evidence resolves, and skip unknown-sign preferences rather than guess.
- **Concept-gap is frequency-only.** Count multi-codepoint tokens across signal + preference principles; a term at or above `min_frequency` with no preference whose `topic` or principle contains it is a gap. No notion of "importance" beyond raw recurrence - deterministic and language-blind.
- **Edit-history is convergent under sync.** The sidecar is append-only but `appendEditHistory` is idempotent per `(revision, field)`: an entry whose revision+field+after already exists is not duplicated. Two Syncthing peers that both replay the same write therefore converge instead of diverging. Excluded from the search index via a built-in ignore rule for `*.history.jsonl`.
- **Remediation ordering is explicit and deterministic.** Steps are emitted in a fixed dependency order (config/structural fixes before semantic ones; retirements last) and sorted by a stable key, so the same findings always yield the same plan on every peer. Only fixes that are provably reversible-by-construction and need no human judgment are `auto-safe` (e.g. retire a stale-evidence preference under the existing guardrail, drop an orphan apply-evidence artifact); contradictions and concept-gaps are always `needs-review`.
- **Doctor stays non-mutating; remediation is opt-in.** `runDoctor` never writes. `planRemediation` is pure. `applyRemediation` is the only writer and honors `dryRun` + `stepCap`.
- **Best-effort detector boundaries.** Each detector is wrapped in its own `try` inside `doctor.ts` so one broken scan cannot mask the others, matching the existing hygiene-lint convention.

## File changes

**New (`src/core/brain/health/`):**
- `contradiction.ts` - `detectContradictions(...)`, pure.
- `concept-gap.ts` - `detectConceptGaps(...)`, pure.
- `stale-claim.ts` - `detectStaleClaims(...)`, pure.
- `reconcile.ts` - `reconcileSemanticHealth(...)` domain-partitioned single pass + verdict.
- `edit-history.ts` - `appendEditHistory`, `readEditHistory`, `renderEditHistory`, types.
- `remediation.ts` - `planRemediation` (pure) + `applyRemediation` (writer via txn).
- `sign.ts` - shared dominant-sign-of-record helper extracted from `dream.ts` (or a thin re-export if a helper already exists).

**Modified:**
- `doctor.ts` - call the three detectors best-effort, merge findings, attach optional `semantic_health` to `RunDoctorResult`.
- `preference-txn.ts` - on `willChange`, diff `ctx.existing` vs proposed and append edit-history (idempotent).
- `dream.ts` - use the extracted `sign.ts` helper (no behavior change).
- `types.ts` - finding/report/edit-history types, new `DoctorIssue` codes.
- `src/core/vault-scope/defaults.ts` (`DEFAULT_VAULT_IGNORE_PATHS`) - exclude `*.history.jsonl`.
- brain config - a new `health` section on `BrainConfig` (`src/core/brain/types.ts`) with defaults in `DEFAULT_BRAIN_CONFIG` and parsing in the loader (`src/core/brain/policy.ts`): `contradiction_jaccard`, `concept_gap_min_frequency`, `stale_claim_max_age_days`, `remediation_step_cap`.
- `src/mcp/brain-tools.ts` - `brain_health` tool; extend `brain_doctor` output.
- `src/cli/brain/verbs/` - `health.ts`, `history.ts`, `doctor.ts` (`--remediate`, `--dry-run`).
- `src/core/brain/index.ts` / barrel exports.
- README, CHANGELOG, docs/*.

## Risks and open questions

- **Sign derivation cost.** Resolving `evidenced_by` for every confirmed pref means indexing signals once per doctor run; reuse the single snapshot pattern already in `doctor.ts` to avoid re-parsing.
- **Edit-history backfill.** Existing preferences have no history file; the first mutation after upgrade seeds the trail from the current state. No retroactive reconstruction (documented, not a bug).
- **Auto-safe conservatism.** Initial release keeps the auto-safe set deliberately small; expanding it later is additive. Better to under-fix than to auto-mutate something needing judgment.
