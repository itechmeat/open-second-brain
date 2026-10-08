You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Implement the "Truth, Correctable & Time-Aware" release wave for Open Second Brain: five kanban cards of one truth/claim subsystem, shipped together on branch feat/truth-correctable-time-aware (v1.76.0 plus this wave, nothing else).

1. (t_edba0c15, p3) Per-claim temporal validity windows. Carry optional valid_from/valid_until on truth-ledger claim events and their append input, defaulted from the source record's event time; extend the conflict policy layer so two claims about the same entity#aspect slot with non-overlapping windows classify as succession (predecessor/successor over validity time) instead of contradiction, ending the ingest-order dependence where a 2024-dated fact ingested today reads as a fresh contest. Windowless behavior stays byte-identical (test-pinned); succession must never enter ask_user semantics. The upstream card's claims-table-view half is already at parity and is out of scope.
2. (t_cb7ff437, p2) Windowed entity-fact recall. Add since/until to the truth-ledger recall surface (MCP brain_truth, CLI o2b brain truth) reusing the one strict time-range grammar (unparseable or inverted bounds error INVALID_PARAMS, never silently widening), returning the claim events for an entity within the window. Today slots returns the fold plus an event count; the field name events is taken and test-pinned, so this is a response-shape addition (new field or new operation), not a data-model change. The filter is on assertion ingest time (ts) and stays visibly distinct from fact-validity windows.
3. (t_c37af4e9, p2) Multi-hop recall across claim/entity chains. Extend the existing fourth RRF arm (default-off, rrf-only, depth 2, document typed edges only) with deeper bounded traversal, width caps (seed, per-node expansion, total), hub-entity skip defined without prose inspection, ordered-path provenance with per-node reach gating, and a structural direct-hit precedence guarantee (today a relational-only row can outrank a direct hit under neutral RRF weight). Edge types come only from the schema vocabulary; the arm never reads prose.
4. (t_cabe84aa, p3) Single correct-this-fact verb with served-only-with-correction coupling. One deterministic verb that, given a correction, discovers every affected record (claim-graph whatReplaced/whatContests plus search plus wikilink mentions), retires each in place, rewrites or annotates inline mentions, and emits one receipt bundle with a correlation id. Plus the serving invariant: a retired claim is never served bare — whenever it reaches a caller, its correction reaches with it, on every serving surface. Today only a best-effort, search-pipeline-only demote-and-pull-in exists for non-tombstoned predecessors, and supersede hides records outright, which makes the coupling vacuous for its own outputs unless the record state or the serving path changes.
5. (t_3e87656b, p2) Agent-stated claims with mechanical grounding. The writing agent declares subject/relation/object claims; the engine grounds each mechanically (subject and object must occur in the note text; relation names pass the single relation-vocabulary boundary), commits grounded claims with an agent_stated extractor tag plus provenance, reports ungrounded ones back per claim, and conflict detection reasons over claim provenance — annotation, priority and ordering only; conflicts stay resolution ask_user. Self-mined relation-template learning is split out of this wave by validator decision (auto-application to plain writes would collide with apply-gate discipline).

# Project context

Open Second Brain: a memory layer for AI agents that lives in an Obsidian-compatible Markdown vault (Brain/). TypeScript on Bun, strict tsc, oxlint/oxfmt, bun test. Surfaces: MCP servers, lifecycle hooks, the o2b CLI. Deterministic-first core: no model runs in the core paths; the decision model, where present, is probabilities-only and never writes.

Recent commits:
646a49df feat: freshen the search index on read, rewriting only changed chunks (v1.76.0) (#239)
78f924b9 feat: deliver context to subagent turns, hygiene digest at turn end and tiered context shrink (v1.75.0) (#238)
542d214b fix(opencode): support both plugin APIs (v1.74.1) (#190)
0cbb60b8 feat: near-duplicate defense across the fact lifecycle (v1.74.0) (#237)
0f0c9a76 feat: honest query embeds and drift-checked upgrades (v1.73.0) (#235)
2b424d9a feat: honest embedding spend and a semantic belief order (v1.72.0) (#234)

Related substrate (verified against the live tree by premise-verification recons; all anchors live at HEAD 646a49df):
- Truth ledger (append-only device-sharded JSONL plus a derived, recomputable state cache): src/core/brain/truth/types.ts (ClaimEvent has v/ts/agent/entity/aspect/value/valueKind/quantity/source and no validity fields; TruthState.events is a count), fold.ts (deterministic total order, history cap), conflicts.ts (CONFLICT_WINDOW_DAYS 30, assertion-time contestation, kind value_conflict, resolution ask_user pinned; the base fold is returned unchanged when nothing contests — test-pinned), store.ts (fail-closed coercion at TRUTH_SCHEMA_VERSION 1, conditional-spread serialization, 10k-event cap), ingest.ts (deterministic structurers only).
- Claim-graph projection (rebuildable view over frontmatter; 5000-node cap; six subdirs only): src/core/brain/claim-graph.ts (valid_from/valid_until, provenance, superseded_by, contradicts; truthAt half-open; whatReplaced/whatContests).
- Lifecycle: src/core/brain/lifecycle/tombstone.ts (in-place supersede/tombstone with superseded_by, receipts), lifecycle/temporal-replace.ts (half-open [valid_from, valid_until) close-and-open at one shared instant — the non-tombstoning correction primitive).
- Correction substrate: src/core/brain/page-dedup.ts (retargetWikilinks with apply:false dry-run and neverRewrite for Brain/log), heal-enrich.ts (linkExactMentions), write-batch.ts (validate-all-then-commit batch ops; no retirement op type), decisions/receipts.ts (closed receipt schema, per-record idempotency).
- Cooperative write paths: src/core/brain/intake/extract-intake.ts (declared entities and relations, refuse-before-write, mandatory provenance, quarantine lane), derived-fact.ts (grounding by reference to premises), atomic-facts.ts (anchorEntities literal-occurrence kernel), src/core/graph/relation-vocab.ts (single six-token relation boundary), src/core/brain/provenance/ (stated over deduced over inferred).
- Recall: src/core/search/relational-fanout.ts and pipeline/relational-arm.ts (fourth RRF arm; default-off and rrf-only; depth 2; no width caps; type-list provenance, no ordered path), fusion.ts (neutral lane weight, so no direct-hit precedence today), relation-polarity.ts (default-on demote 0.6 and successor pull-in 0.9; unresolved successor inert), result-filters.ts (tombstoned rows dropped first; fail-closed reach filter), enrich.ts (note-level trust, opt-in replacement pointer), pipeline/post-rank.ts (recorded gap: pulled-in successors bypass visibility and agent-scope), time-range.ts plus recall-tools.ts resolveSessionGrepBounds (the one strict grammar and the SearchError-to-INVALID_PARAMS boundary, module-private today), validity.ts and pipeline/event-time.ts (search-side validity windows, a distinct layer), retrieval-trail.ts (typed provenance vocabulary; per-row reasons are strings).
- Surfaces: src/mcp/brain/knowledge-tools.ts (brain_truth ops ingest|slots|conflicts|aggregate|collisions with closed schemas; brain_claims read-only), src/mcp/brain/lifecycle-tools.ts (tombstone|supersede|temporal-replace|tip|curator, reach-gated), src/cli/brain/verbs/truth.ts, claims.ts, lifecycle.ts (CLI truth ingest already accepts --ts; CLI ops are a superset of MCP ops).
- Pinned tests: tests/core/brain/truth/conflicts.test.ts (windowless byte-identical, silent succession), tests/mcp/brain-truth.test.ts (events is a count), tests/core/search/relational-fanout.test.ts (depth-2 pins), tests/core/architecture/visibility-surface-census.test.ts (exported /brain/truth/ and claim-graph surfaces), tests/mcp/agent-scope-matrix.test.ts (tools and recipes as equalities).

Conventions:
- Deterministic, provider-free core paths; append-only events with derived folds; fail-closed parsing with schema-version discipline; optional fields serialize by conditional spread so unset means byte-identical.
- Refuse-before-write on cooperative paths; receipts and Brain/log are testimony, read and reported but never rewritten; every write answers at the caller's reach (an unreadable target is refused as missing); every ranked output carries reasons; new config flags follow parseBool(envOrConfig(...)) with named defaults; one merged feature PR per CHANGELOG version.

Hard constraints:
- Byte-identical behavior when the new features are off; windowless truth-ledger behavior is test-pinned.
- Conflicts keep resolution ask_user and are never auto-resolved; succession stays silent, non-ask_user evolution.
- Visibility and reach rules apply to every new read or write path; any new MCP tool or operation joins the agent-scope-matrix equality in docs/architecture.md, and new exports join the visibility-surface census.
- No new external dependencies; no hardcoded natural-language phrases; English everywhere; SOLID, KISS, DRY.

# Required output format

Produce exactly 3 distinct architectural variants. Each variant must answer, explicitly, the load-bearing design questions the premise-verification recons surfaced:

1. Where succession surfaces: a separate state channel or a new conflict kind.
2. Which time governs a claim pair: the validity-versus-assertion precedence rule, and whether an expired window suppresses contestation.
3. What defaults a claim's window: explicit input, source-record resolution, and whether a resolved window is frozen or a live reference.
4. What state a corrected record ends in: tombstone (hidden) or validity-close (serveable in its window), and by what rule.
5. Where agent-stated claims land: truth-ledger events, intake relations, or both with a bridge.
6. Claim-chain recall now or deferred, and against which edges.
7. The windowed-slots response shape: an additive field beside the count-preserving events or a dedicated operation, and what the windowed response carries.
8. Multi-hop width caps: seed, per-node and total budgets, hub definition without prose inspection, and how direct-hit precedence is made real.
9. Where the serve-with-correction invariant lives and what happens when the correction is unresolved or out of reach.

For each variant:

### Variant N: <short name>
- **Approach**: 2-4 sentences describing the variant, followed by short labeled answers to the load-bearing questions.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-4 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
