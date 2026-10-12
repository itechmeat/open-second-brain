You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a release wave of four related kanban cards that must compose into ONE pull request on branch feat/recall-quality-wave of Open Second Brain. Brainstorm how the four verified residues below compose into a single coherent delivery (lane structure, cross-lane contracts, integration order). The recon node already verified every anchor below against the live tree and corrected or refuted the card premises; the "residue" line in each card is the corrected, agreed scope.

## Card t_6b943fc7 (priority 2): Iterative multi-round retrieval with a caller-executed decider step

Source: EverMind-AI/EverOS v1.3.1.

What upstream ships: an optional multi-round retrieval mode where each round fuses keyword + semantic candidates with RRF, then a decider step selects core evidence, identifies remaining gaps, and issues follow-up sub-queries until a bounded final context is returned. To respect the deterministic-first rule, the decider is not an LLM call inside the search algorithm: Open Second Brain should emit a needs-llm-step envelope the caller executes (mirroring planExtractSignals in src/core/brain/extract-signals.ts), with the commit phase validating the decider's selected-evidence/follow-up-query output before the next round.

Validator verdict (premise_partly_false, refuted as stated): "One fused pass" is not what ships. A self-correcting second pass already runs: exactly one of two mutually exclusive retries fires per query - a zero-candidate pool gets a broadened OR retry, a partially-covered pool gets a targeted retry on the specifically uncovered rare terms - both deterministic and LLM-free (src/core/search/pipeline/second-pass.ts:1-7, dispatch :68-71, broadened :81-110, targeted :122-174; gate src/core/search/search.ts:435-438). That is the card's round two, with a coverage-derived gap signal instead of a model decider. The shadow-only advisor already computes the stop condition the loop needs: a marginal-value stop derived from the density curve plus observed p95 latency (src/core/brain/retrieval-plan.ts:195-224). The genuine delta: more than two rounds, follow-up SUB-QUERIES rather than term-level retries, and a decider that selects core evidence. The decider must be a needs-llm-step envelope the caller executes with a validating commit phase, exactly as planExtractSignals does (src/core/brain/extract-signals.ts:443-490, commitExtractedSignals :578-597), because the kernel never calls a model. Build it as an iterative mode over the existing second-pass lane and the advisor's stop, not as a new subsystem; keep the invariant that with the mode off, ranking and pool stay byte-identical.

Residue: a bounded N-round loop generalizing the single-fire second pass (round driver at the search.ts:435-456 seam), deterministic k-group sub-query generation generalizing planTargetedRetry (src/core/search/coverage.ts:208), a caller-executed decider envelope with validating commit, a composed stop condition (round cap + composite deadline + coverage completeness + adapted marginal-value stop), a default-off config knob, per-round outcome observability, and a caller-facing plan/commit round-trip that does not disturb the cached single-read brain_search response in its default shape.

## Card t_2c2a883c (priority 3): Coverage-first thread/entity recall with adaptive topic budget and typed evidence selection

Source: yantrikos/yantrikdb v0.17.0.

What upstream ships: recall_thread (coverage-first retrieval over conversation/entity threads: retrieve wide, then compress, every record carrying a canonical source turn), resolve_thread_topics (adaptive topic budget, floor 12 / cap 16), select_thread_evidence (relevance-ranked selection under a budget, presented chronologically, recomputable diagnostics, typed infeasibility error instead of silent truncation).

Validator verdict (premise_partly_false, two premises refuted): a conversation-thread recall lane already exists - import, search, describe and expand over session turns, stitching across compaction boundaries via a lineage ledger (src/core/brain/session-recall.ts:19-30, summary nodes over turn groups :531-580), surfaced as brain_session_grep / brain_session_describe / brain_session_expand (src/mcp/brain/recall-tools.ts:1507/:1557/:1570). And source-turn provenance already persists as source_turn_ids on continuity records (src/core/brain/session-checkpoint.ts:163), so no canonical-turn stamp needs inventing. Today's scoring is one line - kind weight plus occurrence count (hitFor, session-recall.ts:706-737) - top-k, no coverage or diversity notion.

Residue: coverage-first retrieve-wide-then-compress over the lineage-scoped record set (sessionRecallRecords :582-605), an adaptive topic budget, relevance-ranked evidence selection re-emitted chronologically (collectRawRecords :739-751, compareRecords :851-855, applyCharBudget in src/core/brain/recall-budget.ts:127), a typed infeasibility error when the budget cannot hold the floor-weighted selection, and entity-thread wiring: resolving a mined entity key to its session_entity_mention rows (src/core/brain/continuity/types.ts:99) to seed coverage. Constraint: the MCP tool census is pinned at 115 (tests/core/install/tool-ceiling.test.ts:348), so this ships as a new operation on brain_session_grep plus CLI parity, never a new tool.

## Card t_107a3249 (priority 3): Ranked channel-aware context surfacing and a recorded-session replay harness

Source: yoloshii/ClawMem commit 2668f37.

What upstream ships: a single channel-aware ordering key that ranks candidate memory context instead of a binary retrieve/skip decision, admission that honestly abstains, a rerank lane gated by measured eval, and a replay-eval harness that judges surfacing decisions against recorded sessions.

Validator verdict (premise_partly_false, two of three asks struck as already shipped): honest abstention ships as a recorded recall decision with an explicit abstain action (src/core/brain/recall-adequacy.ts:33, RECALL_ADEQUACY_ACTIONS; src/core/brain/recall-inject.ts abstain decision variant :340-357), and rerank influence is already gated by a measured eval (src/core/search/rerank-eval-gate.ts:91-129, operator-facing recommendation). What remains: the surfacing gate really is binary (SurfacingGateDecision {retrieve, reason}, src/core/search/surfacing-gate.ts:15-18, evaluateSurfacingGate :82-98) and there is no replay-eval harness for surfacing decisions (src/core/bench/phases.ts drives fixture questions, not recorded sessions; src/core/bench/failure-modes.ts:27-36 states the gate fails open by design and its false-fire rate is ~1 by construction, so the bench deliberately does not score it). One hard constraint: gate_telemetry deliberately stores only a SHA-256 prompt prefix and length, never the raw prompt (src/core/brain/gate-telemetry.ts:1-20), so a replay must source prompts from session_turn records or a session-shaped fixture. The hook channel already admits on a measured absolute key: matchQuality (RecallResultSet.idfWeightedCoverage, produced at src/core/search/pipeline/outcome.ts:126) against RECALL_INJECT_CONFIDENCE_FLOOR 0.35 (src/core/brain/recall-inject.ts:66, admission ladder decideOverRetrieval :481-574). The channel vocabulary exists: RECALL_CHANNEL = {mcp, cli, hook} at src/core/brain/recall-telemetry.ts:27-48.

Residue: one shared graded key/tier shape (admission axis = channel-calibrated absolute match quality; order axis = the existing fused composite, which is per-pool normalized and must never be a threshold basis), consumed by both brain_recall_gate (src/mcp/search-tools.ts:1293) and decideRecallInject, with the pure prompt-structural gate kept as the structural pre-tier and its binary decision projected for compatibility; plus a recorded-session replay bench suite scoring know_to_ask / false_fire the way decideRecallInject is already scored, closing the "not scoreable" caveat, with bookkeeping riding the existing opt-in gated telemetry thunk.

## Card t_607d429d (priority 1): LongMemEval public benchmark lane

Source: garrytan/gbrain v0.48.4.0.

What upstream ships: a LongMemEval public-benchmark suite scoring the official strict recall_all@5, excluding abstention questions, joining gold session ids without intermediate sanitization, pinning reranker/autocut/search knobs per run, caching embeddings so arms compare byte-identical vectors, and optionally LLM-judging answer accuracy with the official prompts.

Validator verdict (premise_confirmed after an earlier correction): the public-benchmark lane pattern exists - the LoCoMo adapter src/core/bench/locomo.ts (199 lines, converts a LoCoMo dataset into the existing BenchFixture, deterministic, network-free, judge opt-in) exposed as `o2b brain bench memory --fixture <path> --suite locomo` (src/cli/brain/verbs/bench.ts:23, suite guard :40-42, dispatch :52-53), tested in tests/core/bench/locomo.test.ts. No LongMemEval support exists. Two binding constraints: the bench pipeline is network-free BY DESIGN (disposable vault inside the run dir, keyword-only search pinned semantic-off at src/core/bench/phases.ts:124-126, judge optional and external via bench_judge_cmd / src/core/bench/judge.ts:29), so a suite needing real embeddings must declare a per-suite capability rather than quietly change what the pipeline does, and the embedding spend falls under the explicit apply-gate rule (src/core/search/indexer.ts:142-145, vector-backfill.ts, embedding-spend.ts). And resume is keyed on run id plus fixture hash (src/core/bench/run-store.ts:72-79), so per-run knob pinning must enter that hash or a resumed run silently mixes two configurations. Trap: the LoCoMo adapter sets expected_text on retrieval questions but evaluateQuestion never reads it for retrieval categories (phases.ts:343-367), so the LongMemEval converter must not rely on expected_text.

Residue: a suite adapter src/core/bench/longmemeval.ts (parser with named errors, converter to BenchFixture, abstention exclusion with recorded count, direct gold-session-id join), a committed tiny sample fixture with the full dataset operator-supplied, a per-suite capability declaration on the bench options ({embeddings: boolean}), run-identity knob pinning (SearchConfigOverrides-shaped, folded into the checkpoint hash), a strict recall_all@5 named metric family in the report, an embedding cache so arms compare byte-identical vectors, and judge glue reusing bench_judge_cmd with an extended stdin payload (question/answer/gold).

# Project context

Open Second Brain: a memory layer for AI agents living in an Obsidian vault, read and written through MCP servers, lifecycle hooks and the o2b CLI. TypeScript on Bun. Deterministic core: no model runs inside the algorithms; model work rides needs-llm-step envelopes the caller executes.

Recent commits:

259e4b70 fix(snapshot): decode readdir buffer entries as UTF-8 so exclusions match (v1.81.1) (#243)
28ea378b chore(deps): bump the github-actions group with 2 updates (#245)
745c4a95 chore(deps): bump the bun-minor-and-patch group with 4 updates (#246)
323fb9e4 feat: answer trust - verified quotes, claim provenance and durable source evidence (v1.81.0) (#249)
a00fa3f5 feat: recall quality - mined sessions, honest admission and a store that filters in SQL (v1.80.0) (#248)
3f029241 feat: write-side trust - identity, permission and review for every agent write (v1.79.0) (#247)
66f9d847 feat: credential custody under a passphrase and a verifiable trust surface (v1.78.0) (#244)
3afb94a5 feat: a truth layer you can correct and time-travel (v1.77.0) (#242)
e907c692 ci: balance windows test shards by measured duration (#241)
f3d7185e fix: keep generated cluster digests out of community detection (#240)
646a49df feat: freshen the search index on read, rewriting only changed chunks (v1.76.0) (#239)
78f924b9 feat: deliver context to subagent turns, hygiene digest at turn end and tiered context shrink (v1.75.0) (#238)
542d214b fix(opencode): support both plugin APIs (v1.74.1) (#190)
0cbb60b8 feat: near-duplicate defense across the fact lifecycle (v1.74.0) (#237)

Related files:

- Search pipeline: src/core/search/search.ts, src/core/search/pipeline/second-pass.ts, src/core/search/pipeline/iterative-recall.ts (proposed), src/core/search/coverage.ts, src/core/search/types.ts, src/core/search/index.ts, src/core/search/pipeline/outcome.ts, src/core/search/pipeline/attribution.ts, src/core/search/pipeline/cache-slot.ts
- Envelope spine: src/core/brain/llm-step.ts, src/core/brain/extract-signals.ts, src/core/brain/retrieval-plan.ts
- Session recall: src/core/brain/session-recall.ts, src/core/brain/recall-budget.ts, src/core/brain/continuity/types.ts, src/core/brain/link-graph/session-mining.ts, src/core/brain/entities/registry.ts
- Surfacing: src/core/search/surfacing-gate.ts, src/mcp/search-tools.ts, src/core/brain/gate-telemetry.ts, src/core/brain/recall-inject.ts, src/core/brain/recall-telemetry.ts
- Bench: src/core/bench/phases.ts, src/core/bench/types.ts, src/core/bench/fixture.ts, src/core/bench/run-store.ts, src/core/bench/judge.ts, src/core/bench/locomo.ts, src/core/bench/failure-modes.ts, src/cli/brain/verbs/bench.ts
- MCP and CLI surfaces: src/mcp/brain/recall-tools.ts, src/cli/brain/verbs/session-recall.ts, src/cli/command-manifest.ts, src/cli/brain/help-text.ts

Conventions:

- Mode-off byte-identical invariant: every opt-in feature must leave outcomes byte-identical when off (precedents: relational-arm doc contract, rerank-off reader tail, the twoPassEnabled kill-switch test at tests/core/search/two-pass.test.ts:66-70).
- Deterministic-first: the kernel never calls a model; caller-executed needs-llm-step envelopes with validating commit phases (brain_extract_signals one-tool-two-phases precedent: plan phase when the payload is absent, commit phase when present, phase discriminator in the response).
- Nothing writes silently, nothing degrades silently: typed explicit errors naming the shortfall; no silent fallbacks (v1.52.0 direction).
- Budget primitives are reused, never forked (applyCharBudget, text-budget).
- Telemetry and bookkeeping stay off the latency-critical path: opt-in, lazily-evaluated gated thunks.
- Bench harness is network-free by design: disposable vault, keyword-only default, external optional judge; deviations are declared per-suite capabilities with embedding spend under the explicit apply gate.
- Parallel implementation lanes over disjoint file sets with pinned cross-lane contracts; shared registration files are append-only with each lane appending only its own entries; census and ratchet tests arbitrate.

Constraints:

- No new MCP tools: the tool census is pinned at 115 by an equality test (tests/core/install/tool-ceiling.test.ts:348). Every new recall surface rides an existing tool's operations, an existing CLI verb, or the bench suite registry.
- Defaults off: every opt-in mode ships disabled with a byte-identical-off regression proof.
- Typed explicit errors; no silent fallbacks or silent truncation.
- No new external dependencies.
- Existing public API default shapes do not change (brain_search default response byte-identical; brain_session_grep without the new operation byte-identical; locomo bench reports byte-identical).
- This is one pull request: the four residues compose into one release with per-lane atomic commits on the shared feature branch.

# Required output format

Produce exactly 3 distinct architectural variants for how the four residues compose into the single wave pull request (lane structure, cross-lane contracts, integration order). For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
