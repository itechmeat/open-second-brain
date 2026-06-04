# Entity Truth & Self-Improving Dream Suite - one ledger for what is true, one feedback loop for what works

**Status:** approved
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain records facts, preferences, and evidence but has no notion of "what is true about this entity right now": two contradictory stored facts coexist silently, dedup can merge notes about different people, and synthesized conclusions can cite entities their sources never mention. On the learning side, the dream pass trusts self-reported evidence with no outcome signal, keeps no negative knowledge (what was tried and failed), treats all inbox signals as equally novel, and every temporal surface looks backward only.

## Scope

Half A - the Entity-Truth Ledger (`src/core/brain/truth/`):

- **Claim ledger** (t_d6849b56): device-sharded append-only JSONL (`Brain/truth/claims.<deviceId>.jsonl`) of versioned claim events `(entity, aspect, value, source, agent, ts)`; a deterministic fold projects per-`(entity, aspect)` slots holding the current value plus superseded history with provenance lineage.
- **Conflict detection** (t_e9692750): the same fold materializes conflict records when two distinct values for one slot land within the conflict window (default 30 days) from independent sources - typed, prioritized, `resolution: ask_user`, never auto-resolved.
- **Merge guard** (t_e9692750): a name-aware guard refuses dedup-merge recommendations and `brain merge` executions when the two notes' person/org entity anchors differ; explainable refusal reason.
- **Contamination check** (t_e9692750): validates that every entity mentioned in a synthesized conclusion appears in at least one cited source; exposed as a pure function plus CLI verb, wired into deep-synthesis report output.
- **Atomic-fact decomposition** (t_cbd22536): deterministic decomposer (`atomic-facts.ts`) splitting turn/session text into single assertions via markdown structure (heading context, list items, sentence boundaries with abbreviation guard), anchored to canonical entities via the existing entity index; assertions with `(entity, aspect)` shape ingest into the ledger via an explicit verb - the capture hot path is untouched.
- **Quantitative fact family** (t_220c313e): new `quantity` fact family (actor + measured action + target + numeric value + unit) in fact-extract patterns; quantity claims land in the ledger; `aggregateQuantities` sums only exact-`(entity, action, unit)` matches, never nearby numbers.
- **Cross-agent collision detection** (t_f2b225b1): a detector over recent ledger events that surfaces when two agents independently wrote related claims on the same entity within the window without referencing each other; runs inside dream/digest (push-mode) and as a verb; emits a convergence note event to `Brain/log/`.

Half B - self-improving dream (no new shared machinery; additive fields + small modules):

- **Weekly top-source** (t_a8d49eae): `WeeklySynthesisEnvelope` gains optional `topSource` - the single most-developable note of the window ranked by recency + inbound links + topical centrality, with a one-sentence why and the per-signal breakdown.
- **Outcome-tied apply-evidence** (t_d478df53): `appendApplyEvidence` accepts optional `outcome: success|failure|unknown`; dream's refresh detects preferences whose recent `applied` events co-occur with `failure` outcomes and stages an explainable `outcome_regressions` finding with a confidence penalty (demotion is staged, never silent retirement).
- **Dead-end registry** (t_be62c62d): negative-knowledge notes `Brain/dead-ends/*.md` (frontmatter `kind: brain-dead-end`, approach + why-it-failed + context), markdown-first so FTS indexes them for recall; bounded by most-recent-N with archive-on-overflow; CLI verb + MCP tool to record/list.
- **Surprisal sampling** (t_fddfe64a): novelty score per inbox signal = mean sqlite-vec distance to k nearest indexed chunks (existing embeddings only - no provider calls; neutral when vec index is empty); ranks `brain_review_candidates` ordering and annotates the dream summary; never changes which signals get processed.
- **Foresight** (t_08a79c81): deterministic forward projection `buildForesight` folding recurrence routines (cadence next-due), open commitments/open questions from continuity records, and recent log trends into a versioned `ForesightEnvelope` (`upcoming: recurring | commitment | trend` items with sources); CLI verb + MCP tool; optional `--write` persists `Brain/foresight/<date>.md`.

## Out of scope

- LLM/NER-based extraction (no spaCy/GLiNER; pure deterministic heuristics only).
- Auto-resolution of conflicts (strategy is always `ask_user` in this release).
- Observer-scoped beliefs (t_741a64b0), derived-fact synthesis (t_ec6df40a), staged dream bundles (t_ae8a8ec0) - separate cycles.
- UNIQUE-constraint canonical entity enforcement in SQLite (markdown registry stays the source of truth).
- Rewiring capture/pre-compact hot paths to auto-ingest into the ledger (explicit verb only this release).

## Chosen approach

Consultant Variant 2 (two cohesive cores) with three containment refinements (see variants.md): the Entity-Truth Ledger persists as fold-over-append-only events in the proven activation-store/log-jsonl shape rather than mutable state; Half B drops the "Dream Signal Bus" abstraction in favor of the existing ranked-`reasons` convention; the capture hot path stays bit-identical with ledger ingest as an explicit step. All of Half A composes over one claim representation: decomposition and the quantity family produce claims, slots fold them, conflicts and contamination are queries over the fold, collision diffs per-agent writes.

## Design decisions

- **Device-sharded JSONL for claims** - Syncthing-safe concurrent appends, matching `log-jsonl.ts`; the fold (`computeTruthState`) is order-insensitive and recomputable, matching `activation/store.ts`; derived `Brain/truth/state.json` is a cache, never authority.
- **`TRUTH_SCHEMA_VERSION = 1` on every event line + fail-closed parsing** - unknown/invalid lines are skipped with a counted warning, never crash, matching repo convention.
- **Conflict rule is purely temporal-structural** (same slot, distinct normalized values, within window, distinct sources): deterministic, no semantics guessing; later value outside the window supersedes silently (that is normal fact evolution).
- **Merge guard blocks only on disjoint person/org anchor sets** - notes with no entity anchors or overlapping anchors merge as today, so existing dedup behavior changes only where it was demonstrably unsafe.
- **Quantity aggregation requires exact `(entity, action, unit)` equality** after canonical normalization - the article's "exclude nearby numbers" rule made structural.
- **Markdown-first dead-ends** - notes index into FTS automatically, so "recall surfaces avoid-X" needs zero search changes; the bounded registry is a directory listing, not a parallel store.
- **Surprisal reads existing embeddings only** - graceful neutral degradation (`novelty: null`) without a vec index; review-candidates ordering is presentation, so dream mutations stay byte-identical.
- **Outcome regression stages, never retires** - a flagged preference gets `outcome_regressions` entry + confidence penalty; retirement still goes through existing gates (operator-auditable).
- **Foresight is a fold, not a planner** - only deterministic projections (cadence arithmetic, open items, trend counts); no speculation, every item carries `sources`.
- **Bit-identical neutral defaults everywhere** - empty ledger folds to empty state; absent outcome field keeps current confidence math; `topSource` is absent when the window has no candidates; foresight of an empty vault is an empty envelope.

## File changes

New core: `src/core/brain/truth/{types,store,fold,conflicts,merge-guard,contamination,collision,aggregate}.ts`, `src/core/brain/atomic-facts.ts`, `src/core/brain/dead-ends.ts`, `src/core/brain/surprisal.ts`, `src/core/brain/temporal/foresight.ts`.
Modified core: `fact-extract.ts` (quantity family), `apply-evidence.ts` (outcome), `dream.ts` (outcome regressions, collision step, surprisal annotation), `temporal/weekly-brief.ts` (topSource), `deep-synthesis.ts` (contamination wiring), `maintenance/action-scorer.ts` + merge verb (guard), `review-candidates.ts` (novelty ordering), `types.ts` (log event kinds).
CLI: new verbs `truth` (ingest/slots/conflicts/aggregate/collisions), `facts` (decompose), `dead-end` (record/list), `foresight`; registration in `brain.ts`, `verbs/index.ts`, help-text, command-manifest.
MCP: `brain_truth`, `brain_dead_ends`, `brain_foresight` tool definitions; schema extensions for `brain_apply_evidence` (outcome).
Tests: one suite per new module + integration e2e + CLI suites + extended existing suites (apply-evidence, weekly-brief, dream, fact-extract, review-candidates).
Docs: README, CHANGELOG 0.43.0, docs/cli-reference.md, docs/how-it-works.md.

## Risks and open questions

- Sentence splitting on prose is the least deterministic-feeling part - mitigate with a conservative splitter (paragraph/list/heading first, sentence split only with abbreviation guard) and golden-file tests.
- Aspect inference for claims ("employer of Alice") from free text is heuristic - restrict ledger auto-ingest to assertions matching the existing fact families (which carry structure) and accept explicit aspect on the verb; do not guess aspects from arbitrary prose.
- Dream summary growth - new findings (collisions, regressions, novelty) are bounded lists with caps, all optional fields.
- Performance of fold on large ledgers - same mitigation as activation store: retention caps + derived state cache keyed by event count/fingerprint.
