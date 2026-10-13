You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a release wave of four related kanban cards that must compose into ONE pull request on branch feat/wiring-shipped-seams of Open Second Brain. Brainstorm how the four verified residues below compose into a single coherent delivery (lane structure, cross-lane contracts, integration order). The recon node already verified every anchor below against the live tree (v1.82.0) and corrected or refuted the card premises; the "residue" line in each card is the corrected, agreed scope.

## Card t_bb6ce095 (priority 4): Per-session candidate-pool cap feeding the reranker

Source: garrytan/gbrain v0.60.199.0.

What upstream ships: an opt-in retrieval knob that widens the candidate pool fed to the reranker and caps it at one row per conversation session, so several chunks of one session can no longer occupy all reranker slots. Upstream measured +3.5 strict recall at 10 with the knob on and still shipped it off by default.

Recon verdict (premise corrected): the diversity rerank really is similarity-only MMR over the ranked pool (mmrRerank, src/core/search/mmr.ts:67; assembled at src/core/search/pipeline/assemble.ts:341), and no per-source cap exists anywhere on the reranker-facing pool. But candidate rows carry NO session identity (BrainSearchResult, src/core/search/search-result.ts:112-193; no session column in the schema), and the card's session-scope.ts citation is a naming trap - that module scopes the caller's current conversation. Source import sessions are recoverable per row only through frontmatter: `session_ref` on imported signal notes (src/core/brain/signal.ts:521-522), `session_id`/`scope` on handoff notes (src/core/brain/handoff.ts:143-152). The assemble stage already carries a frontmatter cache on AssemblyInput (assemble.ts:81, consumed at :205-209) with one-read-per-path semantics (readCachedFrontmatterEntry, src/core/search/result-filters.ts:60). Pool width lives in assemble.ts:211-257 (POOL_LIMIT_MULTIPLIER 3, POOL_MIN_WIDTH 30, widening disjunction over mmr/traversal/cross-encoder), the relevance floor at :330-338, MMR at :339-342, relevance rerank at :346-348, a backfill re-assemble at :357-393 whose wideCap can never exceed the already-widened rankLimit, and degradation notes at :404-430 with codes in src/core/search/retrieval-trail.ts:159-189. The exact config plumbing precedent is search_mmr_lambda: DEFAULTS (src/core/search/index.ts:276), envOrConfig parse (:1182-1186), validateResolvedConfig (:629), ResolvedRecallConfig.mmrLambda (src/core/search/types.ts:1542), per-query SearchOptions.mmrLambda (:919), cache fingerprint (src/core/search/pipeline/cache-slot.ts:279-300), per-query cache key (src/core/search/query-cache.ts:124), bench pin keys (BENCH_PIN_NESTED_KEYS.recall, src/cli/brain/verbs/bench.ts:176+), docs rows (docs/cli-reference.md:2388, docs/how-it-works.md:1234). Optional resolved fields use spread-omission so exact-shape assertions keep holding (index.ts:1175-1178).

Residue: an opt-in per-source-session cap on the reranker-facing candidate pool, grouped through the frontmatter the assemble stage already carries (session_ref first, session_id second, no identity passes uncapped, unreadable frontmatter passes uncapped), placed after the relevance floor and before the diversity rerank, widening the pool via the existing Math.max composition when active, counting drops under a new RETRIEVAL_DEGRADATION code, folded into the search config plumbing exactly like search_mmr_lambda, off by default with a byte-identical-off proof.

## Card t_5d1ec8a8 (priority 4): Rank offered skills by observed usage activity

Source: Tencent/TencentDB-Agent-Memory v2.0.2.

What upstream ships: the skill list is sorted by usage activity so frequently used skills surface first.

Recon verdict (premise clean): no usage signal reaches the offer ranking. rankSkillCandidates (src/core/surface/skill-attach.ts:119-143) scores descriptors with BM25, applies the discriminating-term floor as a filter ("The floor filters, it never reorders: ranking stays the scorer's", line 126), slices to limit; the module docblock pins "the same query and skill set always produce the same block" (lines 4-8). It is the single ranking point for both the default path and the decision-model shortlist (buildSkillAttachmentWithDecision, src/core/surface/skill-attach-decision.ts:243+, shortlist at :257, options inherited via DecisionSkillAttachmentOptions :117). The per-turn caller is toolSkillsAttach (src/mcp/skill-tools.ts:164-187). The usage store already ships: deriveSkillUsage (src/core/brain/skill-usage.ts:105-149) returns SkillUsage with invocationCount and weight (the shared pure decay curve, weight in (0,1], nowMs injectable, default Date.now()); records are keyed on the raw payload["skill"] string, and for the Claude Code Skill tool that string is plugin-qualified ("open-second-brain:skill-name") which never joins to the discovered bare name - a normalization rule must be decided and documented. The config precedent is skills_attach_triggers: resolveConfigFlag (src/core/config.ts:779-786), resolver (:795-801), option on BuildSkillAttachmentOptions, pass-through at the tool, docs/mcp.md opt-in key list (:1218-1227), CHANGELOG. The repo's import-cycle ratchet counts `import type` as an edge and core/brain/skill-usage.ts already imports from core/surface, so core/surface must not import back.

Residue: a usage-derived weight folded into rankSkillCandidates as the single ranking point for both paths, gated by a default-off config flag beside the other skill gates, with a documented normalization rule for plugin-qualified invocation names, a deterministic composite score with a name tie-break, and the documented ranking invariants at skill-attach.ts amended in the same change.

## Card t_4501c662 (priority 4): Seeded proportional LongMemEval sampling for the bench harness

Source: Signet-AI/signetai v0.237.0.

What upstream ships: a seeded, proportionally stratified LongMemEval question sampler - every run draws the same category-balanced question subset from a seed, so retrieval-quality comparisons measure the retrieval change and not the question mix.

Recon verdict (premise corrected): the LongMemEval lane SHIPPED in v1.82.0 (src/core/bench/longmemeval.ts, 697 lines, registered as --suite longmemeval with an embeddings capability). The half that holds: no sampler of any kind exists under src/core/bench - every lane runs its fixture wholesale. Sampling must select PRE-conversion on LongMemEvalEntry: the official six question types survive only on the parsed entry (QUESTION_TYPE_TO_CATEGORY at longmemeval.ts:188-198 collapses the three single-session-* types into one BenchCategory post-conversion), and abstention entries (explicit type or `_abs` q_id suffix, isLongMemEvalAbstention :163-170) are dropped at conversion with a recorded count. The loader chain is parseLongMemEvalDataset (:220-249) then longMemEvalToBenchFixture (:559-645); loadLongMemEvalFixture (:648-658) is the registry entry point and BenchSuiteRegistration.loader takes only fixturePath today (src/core/bench/types.ts:194). Run identity is benchRunIdentityHash (src/core/bench/run-store.ts:49-61) = sha256(canonicalJson({fixture_hash, knobs, recall_floor})), the resume guard refuses a mismatch by name (:117-136); the recallFloor trace is the pattern to follow end to end (bench.ts:279-288 validator, :338-352 threading; phases.ts:99-111 options, :214-221 refusal, :223-234 identity fold; checkpoint fields types.ts:360-374). Determinism assets: no Math.random anywhere in the bench, canonicalJson + sha256Hex in src/core/integrity/digest.ts, sorted outputs everywhere; no general PRNG exists, so the sampler brings its own small deterministic generator. Committed sample fixtures are tiny and CI-pinned - sampling tests must build synthetic populations through the entry() helper (tests/core/bench/longmemeval.test.ts:38-54).

Residue: seeded proportional stratified sampling over the six official question types, applied to dataset entries PRE-conversion behind new CLI flags following the --recall-floor trace, with the sampling options folded into benchRunIdentityHash and the checkpoint, an own deterministic PRNG (no Math.random, no wall clock), sorted inputs so dataset file order cannot change the subset, receipt fields mirroring abstention_excluded, and byte-identical behavior when the flags are absent.

## Card t_68ae8a53 (priority 4): Teach the OpenCode install adapter and plugin the V2 config shape

Source: plur-ai/plur v0.21.4.

What upstream ships: the host plugin loads in OpenCode V2 - init understands the V2 plugins config object and the mcp.servers key while preserving JSONC comments, disabled choices and custom MCP entries. The V1 adapter stays supported.

Recon verdict (premise corrected): the bundled plugin already supports V2 at the runtime-hook API (setup() with per-capability feature detection, plugins/opencode/open-second-brain.ts) and reads and writes no config - the card's "study how the plugin reads/writes the config" has no referent, and the plugin needs no work. The real gap: the adapter is V1-only (src/core/install/adapters/opencode.ts:3-16 docblock, configPath hard-wired to opencode.json :44-46, plain-JSON legacy migration :72-95) and the shared body createJsonMcpAdapter (src/core/install/adapters/_json-mcp.ts) has a single top-level key notion everywhere (:181, :231) with plain JSON.parse/stringify round-trips (json-merge.ts:44-102) that would strip JSONC comments; the repo has NO jsonc dependency (only proper-lockfile in package.json). Upstream V2 behavior (plur v0.21.4 read for recon): native `mcp.servers` map wins when it exists and (contains the entry, or top-level mcp lacks it) - "native declarations win, but an existing legacy declaration must not be shadowed"; `opencode.jsonc` targeted when it is the only file present; comments and trailing commas survive via token-offset edits, never re-serialization; ambiguous JSONC (duplicate keys) refused unchanged; entry shape {type, command: [argv], environment?, enabled} unchanged. The doctor's registered-command probe (src/core/doctor-readiness.ts:723-777) re-reads the config with JSON_MCP_TOP_LEVEL_KEYS = ["mcpServers", "mcp"] (:641) independent of the adapter - a nested registration would report "skipped" unless the list learns the dotted path. Verify is reconstruction-based and must stay symmetric with apply (_json-mcp.ts:92-120 documents the drift-against-itself failure). The user-modified-block mtime guard (:328-351) bites when a shape change rewrites an owned file; the 1.50.0 upgrade-notes convention in docs/updating.md is the model for the one-time drift note. The host-facts census pins 10 targets (tests/core/architecture/host-facts-census.test.ts) - no target joins, so the row grows nothing; V1/V2 is a property of the on-disk file.

Residue: the adapter learns the V2 shape - detection by file shape shared by apply and verify, `.jsonc` path support, comment-preserving token-offset edits through a vendored minimal JSONC editor (a new dependency is a design decision to make explicitly; prefer the smallest honest option), the doctor probe taught the nested key, V1 installs untouched.

# Project context

Open Second Brain: a memory layer for AI agents living in an Obsidian vault, read and written through MCP servers, lifecycle hooks and the o2b CLI. TypeScript on Bun. Deterministic core: no model runs inside the algorithms. Every opt-in surface ships default off with a byte-identical-off regression proof; failures are typed named errors, never silent fallbacks; no hardcoded values that belong in constants; the tool census is pinned; no new external dependencies without an explicit design decision.

Recent commits:

44a8ccaf feat: recall quality - an iterative recall loop, coverage-first session recall and a measured surfacing key (v1.82.0) (#250)
259e4b70 fix(snapshot): decode readdir buffer entries as UTF-8 so exclusions match (v1.81.1) (#243)
323fb9e4 feat: answer trust - verified quotes, claim provenance and durable source evidence (v1.81.0) (#249)
a00fa3f5 feat: recall quality - mined sessions, honest admission and a store that filters in SQL (v1.80.0) (#248)
3f029241 feat: write-side trust - identity, permission and review for every agent write (v1.79.0) (#247)
66f9d847 feat: credential custody under a passphrase and a verifiable trust surface (v1.78.0) (#244)
3afb94a5 feat: a truth layer you can correct and time-travel (v1.77.0) (#242)
646a49df feat: freshen the search index on read, rewriting only changed chunks (v1.76.0) (#239)
78f924b9 feat: deliver context to subagent turns, hygiene digest at turn end and tiered context shrink (v1.75.0) (#238)
542d214b fix(opencode): support both plugin APIs (v1.74.1) (#190)

Related files:

- Search pipeline: src/core/search/pipeline/assemble.ts, src/core/search/mmr.ts, src/core/search/types.ts, src/core/search/index.ts, src/core/search/retrieval-trail.ts, src/core/search/result-filters.ts, src/core/search/pipeline/cache-slot.ts, src/core/search/query-cache.ts
- Skills: src/core/surface/skill-attach.ts, src/core/surface/skill-attach-decision.ts, src/core/brain/skill-usage.ts, src/core/config.ts, src/mcp/skill-tools.ts
- Bench: src/core/bench/longmemeval.ts, src/core/bench/types.ts, src/core/bench/phases.ts, src/core/bench/run-store.ts, src/cli/brain/verbs/bench.ts
- Install: src/core/install/adapters/opencode.ts, src/core/install/adapters/_json-mcp.ts, src/core/install/json-merge.ts, src/core/doctor-readiness.ts, src/core/runtime/host-facts.ts

Conventions:

- Mode-off byte-identical invariant: every opt-in feature leaves outcomes byte-identical when off, with a regression proof.
- Deterministic core: sorted inputs, named constants, no Math.random or wall clock in selection logic; clocks injectable.
- Typed named refusals everywhere; a knob that would silently do nothing is refused by name instead.
- Censuses and ratchets (tool ceiling, continuity readers, write sites, host facts, import cycles) move only in the commit that grows their inputs.
- Docs: full product name in public prose, no exclamation marks; CHANGELOG is Keep-a-Changelog with one descriptive entry per release.

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
