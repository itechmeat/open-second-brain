You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a bounded multi-task PR for Open Second Brain. It combines the parent runtime schema-pack foundation with only the foundation slice of the child schema-pack mutation surface.

## Task 1: t_dc01c9f7 - [upstream:gbrain] Runtime-extensible schema packs with custom page types and take kinds

**Source**: https://github.com/garrytan/gbrain/commit/5a2bdd2
**Repo**: garrytan/gbrain (18439 stars)
**Commit**: 5a2bdd2 (2026-05-22T20:00:00Z) - PR #1248

### What

Schema packs: open PageType and TakeKind from closed unions to string types. Validation moves from compile-time exhaustiveness to runtime checks against the active schema pack. Schema packs declare custom page types at runtime (paper, researcher, therapy-session, apple-note, tweet-bundle). The engine accepts arbitrary user-declared types without schema migrations. 13 as PageType and 3 as TakeKind casts widen to as string, with runtime narrowing at SQL row boundaries.

### Why useful for Open Second Brain

Open Second Brain preferences use a fixed status enum (confirmed/quarantine/retired) and signal types are closed. A schema pack system would let users define custom preference categories, signal types, and log event kinds without modifying Open Second Brain source code. This would support domain-specific brain setups (for example, a research vault with paper/researcher types, or a project vault with milestone/decision types) while keeping the core stable.

### Status in Open Second Brain

- Verdict: not_in_osb_useful
- Codegraph hints: Open Second Brain preference types in src/core/brain/preference.ts, status in src/core/brain/status.ts, signal processing in src/core/brain/signal.ts. All use closed enums/unions. No runtime type declaration system or schema pack registry exists.

### Notes

The migration path from closed to open types is non-trivial. gbrain's approach of widening casts and moving validation to runtime is one pattern. Open Second Brain could start with a schema-pack registry file that declares allowed custom types, then validate against it at the MCP tool boundary.

Validator comments:

- parent of t_cbf4967f.
- priority 2.
- foundational change - opening closed PageType/TakeKind unions to runtime validation needs an ADR.

## Task 2: t_cbf4967f - [upstream:gbrain] Schema pack mutation primitives + 9 MCP ops + 14 CLI verbs + schema-author skill

**Source**: https://github.com/garrytan/gbrain/commit/3c1cc8a4d665d1c2557e3381a3213332d54a5ff8
**Repo**: garrytan/gbrain (18439 stars)
**Commit**: 3c1cc8a (2026-05-23T23:46:01Z)

### What

Schema Cathedral v3: production-grade schema pack authoring system with 11 mutation primitives (add_type, remove_type, update_type, add_alias, remove_alias, add_prefix, remove_prefix, add_link_type, remove_link_type, set_extractable, set_expert_routing), each wrapped in withMutation for atomic .tmp+fsync+rename operations with pre-write lint validation gates. Pack-lock provides atomic file-level locking with stale detection (TTL + liveness probe). 9 new MCP operations exposed for remote OAuth agents: get_active_schema_pack, list_schema_packs, schema_stats, schema_lint, schema_graph, schema_explain_type, schema_review_orphans (read-scope), schema_apply_mutations (admin-scope, batched), reload_schema_pack. 14 new CLI verbs for schema management. Stats command provides per-type counts, coverage scores, and dead-prefix detection. Sync command does chunked UPDATE (1000-row batches) for backfilling page.type. Schema-author skill with 36 trigger phrases routes agents to evolve schema packs via a 7-phase workflow (brain -> assess -> propose -> apply -> sync -> verify -> commit). Mutate-audit logs ISO-week JSONL with privacy redaction.

### Why useful for Open Second Brain

Open Second Brain preferences use fixed closed enums (confirmed/quarantine/retired status, fixed signal types). A schema pack system would let users define custom preference categories, signal types, and event kinds without modifying Open Second Brain source. The MCP operations would allow remote agents to evolve the brain schema over HTTPS, enabling multi-tenant federation. The mutation primitives with atomic guarantees and audit logging provide a production-safe path for schema evolution. The schema-author skill gives agents a discoverable workflow for taxonomy management.

### Status in Open Second Brain

- Verdict: not_in_osb_useful
- Codegraph hints: src/core/brain/preference.ts:92 (status method, closed enum); src/core/brain/dream.ts:191 (dream function); src/mcp/server.ts:56 (MCP tools registration); src/mcp/tools.ts:57 (ToolDefinition). No schema pack registry, no runtime type declaration system, no mutation primitives, no atomic pack-lock, no schema-author skill. Open Second Brain types are all compile-time closed unions.

### Notes

Related to existing task t_dc01c9f7 (runtime-extensible schema packs - opening PageType/TakeKind from closed unions). Schema Cathedral v3 goes much further: adds the full mutation + MCP + CLI + skill surface. If t_dc01c9f7 is implemented first, this task becomes a natural extension. The pack-lock atomic acquire pattern (openSync wx, TTL refresh, stale-steal) is reusable for any concurrent-write scenario in Open Second Brain.

Validator comments:

- child of t_dc01c9f7.
- priority 2.
- lowered because the 11-primitive + 9 MCP-op + 14 CLI-verb + skill surface is blocked by the parent and far exceeds one week; it cannot precede the foundation.

# Project context

Project: Open Second Brain
Language/runtime: TypeScript on Bun. Source of truth is plain Markdown under Brain/ in an Obsidian-compatible vault. The core Brain algorithms are deterministic; no LLM belongs in `dream` or core validation paths.

Recent commits:

- 14d1ee1 feat: brain model semantics foundation - typed preference relations, memory labels, dry-run backfill (#51)
- 3a5d5c3 feat: agent capability CLI integration - runtime MCP capabilities, inherited JSON, completions (#50)
- a085bfa feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
- 73e4a28 feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)
- bd49cd5 feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)
- cbbe18f feat: typed graph semantics - typed relations, visibility scoping, MCP landscape (#46)
- 5fa7eb0 feat: MCP context economy - preview budget, artifact fetch, recall hint (#45)
- 2bd3f48 v0.17.0 - Brain Lifecycle Review Suite (#44)
- 9b87838 v0.16.0 - Agent boundary control surfaces (#43)
- feca6a7 v0.15.0 - Cross-agent query foundation (#41)

Related files:

- src/core/brain/types.ts - closed `as const` vocabularies for signal sign/source type, preference status, confidence, memory layer, retired reason, apply result, and log event kind; `BrainConfig` type for `_brain.yaml`.
- src/core/brain/preference.ts - preference/retired parser and writer; validates status/folder invariants; recently added optional preference semantics fields.
- src/core/brain/signal.ts - signal writer/parser; validates signal sign/source type; keeps legacy signal frontmatter lean and byte-stable.
- src/core/brain/status.ts - status snapshot counts preference statuses, including unknown values, without mutating.
- src/core/brain/policy.ts - tiny indent-aware `_brain.yaml` parser/validator; no external YAML dependency; unknown top-level keys warn, sub-block keys warn; defaults are frozen.
- src/core/graph/relation-vocab.ts - recent example of a single data-driven validation boundary with default vocabulary and frontmatter classification.
- src/cli/brain/verbs/\*, src/cli/brain/help-text.ts, src/cli/command-manifest.ts - established CLI verb registration and read-only JSON patterns.
- tests/core/brain/_.test.ts and tests/cli/_ - test style: Bun tests, temp vault fixtures, byte-identical/back-compat checks.

Conventions:

- Additive, opt-in features should keep default installs byte-identical where practical.
- Prefer one shared validation boundary over duplicated token lists at call sites.
- Keep Markdown/YAML source-of-truth human-readable; do not add hidden state outside the vault for Brain semantics.
- Use structured APIs and existing helpers (`parseFrontmatter`, `formatFrontmatter`, `writeFrontmatterAtomic`, `validateSlug`, `brainDirs`) instead of ad hoc string parsing.
- Mutating Brain commands take snapshots and have dry-run/guardrails where they touch more than one file; this PR should avoid the full mutation surface unless clearly justified.
- CLI read verbs should support `--json` with stable structured output.
- Public docs use full project name, not abbreviations.
- Version bump happens before GitHub push per operator override.

Constraints:

- Do not implement the full Schema Cathedral surface in this PR. The bounded goal is a foundation that unblocks future mutation primitives, not 11 mutations + 9 MCP ops + 14 CLI verbs + schema-author skill.
- Do not break existing closed-core behavior: existing statuses/signals/log kinds must continue to validate and parse as before.
- Do not introduce a heavy YAML parser unless the design makes an unusually strong case; the project currently uses a tiny `_brain.yaml` parser.
- Do not add a second graph or a parallel hidden schema store. Prefer frontmatter/config-native declarations.
- Do not add LLM-dependent schema authoring to the core.
- Favor read-only/introspection/lint surfaces first; defer mutating schema-pack application unless the variant can keep the scope small and safe.
- Tests must prove default behavior and legacy fixtures are not widened accidentally.

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
