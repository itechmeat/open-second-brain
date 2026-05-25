You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one Open Second Brain (OSB) release that bundles eight related vault-metadata + maintenance features in a single PR. Decide the architectural envelope, shared building blocks, and ordering. Do NOT design each feature in detail - that comes later. Focus on how the eight slot together so the diff stays coherent, test surfaces stay sane, and future maintenance features plug in without re-cutting the schema.

The eight features (all approved from the kanban triage, priorities P4 then P3):

1. **t_5de021f1 (P4) Per-page confidence + lifecycle frontmatter.** Add `confidence:` (high/medium/low) and `lifecycle:` (draft/stable/verified/deprecated/archived/disputed) frontmatter to vault pages produced by OSB (preferences, signals, evidence). Annotate citations from stale or disputed pages so readers see verification status. OSB already has `_confidence` on preferences (BRAIN_CONFIDENCE enum). The work generalises that pattern to other page kinds and introduces a lifecycle axis OSB does not yet have.

2. **t_3d157e9b (P3) Page importance tier frontmatter.** Add `tier:` (core/supporting/peripheral) to vault pages. The search ranker (src/core/search/ranker.ts) consumes the new field as a relevance signal. New page-producing call sites set the tier on creation; existing pages get `supporting` by default.

3. **t_e0d65daa (P3) Page-level deduplication.** Detect near-duplicate vault pages (not just signal-level content hashes), canonicalise the best one, patch wikilinks across the vault, and record `merged_into:` on the secondary. OSB already has `dedup-hash.ts` for signal-level SHA256 dedup but no page identity resolution.

4. **t_55bd528a (P3) Self-healing vault lint.** `o2b brain lint --consolidate` performs proactive fixes (broken wikilinks, orphan reconciliation, lifecycle demotion of stale peripheral pages, tag-alias normalisation). Today `brain_doctor` is read-only. Must support dry-run diff.

5. **t_68e65e77 (P3) Vault token footprint monitoring.** Report per-category vault size in tokens with a warn threshold (default 200k). Surfaced via a new CLI verb and a section in `brain_digest`. Uses the same tokenizer as brain_search for consistency.

6. **t_31c16ba2 (P3) Bounded-token context retrieval.** New `brain_context_pack(max_tokens, query?)` MCP tool plus CLI verb that returns the highest-signal vault slice under a strict token budget, ordered by importance tier then recency. Pairs with feature 2.

7. **t_2e7e3b8d (P3) Unicode/CJK dedup normalisation.** Dedup keys today call `normalize("NFC")`. Adopt NFKC + `casefold()`-style lowercasing so CJK, fullwidth/halfwidth variants, and case-only variants merge correctly. Touches `dedup-hash.ts` and any other dedup key construction site.

8. **t_8dd35d10 (P3) Ranked maintenance action list.** Replace vague "Recommendation" output with a prioritised "What to do next" list scored by impact (orphan count × tier weight, staleness × evidence count, dedup candidates, token-footprint excess). Surfaces in `brain_digest` and `brain_doctor`.

# Project context

Project: Open Second Brain (OSB) - https://github.com/itechmeat/open-second-brain
Runtime: Bun + TypeScript, Markdown vault on disk, optional SQLite-backed search index.
Recent commits (newest first):

```
9d9636b feat: index fastpath, PEM/JWT redaction, vault connection health (v0.10.14) (#29)
7d81f0b feat: codegraph-partner skill + o2b doctor check (v0.10.13) (#28)
0462b91 feat: v0.10.12 operational friction reduction (#27)
9d8af95 Merge pull request #26 from itechmeat/feature/v0.10.11-multi-runtime-install
852c9b5 v0.10.11: address CodeRabbit review
f819f32 v0.10.11: Multi-runtime install orchestrator + Most-applied in digest
88bce1f Merge pull request #25 from itechmeat/feature/v0.10.10-pull-channels
3e297a5 v0.10.10: address CodeRabbit review
0484a23 v0.10.10: Pull channels — brain_context tool, Most-applied (30d), o2b brain note, semantic hint
```

Relevant files (codegraph-discovered):

- `src/core/brain/preference.ts` - preference writer, currently emits `_confidence`, `_status`, `_evidenced_by`, etc. Group C derived fields use `_` prefix.
- `src/core/brain/dedup-hash.ts` - signal-level NFC normalisation, SHA256 hash. ~100 LOC.
- `src/core/brain/inline-scan.ts` - inline scan loop, walks vault, builds dedup index.
- `src/core/brain/sessions/import.ts` - session importer, reuses dedup index.
- `src/core/brain/dream.ts` - dream pass, owns preference status transitions.
- `src/core/brain/digest.ts` - `collectDigestData` produces digest JSON/Markdown.
- `src/core/brain/policy.ts` - `loadBrainConfig` reads `Brain/_brain.yaml`.
- `src/core/brain/backlinks.ts` - backlink index for digest connection-health (added v0.10.14).
- `src/core/brain/explorer.ts` - vault graph for explorer tool (`ExplorerNode` has `backlink_count`).
- `src/core/search/ranker.ts` - `RankerInputs`, `RankerOptions`, `rankResults`. Keyword + semantic + tag boosts.
- `src/core/types.ts` - `FrontmatterMap = Record<string, FrontmatterValue>` (string | number | boolean | ReadonlyArray<string>).
- `src/core/vault-scope/index.ts` - vault scope policy (ignore_paths, walker rules).
- `src/mcp/brain-tools.ts` - MCP tools: `brain_doctor`, `brain_digest`, `brain_context`, `brain_feedback`, etc.
- `src/mcp/server.ts` - MCP server context().
- `src/cli/brain/verbs/` - 24 verb files: `doctor`, `digest`, `dream`, `feedback`, `query`, `scan-inline`, `migrate-frontmatter`, etc. Each verb is one file.

Project conventions (from README, CHANGELOG top, design-doc patterns):

- One PR = one CHANGELOG version. Multi-feature releases bundle under a single version (v0.10.12 did 4 features, v0.10.14 did 3).
- Each release ships a design-doc under `docs/superpowers/specs/<date>-<theme>-design.md` or an implementation plan under `docs/plans/<date>-<theme>-impl.md`. The brainstorm under `docs/brainstorm/<slug>/` is the upstream artifact for those.
- New MCP tools land in `src/mcp/brain-tools.ts` (or `pay-memory-tools.ts`); new CLI verbs land in `src/cli/brain/verbs/<verb>.ts` and register through `src/cli/brain/verbs/index.ts`.
- New `Brain/` schema fields go through a `migrate-frontmatter` step so old pages get the new fields lazily and idempotently. Group C derived fields use `_` prefix; user-editable fields stay unprefixed.
- Tests use Bun's built-in runner (`bun test`), live under `tests/`, mirror the source tree by area (`tests/core/brain/`, `tests/cli/brain/`, `tests/mcp/`).
- Per-tool tests required for every new MCP tool and CLI verb.
- AI authorship markers (e.g. "🤖 Generated with Claude Code") forbidden in public artifacts.
- Use full product name "Open Second Brain" in CHANGELOG / README / release notes; "OSB" only in private chat.
- All numeric priorities follow Hermes convention (`DEFAULT 0`, `ORDER BY priority DESC`).
- Default lifecycle for newly-introduced fields is the most permissive option so existing pages remain valid without migration.

Constraints:

- Do NOT change Hermes core or any vendored runtime; everything lives inside OSB.
- Do NOT introduce new external dependencies if a stdlib / Bun-native option exists (NFKC + casefold-equivalent are in Bun/Node `String.prototype.normalize` and `String.prototype.toLowerCase`; token counter can stay heuristic, no `tiktoken` etc.).
- Backwards-compatible frontmatter: old pages without the new fields must keep parsing; default values resolve at read-time.
- Token-budget routines must be deterministic and side-effect free (no LLM calls).
- Dry-run is mandatory for `lint --consolidate`. Write paths require explicit `--apply`.
- Public MCP tool surface evolves additively; never break existing tool names or shapes.

# Required output format

Produce exactly 3 distinct architectural variants for how to STRUCTURE the bundle (shared modules, ordering, naming conventions, test surfaces). The variants must differ in how they group the eight features into shared building blocks, not in which features ship.

For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Shared building blocks**: list the new core modules / types this variant introduces and what feature(s) each one underlies.
- **Implementation order**: ordered list of the 8 features showing the dependency order this variant enforces.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
