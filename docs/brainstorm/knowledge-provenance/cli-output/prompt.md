You are brainstorming architectural variants for the following work. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a cohesive "Knowledge Provenance Suite" for Open Second Brain (a Markdown/Obsidian-first agent memory system; TypeScript/Bun; an MCP server plus an `o2b` CLI over a vault of notes, preferences, signals, entities). The suite bundles SIX related features that share one theme: every piece of knowledge in the brain should know its origin (which source, which premises, which owner, and whether it was stated by the operator or inferred by a machine), and the operator should be able to steer what surfaces into context. The six features:

1. SOURCE-INGEST PIPELINE (core). Drop a source document (plain text / Markdown / HTML / a URL's text) into the brain. The system extracts candidate entities and concepts, creates/updates entity and concept pages, writes a per-source summary page with a "Sources" section that links back to the raw artifact, and stamps a "connections to existing notes" list at capture time. One ingest touches many pages and cross-references them. (No OCR, no binary/PDF-image, no audio — text-bearing sources only.)

2. PARAMETERIZED RESEARCH PIPELINE. Pull N sources, run a configurable synthesis step, and write a dated structured report into the vault as a first-class page, where each finding cites which source flagged it. The report becomes a recall input itself.

3. DERIVED-FACT SYNTHESIS WITH PREMISE PROVENANCE. During the brain's "dream" maintenance pass (or an equivalent on-demand step), produce NEW second-order facts ("because A and B, therefore C") where every derived fact links back to its premise preferences/signals and carries a provenance label: stated (operator-asserted) vs deduced vs inferred. Recall must trust stated rules above machine-inferred ones. The plumbing (premise links, the provenance label surviving a read round-trip, recall ordering by provenance, byte-identical output when the feature is off) must be deterministic and testable; the actual reasoning text is model-generated and is NOT asserted in tests.

4. OWNER-SCOPED CANONICAL FACTS. A fact/preference may declare an owner token. When several agents write to one brain, each owner gets its own truth space; ownerless facts are shared. A query may pass an owner scope; absent scope means no filtering (byte-identical to today). Reuse the existing v1.6 owner-visibility model.

5. MODEL-BASED ENTITY EXTRACTION ON WRITE (NER). Discover entities in free note text (not only from explicit wikilinks) and feed them into the entity registry. MUST be done WITHOUT bundling any ML model or new heavy dependency: extraction is performed by the model the calling agent already has. Must be opt-in and must not block every note save synchronously. The prompt/contract must be language-agnostic (no hardcoded entity-type word lists in any language).

6. OPERATOR-EDITABLE STANDING-QUERY ATTENTION LAYER. An operator-editable declarative document defines queries that always fire when context is assembled and inject matching items (open loops, recent learnings) into the assembled context. A declarative "attention flows" mechanism ALREADY EXISTS (`src/core/brain/attention-flows.ts`, files under `Brain/attention/flows/`, injected into the context pack); the feature should extend that mechanism, not build a parallel one.

# Project context

Open Second Brain. TypeScript + Bun runtime. SQLite (FTS5 + sqlite-vec) search index. MCP server (72 tools) + `o2b` CLI + Obsidian/Markdown vault. Just shipped v1.6.0 ("Vault Integrity & Trust Suite": untrusted-source containment, NFC path identity, file-watcher sync, O(1) graph side-index, agent-scope recall isolation). Target for this work: v1.7.0.

Recent commits (git log --oneline):
- 6e59a42 feat: Vault Integrity & Trust Suite (v1.6.0)
- e4df212 feat: Search & Recall Quality Suite - explainable scores, trust, threshold, reinforce, eval (v1.5.0)
- 0340560 feat: Continuity, Hygiene & Freshness Suite (v1.3.0)
- 8972f13 refactor: SOLID/DRY decomposition - domain modules, unified helpers, surface guards (v1.2.0)
- 6651228 refactor: language-agnostic fact extraction + README slim (v1.1.0)

THE SINGLE MOST IMPORTANT ARCHITECTURAL FACT: OSB is provider-agnostic by construction. The kernel NEVER calls an LLM. As the codebase states: "OSB never calls an LLM; the calling agent owns generation, OSB owns sequencing, validation, and the final atomic commit." There is no LLM client in the repo (only an embedding-provider HTTP client for search vectors). The existing `brain_write_session` kernel is the precedent for this boundary: the agent supplies generated content through an MCP tool, OSB sequences/validates/commits it atomically. Features 1, 2, 3, and 5 all involve model generation (entity extraction, summarization, derived reasoning) and therefore CANNOT call a model from inside OSB — they must place the generation on the agent side of an MCP/CLI boundary and keep only deterministic sequencing, validation, provenance-stamping, and atomic vault writes inside OSB.

Related files (verified insertion points):
- src/core/brain/dream.ts (the maintenance pass; phases close->reconcile->synthesize->heal->log; new "derive" phase would slot between synthesize and heal)
- src/core/brain/preference.ts, preference-txn.ts (WritePreferenceInput, writePreferenceTxn; where a provenance label + premise links + owner field attach)
- src/core/brain/types.ts (BrainPreference, BrainSignal, DreamRunSummary, BrainGuardrailConfig)
- src/core/brain/policy.ts (BRAIN_GUARDRAIL_DEFAULTS, resolveGuardrails, loadGuardrailsConfigSafe, the YAML known-keys validator — the exact opt-in-flag pattern to mirror for each new feature flag)
- src/core/graph/agent-scope.ts (pageOwner / normalizeAgentScope / isOwnerVisible — generic, reusable for the fact layer, shipped v1.6)
- src/core/brain/entities/registry.ts (upsertEntity, relateEntities — where extracted entities land)
- src/core/brain/link-graph/unlinked-mentions.ts (findUnlinkedMentions — term-driven, structural, on-demand only)
- src/core/brain/signal.ts, note.ts (writeSignal, appendBrainNote — vault write primitives)
- src/core/brain/sessions/import.ts (importSession — the canonical "ingest external thing -> brain records" blueprint, with dedup-hash idempotency)
- src/core/brain/attention-flows.ts (existing declarative standing-query mechanism to extend for feature 6)
- src/core/brain/context-pack.ts (packContext — context-assembly chokepoint)
- src/core/brain/write-session/ (the provider-agnostic agent-supplies-generation kernel precedent)

Conventions:
- Byte-identical-when-flags-off is a hard guarantee: a vault that enables no new feature must return identical results, ordering, and output shape. Every behavioural change is opt-in behind a guardrail flag in `_brain.yaml`, defaulting off/loose.
- Read-time-derive / never-store-derived-enrichment is a recurring pattern.
- Language-agnostic: no hardcoded natural-language word lists (greetings, stopwords, keywords, entity-type names) in any language. Use structural signals, explicit frontmatter fields, corpus frequency, or agent/LLM extraction.
- Provenance is represented with wikilinks and frontmatter tokens; sha256 content hashing is used for idempotency/dedup.
- SOLID / KISS / DRY. TDD: tests must fail first, then pass. Conventional commits, one atomic unit per commit.

Constraints:
- No new heavy/ML dependency may be bundled (this is a hard operator requirement). Generation is the agent's; OSB stays dependency-light.
- No misleading fallbacks: a feature that cannot run (e.g. no model available) must fail clean or no-op honestly, never fabricate.
- No `as` / `as unknown as T` TypeScript cast crutches; construct values with the correct type from the start.
- The suite must exploit three shared DRY primitives rather than duplicating them: (a) ONE entity/concept extraction-intake primitive shared by the ingest pipeline AND the on-write NER; (b) ONE provenance/citation primitive shared by ingest, research-report, and derived-facts; (c) the existing owner-visibility model shared by owner-scoped facts AND v1.6 search agent-scope.
- Keep the whole suite shippable as ONE pull request (roughly 50-70 files including tests), implemented one feature at a time via TDD on a single branch.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant, with explicit attention to WHERE the agent/OSB generation boundary sits and HOW the three shared DRY primitives are factored.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
