# Entity Truth & Self-Improving Dream Suite - implementation plan

TDD order: each task starts with failing tests, lands as one conventional commit, formatter + linter green before every commit.

## Tasks

### Task 1: Claim ledger core (types, store, fold) - t_d6849b56
- **Files**: `src/core/brain/truth/types.ts`, `truth/store.ts`, `truth/fold.ts`; tests `tests/core/brain/truth/store.test.ts`, `truth/fold.test.ts`
- **Acceptance**: append claim events to device-sharded JSONL; fold projects `(entity, aspect)` slots with current value + superseded history + provenance; order-insensitive fold; fail-closed line parsing (invalid lines counted, skipped); derived `Brain/truth/state.json` cache recomputable from events; retention caps enforced.
- **Depends on**: none

### Task 2: Conflict detection over the fold - t_e9692750
- **Files**: `truth/conflicts.ts`; extend fold state with conflicts; tests `truth/conflicts.test.ts`
- **Acceptance**: two distinct normalized values for one slot within the window (default 30d) from distinct sources materialize a typed conflict record (`resolution: ask_user`); later value outside window supersedes silently; conflicts queryable from fold state.
- **Depends on**: Task 1

### Task 3: Merge guard + contamination check - t_e9692750
- **Files**: `truth/merge-guard.ts`, `truth/contamination.ts`; wire into `maintenance/action-scorer.ts` (skip recommending guarded pairs) and merge verb (refuse with reason, `--force` override); contamination wired into `deep-synthesis.ts` report; tests `truth/merge-guard.test.ts`, `truth/contamination.test.ts`, extended action-scorer + deep-synthesis tests
- **Acceptance**: disjoint person/org anchor sets block merge with explainable reason; overlapping/absent anchors unchanged; conclusions mentioning entities absent from cited sources flagged with the offending entities listed.
- **Depends on**: Task 1 (canonical entity normalization helpers)

### Task 4: Atomic-fact decomposition - t_cbd22536
- **Files**: `src/core/brain/atomic-facts.ts`; CLI verb `facts decompose` (+ optional `--ingest` to ledger); tests `tests/core/brain/atomic-facts.test.ts`, CLI test
- **Acceptance**: deterministic split by heading context / list items / sentences (abbreviation guard); assertions carry line, headingPath, canonical entity anchors; golden-file determinism test; fact-family-shaped assertions ingest as claim events via explicit flag only.
- **Depends on**: Task 1

### Task 5: Quantitative fact family + exact aggregation - t_220c313e
- **Files**: `fact-extract.ts` (quantity family), `truth/aggregate.ts`; tests extended fact-extract suite + `truth/aggregate.test.ts`
- **Acceptance**: quantity pattern captures actor + action + value + unit; `aggregateQuantities` sums only exact `(entity, action, unit)` matches after normalization; nearby-number exclusion test; existing families' outputs byte-identical.
- **Depends on**: Tasks 1, 4

### Task 6: Cross-agent collision detection - t_f2b225b1
- **Files**: `truth/collision.ts`; dream/digest push step + log event kind `collision`; tests `truth/collision.test.ts` + dream extension test
- **Acceptance**: claims on one entity/topic from 2+ distinct agents within the window, not referencing each other, emit one bounded convergence finding (push-mode in dream, pull-mode via verb); no events -> no findings (bit-identical dream summary).
- **Depends on**: Tasks 1, 2

### Task 7: Truth CLI verb + MCP tool surface
- **Files**: `src/cli/brain/verbs/truth.ts`, `verbs/facts.ts`; `brain.ts` switch, `verbs/index.ts`, help-text, command-manifest; `src/mcp/brain-tools.ts` `brain_truth`; CLI + MCP tests
- **Acceptance**: `brain truth ingest|slots|conflicts|aggregate|collisions` and `brain facts decompose` work end-to-end on a temp vault; MCP `brain_truth` returns frozen envelopes; exit codes 0/1/2 convention.
- **Depends on**: Tasks 1-6

### Task 8: Outcome-tied apply-evidence + dream regression rule - t_d478df53
- **Files**: `apply-evidence.ts` (optional `outcome`), MCP schema, CLI flag; `dream.ts` planRefresh regression detection (`outcome_regressions` in DreamRunSummary, staged confidence penalty); tests extended apply-evidence + dream suites
- **Acceptance**: outcome persisted in log markdown + JSONL; absent outcome keeps confidence math byte-identical; >=K recent applied-with-failure events stage a regression finding + penalty, never silent retirement; idempotent rerun stays no-op.
- **Depends on**: none (parallel to Half A)

### Task 9: Dead-end registry - t_be62c62d
- **Files**: `src/core/brain/dead-ends.ts`; CLI verb `dead-end record|list`; MCP `brain_dead_ends`; tests core + CLI
- **Acceptance**: markdown notes under `Brain/dead-ends/` with `kind: brain-dead-end` frontmatter (approach, reason, context, agent); bounded most-recent-N with archive-on-overflow; FTS finds them after indexing (recall smoke test).
- **Depends on**: none

### Task 10: Surprisal sampling - t_fddfe64a
- **Files**: `src/core/brain/surprisal.ts`; `review-candidates.ts` novelty ordering + annotation; dream summary annotation; tests core + extended review-candidates
- **Acceptance**: novelty = mean distance to k nearest indexed chunks over existing sqlite-vec; empty/absent vec index -> `novelty: null`, ordering unchanged; dream mutations byte-identical with and without novelty.
- **Depends on**: none

### Task 11: Weekly top-source + foresight - t_a8d49eae, t_08a79c81
- **Files**: `temporal/weekly-brief.ts` (`topSource` optional field), `temporal/foresight.ts` (`ForesightEnvelope`, `buildForesight`); CLI verb `foresight` (+ `--write`); MCP `brain_foresight`; tests extended weekly + new foresight suites
- **Acceptance**: topSource ranks recency + inbound links + centrality with per-signal breakdown and one-line why, absent when no candidates; foresight folds recurrence next-due + open commitments/questions + trend counts into versioned envelope, every item carries sources; empty vault -> empty envelope.
- **Depends on**: none

### Task 12: E2E integration + docs
- **Files**: `tests/e2e/entity-truth-dream.integration.test.ts`; README, CHANGELOG 0.43.0, docs/cli-reference.md, docs/how-it-works.md
- **Acceptance**: one vault exercises ledger ingest -> slots -> conflict -> collision -> aggregation, plus outcome regression, dead-end recall, novelty ranking, topSource, foresight; full suite green; docs describe every new surface.
- **Depends on**: Tasks 1-11
