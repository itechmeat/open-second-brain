You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Cycle 20261020: a seven-feature release cycle for Open Second Brain, planned as four to five parallel implementation lanes on disjoint file sets. The features (kanban cards in parentheses):

1. Cross-topic rule promotion in the dream pass (t_642bc2b8). The dream pass's only new-preference writer iterates per-topic buckets one key at a time; the lexical merge layer is same-topic by construction. Add a deterministic cross-bucket detector and promote recurring confirmed preferences into one evidence-linked unconfirmed rule, with a promotion budget and a new Brain/ ledger.
2. Shared model-aware context-window resolver (t_a567cc12). Every context-pack and compact budget is a caller-declared number or a two-bucket model-hint guess (substring matching on "mini"/"pro"/etc.). Build one shared resolver deriving the window from the model id (exact table, structural 1M-suffix rule), an operator config key and an environment variable, and switch the context-pack, preset-suggest, pre-compress and anticipatory-cache defaults to it.
3. Preregistered judge eval gates which models may auto-resolve (t_4e1681b3). The decision-model threshold profiles' `tuned` state is a hand edit to source. Build frozen content-hashed eval specs with seeded takes and a dev/counted split, cache graded verdicts, and write a machine-side tuning mark that the auto-resolve gate consults so a measured profile may run enforce.
4. Measured index-behind count (t_e4438152). The search answer says the index is stale but not by how much. Add a live stat-only walk reusing the incremental fastpath that counts the documents the next incremental run would add, update or delete, surfaced in the index-stale degradation detail and the status freshen block.
5. Bench-run integrity guards (t_d7ce8baf). The Memory Observability Suite harness can leave orphan run dirs on refusal, silently reset an existing run, publish a report from a tampered or truncated trace, and write artifacts non-atomically. Add named preflight refusals before run state is created and trace validation before a report publishes, with strict checkpoints and atomic writes.
6. Machine-readable JSON Schema for the query/search language (t_50c81d5c). The search input schema exists as drifting copies (MCP schema object, CLI flag parser, TypeScript SearchOptions type, plus a vendored Python projection). Unify behind one descriptor module, derive the served schema byte-identically, commit a versioned artifact under schemas/brain/, and add export/check verbs with doc-example tests.
7. Ambiguous-wikilink disambiguation must honor vault scope (t_fd842db0). Bridge acceptance counts basename twins over a census that ignores the operator's vault ignore/include rules, so a twin under node_modules forces a full-path wikilink spelling. Filter the census through the shared scope rules, matching the lint walkers' precedent.

Structure question for the consultant: how should this cycle be organized into a serial substrate (if any) and parallel lanes so that file ownership is disjoint, the architecture censuses stay green on every commit, and the frozen public surfaces are not broken?

# Project context

Open Second Brain, TypeScript on the Bun runtime; local-first memory layer with an MCP server, a CLI (o2b), and a deterministic "dream" maintenance pass.

Recent commits:
9e579820 feat: note-change truth maintenance for links, index freshness and entity anchoring (#268)
f7c1c88c feat: entity merge repair, write destinations, cross-agent catch-up and OKF v0.2 (v1.88.0) (#267)
f6d9f95f feat: guarded host writes, walkable list results, a converse decision route and a snoozable trigger queue (v1.87.0) (#266)
9a19fcc8 chore(deps): bump hashgraph-online/ai-plugin-scanner-action (#262)
69bec9d1 chore(deps-dev): bump the bun-minor-and-patch group with 3 updates (#263)
63410769 chore(apb): run the owner dev quality cycle in osb-pr-prepare (#265)
b183b6c3 fix: one holder per hook-state scope through a stale-lock takeover (v1.86.2) (#261)
fd8a0c8d fix: v1.86.0 review repairs and embedding preservation across schema upgrades (v1.86.1) (#259)
e0d11656 feat: session-mining economy - mining tombstones, a shadow trust-gate mode and a live-counts console (v1.86.0) (#258)
948a0403 feat: storage lifecycle for long-lived vaults (v1.85.0) (#257)
ef974e0d fix: comma-separated and legacy scopes no longer abort the dream pass, plus three test-isolation fixes (v1.84.1) (#254)
14a99584 feat: recall lane concurrency, overlapped_ms accounting, a caller-selectable packing policy and standing-instruction facets (v1.84.0) (#252)
e239d323 feat: shipped-seam wiring - a per-session recall pool cap, usage-ordered skill offers, seeded bench sampling and OpenCode V2 configs (v1.83.0) (#251)
44a8ccaf feat: recall quality - an iterative recall loop, coverage-first session recall and a measured surfacing key (v1.82.0) (#250)
323fb9e4 feat: answer trust - verified quotes, claim provenance and durable source evidence (v1.81.0) (#249)
a00fa3f5 feat: recall quality - mined sessions, honest admission and a store that filters in SQL (v1.80.0) (#248)
3f029241 feat: write-side trust - identity, permission and review for every agent write (v1.79.0) (#247)

Related files:
- Dream pass: src/core/brain/dream.ts, dream-plan.ts, dream-plan-topics.ts, dream-apply.ts, dream-summary.ts, dream-types.ts, dream-report.ts, rollup-ladder.ts, preference-txn.ts
- Context budgets: src/core/brain/context-presets.ts, src/mcp/brain/pack-tools.ts, src/cli/brain/verbs/context-pack.ts, context-presets.ts, src/core/brain/anticipatory-cache.ts
- Decision model: src/core/decision-model/questions.ts, config.ts, record.ts, diagnostics.ts, reports/, src/cli/decision-model.ts
- Search: src/core/search/indexer.ts, search.ts, freshen.ts, pipeline/outcome.ts, retrieval-trail.ts, src/cli/search/verbs/status.ts
- Bench: src/core/bench/phases.ts, run-store.ts, failure-modes.ts, judge.ts, src/cli/brain/verbs/bench.ts
- Query language: src/mcp/search-tools.ts, src/cli/search/verbs/query.ts, src/core/search/types.ts, schemas/brain/, plugins/hermes/_schemas.py
- Links and scope: src/core/brain/link-graph/bridge-discovery.ts, src/core/vault-scope/, src/core/brain/page-dedup.ts
- Shared registries: src/core/state/surfaces.ts, src/core/brain/policy/validate.ts, src/core/brain/config-template.ts, src/core/config.ts, src/cli/command-manifest.ts

Conventions:
- Architecture census tests (write-site, state-surface, append-shard, import-cycles, visibility-surface) fail the build on unregistered new surfaces; registration must be live wherever a lane adds state.
- New config keys require a config-template entry or a listed omission, enforced by a ratchet test.
- The served MCP tools/list is a frozen public surface (v1.0.0 freeze); schema changes must be byte-identical or the vendored Hermes Python projection must be regenerated by hand in the same change.
- Conventional commits; formatter (oxfmt) and linter (oxlint) must pass before every commit; version bump and CHANGELOG entry land inside the PR via the pr-prepare phase.
- A failed measurement is reported as absent (null), never as zero.

Constraints:
- The kernel never calls an LLM: dream planning, detection and promotion must be deterministic; embeddings may nominate but never gate the kernel path.
- Server-derived facts only: every new number a surface reports must be measured or derived, not assumed; a failed measurement is absent, never zero.
- Egress and architecture censuses must stay green: no new unregistered write sites, state surfaces, or append shards; no new external dependencies.
- The cycle is planned as 4-5 parallel lanes on disjoint file sets; identify every shared file (config validation, state surfaces, command manifest, docs) and decide who owns it or which serial substrate pass resolves it first.
- Existing pinned test suites and published report fields (fixture_hash, served schema bytes) must remain stable unless a feature explicitly changes them.

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
