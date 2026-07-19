You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a release wave of eleven kanban tasks for Open Second Brain (OSB). The wave theme is source pipeline integrity and operator tooling: everything about getting sources into the vault correctly (scoped, gated, reconciled, deterministically pre-extracted, provenance-carrying), querying what is there, and keeping the vault healthy. Brainstorm the wave architecture as a whole: where shared abstractions live, what the dependency spine is, and how the units cluster. Do not judge whether individual units are worth doing; all eleven ship.

## Unit 1 (t_9654de80) - Nested .gitignore in hygiene file scan
Teach the hygiene file scan to honor `.gitignore` (and a project-local ignore file) with git-like nested composition: an ignore file deeper in the tree applies to its own subtree, and a nearer `!` re-include wins, replacing the single hardcoded skip-dir list. Code today: `src/core/hygiene/scan-repo.ts:75` uses a static skip-dir array; no gitignore parsing exists anywhere in the scan. The nearer-`!`-wins composition rule is the deliberate part; compose with `.git/info/exclude` semantics.

## Unit 2 (t_e82101a5) - `--src-subpath` and `--exclude` on source ingest
Add `--src-subpath` and `--exclude` to source ingest/sync so a monorepo can be ingested from one subdirectory, excluding sibling packages. `--exclude` should compose with ignore handling rather than duplicate it. Incremental sync exists via `o2b watch` (command-manifest.ts:259); no subdir scoping anywhere today.

## Unit 3 (t_ed856388) - Honor the schema `extractable` flag during page discovery
OSB already stores an `extractable` flag on packs via schema mutation (schema-mutate.ts:54 `set_extractable`, handler :260-263) but nothing consults it during page discovery/extraction. Add discovery-time enforcement: pages in non-extractable packs are skipped up front. Behavior-only wiring of an existing flag.

## Unit 4 (t_d067a153) - Reconcile dispatched-vs-ingested documents in batch ingest
Large-folder ingest plans bounded batches (`planBatches`, src/core/brain/ingest/batch-plan.ts:125) and folds per-source completion into a checkpoint (`recordCompleted`, checkpoint.ts:169) and content manifest. Nothing compares the plan's dispatched set against the files that actually came back. Add a `reconcilePlan(planId)` helper next to the checkpoint, invoked after a batch/plan drains, warning on silently-lost sources.

## Unit 5 (t_ef786747) - Local no-LLM code-structure extractor as a pre-ingest pass
A deterministic, no-LLM code-structure extractor that parses code sources into classes/functions/imports/inheritance edges as JSON, run as a pre-pass before agent-driven ingest to cut extraction tokens and produce deterministic entity/edge seeds. Must stay pure-stdlib for the default path. Scope it as a lightweight fallback pre-pass, complementing (not replacing) the detect-only codegraph partner integration (src/core/partner/codegraph.ts). Ingest consumer: src/core/brain/ingest/ingest.ts.

## Unit 6 (t_a3d1adb0) - Inline `[Source: <name>, YYYY-MM-DD]` prose citations into the temporal timeline
Parse citation markers embedded in note prose and promote each into the temporal timeline as a dated provenance entry. Timeline builds only from structured logs today (temporal/build-index.ts walks Brain/log/*.jsonl); provenance lives in provenance/provenance.ts + portability/origins.ts. New parser feeding existing temporal + provenance sinks; handle malformed dates and dedup against already-logged source events. NOTE the OSB constraint: no hardcoded natural-language word lists; the `[Source: ...]` marker is a structural syntax, which is acceptable, but date parsing must be structural.

## Unit 7 (t_618f7211) - Configurable FTS tokenizer language/diacritic rules
The FTS tokenizer is hardcoded (`tokenize='unicode61 remove_diacritics 2'` in search/schema.ts). Expose tokenizer/language (stemming + diacritic rules) as configuration so non-English vaults index on language-appropriate rules, leaving the default intact. CJK is handled out-of-band via a separate fts_content column + trigram prefilter; the config must compose with that path, not replace it. Reindex command already exists (`o2b search reindex`). Config must not require language word lists.

## Unit 8 (t_9bee8f0b) - Graph-degree cardinality predicates in the search/filter DSL
Add a cardinality predicate to the user-facing search/filter DSL filtering notes by the COUNT of link-graph relations: backlinks/outlinks `= 0` (orphans/leaves), `>= N` (hubs). Degree is already computed internally (link-graph/graph-index.ts:33 `degree` map, moc-audit backlink buckets); the DSL (src/core/search/property-filter.ts) matches only frontmatter key/values today. CLI surface in src/cli/search.ts.

## Unit 9 (t_bd6cc4cb) - `o2b brain doctor --repair`
Add a guarded repair mode to the existing read-only doctor (doctor.ts) that performs targeted fixes for the issue classes doctor already detects (orphaned references, WAL gaps). Opt-in, dry-run/preview by default, `--strict` read-only behavior preserved as default.

## Unit 10 (t_9f9c5466) - Unified operator status snapshot
One readable CLI health snapshot combining counts, stale + orphaned pages, review queue depth, active profile, and state-file health, with an actionable next-command hint printed on each problem line. The raw signals are already computed across brain_health, brain_doctor, brain_hygiene, brain_stale_scan, brain_review_candidates, brain_brief operator view; ship the consolidation + per-line hints only.

## Unit 11 (t_2ed754d1) - Early-closed stdout pipe as clean exit in CLIs
Make `o2b` and `vault-log` treat an early-closed stdout pipe (EPIPE after `| head`) as a normal exit 0 instead of a nonzero failure. Entry points are bash wrappers exec-ing `bun run src/cli/main.ts`; main exits via `main(...).then((code) => process.exit(code))` (src/cli/main.ts:933). No EPIPE/SIGPIPE handling exists. Small and self-contained.

# Project context

Open Second Brain: TypeScript on Bun, CLI (`o2b`) + MCP server over an Obsidian-compatible Markdown vault, bun:sqlite + sqlite-vec hybrid search. Deterministic kernel: the core never calls an LLM; agent-driven steps live outside the kernel.

Recent commits:
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
61e93d24 fix(config): derive vault store reference from a keyed installation secret (#140)
9a649dd6 feat: memory write-path integrity and store safety wave (v1.32.0) (#139)
f2a037eb feat: today operator surface - dashboard, open loops, marker write-back (v1.31.0) (#138)
13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1) (#137)
fd5661f9 feat: governance visibility - vitals scorecard + batch-inflation lint (v1.30.0) (#136)
a99b0e71 feat(brain): add o2b brain vitals scorecard + batch-concept-inflation lint (#135)
70fb36e1 feat: operability, safety & first-run experience (v1.29.0) (#134)
ac26a675 feat: retrieval & ranking quality (v1.28.0) (#133)
5cd52e70 fix(hermes): resolve o2b when memory provider PATH is tiny (v1.27.1) (#131)

Related files:
src/core/hygiene/scan-repo.ts, src/core/brain/ingest/{ingest.ts,batch-plan.ts,checkpoint.ts,content-manifest.ts}, src/core/schema/schema-mutate.ts, src/core/temporal/build-index.ts, src/core/provenance/provenance.ts, src/core/search/{schema.ts,property-filter.ts,fts.ts}, src/core/brain/link-graph/graph-index.ts, src/cli/main.ts, src/cli/search.ts, src/cli/brain/verbs/*, src/mcp/*, src/core/partner/codegraph.ts, scripts/o2b, scripts/vault-log

Conventions:
- Each unit lands as one atomic conventional feature commit with its tests; infrastructure-only commits are discouraged.
- Post-v1.30.1 direction: shared choke points, one-directional layering, no import cycles; shared logic gets exactly one home.
- SOLID, KISS, DRY; constants extracted; typed errors surfaced explicitly; no silent do-nothing fallbacks; no stubs.
- Language-agnostic: no built-in natural-language word lists anywhere; structural signals and config-supplied vocabularies only.
- New CLI verbs get an MCP counterpart when they are agent-relevant; MCP tool descriptions are capped and parity-tested.
- Byte-identical opt-out: with new features unconfigured, existing outputs must not change.

Constraints:
- Bun runtime, bun:sqlite; no new external dependencies for the default path (pure stdlib for parsing/extraction).
- Do not change existing public APIs; new params optional.
- The deterministic kernel calls no LLM.
- The wave ships as one PR / one release (v1.34.0); a partially completed wave must still ship coherently as a prefix.

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
