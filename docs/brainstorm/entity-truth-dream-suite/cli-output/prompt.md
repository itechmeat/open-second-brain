You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Implement the "Entity Truth & Self-Improving Dream Suite" for Open Second Brain: ten related kanban tasks shipped as one release. The suite has two halves.

Half A - entity truth and facts:

1. (t_e9692750, p4) Entity-level truth maintenance: scan stored facts/notes for mutually-exclusive claims about the same entity ("works at Google" vs "works at Meta"), materialize a conflict record with type/priority/resolution strategy (ask_user) instead of silently keeping both; add a name-aware merge guard that blocks dedup-merging two notes whose entity anchors differ ("Alice decided X" must not collapse into "Bob decided X"); add an entity-contamination check rejecting synthesized conclusions that mention entities absent from their cited sources.
2. (t_d6849b56, p2, child of 1) Claim slots: organize extracted facts per entity into addressable aspect slots (e.g. "employer of Alice") where each slot holds a current value plus superseded prior values with provenance lineage; answer "what is true now" while keeping history queryable.
3. (t_cbd22536, p4) Atomic-fact decomposition: deterministically decompose session/turn content into discrete single-sentence assertions using markdown structure (headings/lists/sentences) plus the existing entity extractor - today only fixed-label regex lines (decision:/rule:/...) are captured. No LLM calls.
4. (t_220c313e, p2, child of 3) Quantitative fact family: extend fact extraction with a numeric family (counts, totals, durations, prices, quantities) capturing actor + measured action + target + value, and recall-side aggregation that only combines values satisfying exact-match constraints (excluding merely nearby numbers).
5. (t_f2b225b1, p4) Cross-agent collision detection: a push-mode detector that surfaces when two different agents have independently logged related-but-disconnected facts on the same topic/entity within a recent window, emitting a convergence note/alert instead of waiting for an operator to run a pull-mode diff. Existing substrate: agent-source diff builds shared/unique topics on demand.

Half B - self-improving dream:

6. (t_a8d49eae, p4) Weekly top-source: extend the deterministic weekly synthesis envelope to nominate the single most-developable note of the 7-day window (recency + inbound links + topical centrality) as one ranked finding with a one-sentence why.
7. (t_d478df53, p3) Outcome-tied apply-evidence: add an optional outcome field (success|failure|unknown) to apply-evidence events, and a dream-pass regression rule that flags/demotes a preference whose recent applied events co-occur with negative outcomes - a rule that looks confirmed but is actively hurting.
8. (t_be62c62d, p3) Dead-end registry: a negative-knowledge artifact class - agent-authored lessons recording what was tried and why it failed (or which approach was deliberately set aside), trimmed to most-recent-N, retrievable so recall can surface "avoid X" alongside "prefer Y". Today only positive procedures (skill proposals) exist.
9. (t_fddfe64a, p3) Surprisal sampling: rank dream-pass input signals by embedding-space novelty (distance to nearest neighbors over the existing sqlite-vec index) so the pass prioritizes genuinely new/outlier signals; degrade gracefully when embeddings are unavailable.
10. (t_08a79c81, p3) Foresight: a deterministic forward-projection pass over the continuity log + recurrence routines producing anticipatory notes (likely next needs, upcoming recurring obligations) as a distinct artifact kind - every existing temporal surface is retrospective.

# Project context

Open Second Brain: a Markdown+SQLite second-brain for AI agents. TypeScript on Bun, strict tsc, oxlint/oxfmt, bun test (3838 tests), python plugin suite for Hermes integration. Current version 0.42.0. Vault layout: Brain/inbox (sig-*.md signals), Brain/preferences, Brain/entities/<category>/<id>.md, Brain/log/<date>.md + JSONL device-sharded sidecars, Brain/procedural, Brain/recurrence/events.jsonl, Brain/search (FTS5 + sqlite-vec).

Recent commits:
b16c37d feat: Time-Aware Recall & Activation Suite (#73)
c3a2fcc feat: Agent Write Contract Suite (#72)
7733f20 feat: Project History Suite (#71)
8e8c0bc feat: Memory Observability Suite (#70)
eb56c9f feat: Workspace Insight Suite (#69)

Existing substrate (verified):
- fact-extract.ts: FactFamily = identity|preference|possession|location|url|email|confirmation; FAMILY_PATTERNS regex pairs; routeExtractedFacts writes sig-*.md signals with canonical entity anchors via buildEntityIndex.
- pre-compact-extract.ts: LABELS regex (decision:/commitment:/outcome:/rule:/open_question:) over turn buffers -> continuity records with dedupe keys.
- entities/registry.ts: upsertEntity/relateEntities/listEntities, markdown files with frontmatter, alias claims, canonical name normalization.
- agent-source/diff.ts+query.ts: per-agent contribution aggregation, buildSharedTopics/buildUniqueTopics (pull-mode only).
- temporal/weekly-brief.ts: WeeklySynthesisEnvelope {eventsByKind, statusTransitions, retired, contradictions, vaultDelta, sourcePointers}.
- dream.ts: scan signals -> cluster -> promote/retire, planRefresh computes confidence_value + freshness_trend, collectEvidenceForSlug scans log JSONL for apply-evidence rows, snapshot+rollback workrun, DreamRunSummary with warnings/uncertain/quarantined/gated_retires.
- apply-evidence.ts: appendApplyEvidence {pref_id, artifact, result: applied|violated|outdated, agent, note?} -> Brain/log markdown + JSONL.
- search/store.ts: semanticTopK over sqlite-vec; works only when embeddings indexed; keyword FTS fallback.
- recurrence.ts: append-only events.jsonl, commitment ladder exploring->leaning->decided->locked.
- skill-proposals.ts: positive-procedure mining from continuity records into Brain/procedural/proposals/pending.
- maintenance/action-scorer.ts: scoreDedup (content similarity, no entity check) feeding digest action items.
- deep-synthesis.ts: topic-scoped DeepSynthesisReport {notes, agreements, contradictions, staleClaims, gaps}.
- Versioned-envelope convention: schema-version constants (e.g. CONTINUITY_SCHEMA_VERSION "o2b.continuity.v1"), additive optional fields without bump.
- CLI verbs in src/cli/brain/verbs/<name>.ts + switch registration; MCP tools as ToolDefinition in src/mcp/brain-tools.ts.

Conventions:
- Deterministic, provider-free core paths; LLM/embedding-dependent features must degrade gracefully and be opt-in.
- Everything explainable: ranked outputs carry reasons; envelopes are frozen, replayable folds over append-only events preferred over mutable state.
- Fail-closed validation on persisted JSON; bounded caps (retention days, max counts) on every append-only store.
- One PR = one CHANGELOG version; ~50-70 files, 10 features max.

Constraints:
- No new external dependencies (no spaCy/GLiNER; pure TS heuristics only).
- No changes to existing public API semantics; new fields optional/additive.
- bit-identical neutral defaults: with no new data present, existing outputs (search results, dream runs, weekly envelopes) must not change.
- All new persisted formats need version fields and fail-closed parsing.
- Sentence decomposition must be deterministic (no model calls).

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
