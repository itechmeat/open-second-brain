You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release wave for Open Second Brain: "retrieval quality and context delivery". Nine kanban tasks ship together as one PR, in two sub-themes.

A. Retrieval quality: better answers from the existing store
1. t_09b7ccea (p2) Typed-edge relational retrieval with federation hardening. Add a deterministic relational-query parser detecting relationship queries mapping to typed edges, a relationalFanout typed-edge fan-out generalizing traversal to a seed array aggregating to ranked nodes (bounded multi-hop, depth 2), wired as a fourth RRF arm in hybrid search with scope-aware seed resolution. Federation hardening: RRF/dedup key carries source identity via a shared key helper, query cache scopes by canonical source-set key. Anchors: src/core/search/ (hybrid RRF, no relational arm today), src/core/brain/link-graph/ (typed edges exist), src/core/search/store.ts. Parser must be structural (edge-type vocabulary from schema packs, subset validation), never natural-language word lists.
2. t_7b96f242 (p2) Reliable summary-search router: a deterministic routing layer that chooses summary search for summary-shaped questions (existing source-summary artifacts), paired with hardened retrieval skill instructions so agents consistently invoke the intended search surface. Verify first whether existing query planning (src/core/search/query-plan.ts buildQueryPlan intent detection) already routes to source summaries under another name; if partially present, harden rather than duplicate.
3. t_267f3b4c (p2) Per-store reranker fit check: a diagnostic (host: brain_doctor and/or search diagnostics) that samples real queries on the current vault, measures reranker score correlation against the base retrieval signal, and flags out-of-domain rerankers and specifically inverted scores (negative correlation) with a concrete recommendation (disable or swap). Complements the shipped bundled offline reranker + eval gate (t_9f95ebb6, done): the gate is pass/fail regression, the fit check explains the cause. Anchor: src/core/search/rerank/cross-encoder.ts, brain_doctor.
4. t_3ffb021c (p2) Shadow-only retrieval_plan advisor: a deterministic read-only tool that, per question, bundles a source/query plan, token-budget allocation, graph-expansion advice, observed reliability and p95 latency, and marginal-value stop conditions - emitted as advice that cannot mutate live source/weight policy. Compose EXISTING signals: src/core/search/query-plan.ts:113 buildQueryPlan (intent + weight profile), src/core/brain/context-pack.ts + context-density.ts (impact-per-token allocation), src/core/brain/token-impact.ts + context-pack-outcome.ts (calibrated reliability ledger), mcp_route_latency p50/p95/p99 (src/mcp/brain/recall-tools.ts:913). Marginal-value stop derives from the density-allocation curve plus observed p95 latency.

B. Context delivery and state hygiene: the right context reaches the agent, stale state does not
5. t_2d4f34d7 (p2) Tiered context injection with cadence-controlled navmap: split injected agent context into a small kernel every turn and a larger navigation/map layer injected only by cadence or trigger. Deterministic and observable: record when the nav tier was included, why, and how many chars it added. Anchors: hooks/active-inject.ts (SessionStart preferences digest), hooks/recall-inject.ts (UserPromptSubmit bounded recall brief, shipped v1.35.0 with caps 4 notes/900 chars), hooks/lib/context-events.ts.
6. t_36b0fd8d (p2) Strict PreToolUse hook (opt-in via env, e.g. OPEN_SECOND_BRAIN_HOOK_STRICT) that blocks the first raw vault-file read of a session (Claude Code permissionDecision: "deny") and redirects the agent to query the brain/search index, then downgrades to a soft nudge; a short-lived "recently oriented" stamp - refreshed by any brain query/search - suppresses the block, so it fires at most once per session and always fails open. Hard block is Claude-Code-only; other harnesses stay nudge-only. Anchors: hooks/hooks.json (no PreToolUse today), hooks/lib session state, redirect target is the existing brain search path.
7. t_b0c9d0a3 (p2) Overwrite-only exact-state lane for operational state, excluded from semantic layers, plus a retrieval-time staleness barrier. Today Brain/pinned.md is overwrite-only but silently indexed into FTS/vector (src/core/search/walker.ts indexes all .md; DEFAULT_VAULT_IGNORE_PATHS omits it), so a stale "current" value can resurface through recall. Add a structured overwrite-only lane keyed by aspect, exclude the lane from search index / graph / rollups, and add a retrieval-time barrier that drops superseded exact-state rows from all sources. Anchors: src/core/brain/pinned.ts, src/core/vault-scope/defaults.ts:25, src/core/search/walker.ts:106.
8. t_37c05a34 (p2) Composite memory namespace with per-namespace dedup and search scoping. OSB isolates only on a single flat owner: (agent-name) axis; dedup/search are global. Layer a composite scope (at minimum session/project axes on top of owner) so identical text in two scopes is not wrongly collapsed by dedup, and search can opt into scope filters. Single-vault design: full 4-tuple rewrite is out of scope; the valuable slice is per-scope dedup + optional search scoping over existing owner/sessionId axes. Requires care with existing global dedup state (migration or additive keying). Anchors: src/core/graph/agent-scope.ts, src/core/brain/owner-scoped-facts.ts, src/core/brain/session-recall.ts.
9. t_0f3f2422 (p3) Codegraph partnering spans the whole workspace: checkCodegraph() at openclaw/index.js:1781 discovers projects via findCodeProjects() but uses only projects[0]; thread project_path per query so one codegraph server answers across all discovered projects, aggregate health-check output over all projects, degrade gracefully (current single-project behavior) when the partnered codegraph does not support project_path. Anchor: openclaw/index.js:1706,1754,1781,1787,2097, skills/codegraph-partner/SKILL.md.

The architectural question: shared seams and ordering. Candidate seams: (1) a scope-key vocabulary (owner/session/project axes) shared by namespace dedup (8) and search scope filters (8) and possibly the relational arm's scope-aware seed resolution (1); (2) a shared retrieval-diagnostics read-only composition layer used by both the reranker fit check (3) and the retrieval_plan advisor (4), both strictly shadow/advisory; (3) hook-side session-state ("recently oriented" stamp for 6, nav-tier cadence state for 5) living in the existing hooks/lib session state rather than a new store; (4) the exact-state lane's index-exclusion mechanics (7) versus the scope filters (8) - same walker/indexer touch points; (5) RRF key/dedup helper (1) as the one place source identity enters ranking. Which seams deserve extraction, which stay conventions, and what ordering minimizes rework.

# Project context

Open Second Brain (o2b): TypeScript on Bun, CLI plus MCP server over an Obsidian-compatible Markdown vault, bun:sqlite with sqlite-vec. Deterministic kernel: the algorithm calls no LLM (LLM-facing steps are emitted as needs-llm-step envelopes for the agent, never called inline). openclaw/index.js is the JS integration layer for the OpenClaw harness.
Recent commits:
842d690f feat: knowledge intake and consolidation (v1.36.0) (#145)
95dc8577 feat: trusted recall and memory write surface (v1.35.0) (#144)
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (not just inline arrays) (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
Conventions:
- TDD, one atomic conventional commit per task on one feature branch, all nine in one PR and one CHANGELOG version (target v1.37.0).
- MCP registry guards: tool descriptions <= 300 chars, property descriptions <= 160 chars; current surface 107 tools.
- Byte-identical opt-out: every new surface leaves behavior exactly unchanged when its flag/param/env is omitted.
- Errors surface explicitly; no do-nothing fallbacks; no stubs.
- Language-agnostic: no built-in natural-language word lists anywhere; classification by structural signals, config vocabularies, provenance.
- No import cycles (CI-guarded), no new external dependencies.
Constraints:
- Existing public API semantics unchanged; new MCP params optional.
- Shadow/advisory surfaces (retrieval_plan, fit check) MUST NOT mutate live ranking or weight policy.
- The strict hook tier is opt-in and fail-open; default installs stay soft-nudge only.
- Search ranking changes (relational arm) ship behind a flag/mode with byte-identical default-off behavior.
- Exact-state lane exclusion must not drop any EXISTING non-lane content from the index (regression-tested).
- openclaw/index.js change degrades gracefully with older codegraph versions.

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
