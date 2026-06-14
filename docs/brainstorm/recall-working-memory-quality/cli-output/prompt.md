You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Open Second Brain "Recall & Working-Memory Quality Suite" - one release bundling FOUR small, additive, related units on top of the mature search/recall subsystem. Each unit must be deterministic, language-agnostic (NO hardcoded natural-language word lists in any language), provider-agnostic (the kernel never calls an LLM), and byte-identical when its flag is off. The brainstorm should propose how the FOUR units share structure (config, gating, persistence, read-side weighting) so they compose cleanly rather than four disconnected patches.

Unit 1 - Selectable recall profiles. Today `search()` consumes a fixed `ResolvedSearchConfig`. Add named presets `fast | balanced | thorough` that are tuples of EXISTING knobs (candidate-pool multiplier, traversal depth, query expansion on/off, fusion mode) - the same axes the self-tuning grid in `tuning.ts` already ranges over. Profile selected by a CLI flag and an MCP tool field; default selection reproduces today's behaviour bit-for-bit. Explicitly OUT OF SCOPE: pluggable external recall-source registry (deferred as architectural).

Unit 2 - Language-agnostic co-occurrence auto-relate. Today links are suggested only by `findUnlinkedMentions` (raw title/alias string match). Add a statistical pass: canonical entities that repeatedly co-occur in the same notes get a co-occurrence relationship edge, scored by a document-frequency / PMI-style structural metric (NO NL keyword lists). Runs in dream/maintenance, emits derived link SUGGESTIONS, never mutates note bodies.

Unit 3 - Usage-driven working-memory decay. Continuity records (`src/core/brain/continuity/store.ts`) are append-only, immutable JSONL deduped by a content `recordId()`; they cannot be mutated in place. Add a usage counter + recency signal sourced from existing `recall_telemetry` continuity records, and a deterministic decay-score computed READ-SIDE that down-weights stale decisions/commitments during recall while keeping frequently-referenced items prominent. Never deletes; only weights.

Unit 4 - File-context recall. Give an agent "I have worked on this file before" awareness: a new CLI verb + MCP tool that, given a file path, queries the EXISTING search index (building on `src/core/search/session-focus.ts` path-prefix biasing) for prior work touching that path. No LLM. A file-size gate (like the mem0 source's >=1500 bytes) skips trivial files.

# Project context

Open Second Brain - TypeScript, Bun runtime, SQLite (bun:sqlite, FTS5 + sqlite-vec), MCP stdio server, `o2b` CLI, Obsidian/Markdown vault. Provider-agnostic kernel.

Recent releases (each a themed multi-unit "Suite" shipped as one squash commit):
- v1.9.0 Brain Portability & Interop
- v1.8.0 Indexer Durability & Resilience
- v1.7.0 Knowledge Provenance
- v1.6.0 Vault Integrity & Trust
- v1.5.0 Search & Recall Quality (explainable scores, trust, threshold, reinforce, eval)

Related files:
- src/core/search/types.ts (ResolvedSearchConfig at :543 - vault, weights, fusionMode, rrfK, recall, resumeReindex, shutdownGraceMs)
- src/core/search/search.ts (search(); already applies opt-in self-tuning grid via applyTunedParameters)
- src/core/search/tuning.ts (FIXED-grid deterministic self-tuning: candidate-pool {3,4,5}, depth {1,2}, learned-weights on/off, expansion on/off; persists Brain/search/tuning.json with dataset hash; re-validated on read, fail-soft to defaults)
- src/core/search/session-focus.ts (query/path-prefix biasing with TTL; path safety via vault-relative normalisation)
- src/core/search/benchmark.ts (runRecallBenchmark - MRR/hit@k objective)
- src/core/brain/continuity/store.ts + types.ts (append-only JSONL, CONTINUITY_SCHEMA_VERSION o2b.continuity.v1, recordId dedupe, kinds incl. recall_telemetry, context_receipt, pre_compact_extract)
- src/core/brain/link-graph/unlinked-mentions.ts (findUnlinkedMentions - string match), concept-cluster.ts, communities.ts, graph-index.ts
- src/core/brain/entities/canonical.ts (canonical entity registry)
- src/core/search/recall-telemetry.ts, recall-budget.ts

Conventions:
- Every feature is gated by a config field / env var; OFF reproduces prior behaviour byte-for-byte (asserted by tests).
- Deterministic and replayable: persisted artifacts carry a version + hash; delete-to-reset; re-validate on read; fail-soft to defaults.
- Errors are typed and loud (e.g. SearchError, BankImportError); NO misleading silent fallbacks that pretend success.
- Language-agnostic: gating/classification/ranking derive from structural signals, frontmatter fields, document-frequency/IDF - never hardcoded word lists in any language.

Constraints:
- Do NOT change existing public API signatures or default behaviour.
- No new external/heavy dependencies.
- No `as`/`as unknown as` cast crutches; build values with the correct type from the start.
- The four units share one release and ideally one or two shared primitives (e.g. a profile/knob resolver, a read-side weighting helper, a usage-signal reader) rather than four isolated implementations.

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
