You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Multi-task PR selected by the operator: Brain Model Semantics foundation.

## Task 1: t_965212be - [upstream:contextlattice] Typed memory edges with deterministic backfill

**Source**: https://github.com/sheawinkler/ContextLattice/releases/tag/v3.3.29
**Repo**: sheawinkler/contextlattice (61 stars)
**Released**: v3.3.29 (2026-05-29T08:32:54Z)

### What

ContextLattice v3.3.29 introduced first-class typed memory edges in the public gateway. The system supports deterministic retroactive edge backfill with dry-run default, a high-confidence write mode for same-session and exact-topic relationships, and an agent CLI wrapper (scripts/agent/memory-edge-backfill) for automated backfill operations.

### Why useful for OSB

OSB preferences are linked via topic slugs and evidenced_by arrays, but there is no explicit typed edge system between preferences. A typed memory edge system would allow OSB to express richer relationships between preferences (e.g., "pref-a depends-on pref-b", "pref-x refines pref-y", "pref-c contradicts pref-d") beyond the current contradiction-detection in the dream pass. The deterministic backfill pattern with dry-run default is also applicable to OSB's existing merge and scan operations.

### Status in OSB

- Verdict: not_in_osb_useful
- Codegraph hints: src/core/brain/dream.ts:1462 (computeConfidence - contradiction detection, no typed edges); src/core/brain/merge.ts:83 (mergePreferences - pairwise merge, no edge graph); src/core/brain/preference.ts (preference structure - no edge/relationship fields). OSB has contradiction detection and pairwise merge but no explicit typed relationship graph between preferences.

### Latest validator comment

- sanity: clean
- cluster: leave: shares the preference-model substrate with t_f373499d (branching) and t_09dc93c1 (layering), but each is a distinct layer of the model with no umbrella parent task; not linked.
- priority: set to 2. A typed relationship graph between preferences (depends-on/refines/contradicts) is a new data-model concept that needs an ADR before build.

## Task 2: t_f373499d - [upstream:Memoria] Selective branch pick support for memory operations

**Source**: https://github.com/matrixorigin/Memoria/releases/tag/v0.4.0
**Repo**: matrixorigin/Memoria (259 stars)
**Released**: v0.4.0 (2026-05-11T10:45:56Z)

### What

Memoria v0.4.0 added explicit branch access for memory operations and selective branch pick support. Users can create branches of the memory state and selectively pick individual memory entries from branches, enabling experimentation with different memory configurations without affecting the main vault. The feature was introduced across commits #193 (selective branch pick) and #203 (explicit branch access).

### Why useful for OSB

OSB preferences use a flat vault structure with mergePreferences for pairwise deduplication (src/core/brain/merge.ts:83). A branching system would allow users to: (a) experiment with preference changes in isolated branches, (b) selectively merge individual preferences between branches rather than the current all-or-nothing merge, (c) maintain alternative configurations (e.g., a "research" branch vs "production" branch of the brain) without duplicating the entire vault. The selective pick operation is finer-grained than OSB's current merge (which keeps one pref and drops the other).

### Status in OSB

- Verdict: not_in_osb_useful
- Codegraph hints: src/core/brain/merge.ts:83 (mergePreferences - keep/drop pairwise, no branching); src/core/fs-atomic.ts:26 (atomicWriteFileSync - atomic writes, no branch isolation); src/core/brain/preference.ts (preference structure - no branch metadata). OSB has no branching concept - the vault is a single linear state.

### Latest validator comment

- sanity: clean
- cluster: leave: shares the preference-model substrate with t_965212be (typed edges) and t_09dc93c1 (layering), distinct layer, no umbrella parent; not linked.
- priority: set to 2. Git-like branching (branch metadata + copy-on-write + cherry-pick + diff) is a large architectural feature that needs an ADR.

## Task 3: t_09dc93c1 - [upstream:TencentDB-Agent-Memory] Multi-layered memory architecture with L0-L3 hierarchy

**Source**: https://github.com/Tencent/TencentDB-Agent-Memory/releases/tag/v1.0.0-beta.1
**Repo**: Tencent/TencentDB-Agent-Memory (3891 stars)
**Released**: v1.0.0-beta.1 (2026-05-29T10:27:04Z)

### What

TencentDB Agent Memory v1.0.0-beta.1 evolved from an OpenClaw plugin into a standalone memory service with a four-layer memory architecture: L0 Conversation (add/query/search/delete), L1 Atomic (update/query/search/delete), L2 Scenario (ls/read/write/rm), and L3 Core/Persona (read/write). Each layer has a distinct lifecycle and granularity. The v2 REST API exposes all layers under /v2/ prefix with Bearer token authentication. Standalone local mode runs with zero external dependencies (SQLite + BM25), and official TypeScript and Python SDKs are provided.

### Why useful for OSB

OSB's brain uses a flat preference structure (confirmed/quarantine/retired statuses) with topic-based organization. A layered memory architecture would allow OSB to: (a) separate transient conversation-level context (L0) from durable atomic facts (L1), scenario-specific knowledge (L2), and core persona/identity (L3), (b) apply different retention and confidence policies per layer, (c) scope search relevance by layer (e.g., prefer L3 for identity questions, L0 for recent context). The standalone service model with REST API could also complement OSB's MCP surface for non-MCP agent integrations.

### Status in OSB

- Verdict: not_in_osb_useful
- Codegraph hints: src/core/brain/preference.ts (single preference model, no layer concept); src/core/brain/dream.ts (dream pass processes all preferences uniformly, no layer-specific logic); src/core/brain/sessions/ (session adapters - no layer tagging). OSB has no memory layering - all preferences share the same schema and lifecycle.

### Latest validator comment

- sanity: clean
- cluster: leave: shares the preference-model substrate with t_965212be (typed edges) and t_f373499d (branching), distinct layer, no umbrella parent; not linked.
- priority: set to 2. A four-layer L0-L3 memory architecture with per-layer lifecycle/retention is a fundamental restructure of the flat preference model and needs an ADR.

# Project context

Project: Open Second Brain, TypeScript on Bun. Obsidian-native memory layer. Plain Markdown files under Brain/ are the source of truth. Deterministic core: no LLM in the dream algorithm. Current package version on main: 0.23.0.

Recent commits:

- 3a5d5c3 feat: agent capability CLI integration - runtime MCP capabilities, inherited JSON, completions (#50)
- a085bfa feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
- 73e4a28 feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)
- bd49cd5 feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)
- cbbe18f feat: typed graph semantics - typed relations, visibility scoping, MCP landscape (#46)
- 5fa7eb0 feat: MCP context economy - preview budget, artifact fetch, recall hint (#45)
- 2bd3f48 v0.17.0 - Brain Lifecycle Review Suite: intent review, retention, monthly synthesis, complexity warning (#44)
- 9b87838 v0.16.0 - Agent boundary control surfaces: pinned context, Markdown links, MCP output contracts (#43)
- 66980b2 ci: drop bun version floor, track latest only (#42)
- feca6a7 v0.15.0 - Cross-agent query foundation: source-agent provenance retrieval and comparison (#41)
- ffde4ac chore(release): v0.14.1 (#40)
- bc97b38 refactor: add validation toolchain and normalize project formatting (#39)

Related files and existing local design:

- src/core/graph/relation-vocab.ts already defines the typed graph vocabulary for arbitrary vault pages: related, extends, contradicts, superseded_by. It is the single validation boundary and must be reused rather than duplicated.
- src/core/brain/backlinks.ts already records relation?: string on BacklinkRef when preference/retired frontmatter uses known relation fields.
- src/core/brain/explorer.ts currently emits ExplorerEdge.kind as only supersedes | wikilink and does not expose relation metadata.
- src/core/brain/preference.ts is the preference parser/writer. WritePreferenceInput has supersedes and aliases but no general relationship/layer/branch metadata.
- src/core/brain/merge.ts is pairwise keep/drop merge. It writes superseded_by on retired artifacts and does not implement branch isolation.
- src/core/brain/types.ts keeps closed status enums and broad typed frontmatter models. Recent suites added audit, lifecycle, tier, confidence, and temporal fields additively.
- tests/core/brain/backlinks-relation.test.ts already proves frontmatter relation fields tag backlinks.
- tests/core/brain/explorer.test.ts covers explorer graph nodes/edges and is the likely cheapest surface for typed relation projection tests.
- docs/brainstorm/typed-graph-semantics/design.md explicitly says preference-domain supersession exists and typed relations are generalized through the shared vocabulary. It rejected a new parallel graph subsystem.
- README emphasizes plain Markdown ownership, deterministic dream, one vault across agents, and operator-controlled pin/merge/reject/rollback.
- CHANGELOG v0.23.0 is current; v0.19.0 introduced typed graph semantics; v0.21.0 added audit/morning brief; v0.22.0 added vault portability.
- No Brain/active.md exists in this repository checkout, so active Brain preferences were unavailable during context gathering.

Constraints:

- Follow SOLID, KISS, DRY.
- Prefer additive, deterministic, schema-compatible changes.
- Do not add a parallel graph subsystem if existing relation-vocab/backlink/explorer surfaces can carry the foundation.
- Do not implement full copy-on-write memory branches or L0-L3 lifecycle rewrite in one PR.
- Do not add LLM calls to dream or any deterministic core path.
- Keep default install byte-identical where possible; new fields should be absent unless explicitly supplied or derived.
- Public artifacts should use "Open Second Brain", not abbreviations.
- Tests are Bun tests. Project validation uses bun run typecheck, bun run lint, bun run test, bun run sync-version:check.

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
