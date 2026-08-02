You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release wave for Open Second Brain covering the ten kanban tasks below. They were selected together because they all sit on the same seam: the boundary where content, authority and claims enter the vault. The architectural question you are brainstorming is NOT how to implement each task separately - it is how the ten units should be factored so the wave has one coherent substrate instead of ten independent bolt-ons.

Specifically, decide how these cross-cutting concerns should be shared or kept separate across the ten units:

- provenance of a record (where it came from, how trusted that origin is)
- authority to write (which identity may write where, and what a refusal looks like)
- validation before a write lands (schema, shape, existence)
- what a record says about its own scope and its own time anchor
- what happens when a capability the write path wants is not configured
- what independent proof, if any, backs an outcome claim


## t_444349f2 (board priority 4) - [upstream:gbrain] Quarantine/review lane for auto-extracted entities carrying untrusted provenance

**Source**: https://github.com/garrytan/gbrain/pull/3458
**Repo**: garrytan/gbrain (18439★)
**PR**: #3458 feat(extract): quarantine lane for auto-extracted entities from untrusted input (#160) (2026-07-28)

## What
Route entities that an agent auto-extracts from untrusted content (ingested web/chat, scraped pages) into a quarantine/review lane instead of promoting them straight into the knowledge registry, so untrusted provenance cannot contaminate trusted entities. This is a deterministic provenance-routing policy on the intake primitive, not an extraction model — the calling agent still extracts; OSB decides where the typed record lands.

## Why useful for OSB
OSB already has both halves of the machinery but not the join: a `quarantine` status exists for preferences and an `UNTRUSTED_SOURCE_TAG` fence exists for note content, yet intake entities are written straight into the entity registry with no review lane. Gating untrusted-provenance intake entities into a quarantine lane before promotion closes a real contamination gap and fits OSB's deterministic, agent-owns-the-model contract — extracted entities from a scraped web page should not become first-class Brain entities until a human/agent promotes them.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: Quarantine status exists for PREFERENCES only — `src/core/brain/preference.ts:353-356` (BRAIN_PREFERENCE_STATUS.quarantine), surfaced in `src/mcp/brain/feedback-tools.ts:518` and digest at `src/mcp/resources.ts:89,527`. Untrusted-content fencing exists — `src/core/brain/untrusted-source.ts` (UNTRUSTED_SOURCE_TAG, fenceUntrustedContent, neutralizeUntrustedText), consumed by `src/core/brain/navmap.ts:16`. No quarantine/review lane for extracted ENTITIES — entities enter the registry directly via `src/core/brain/intake/extract-intake.ts` → `intakeExtraction` (called from `src/mcp/brain/ner-tools.ts:17`); not found.

## Notes
Adopt as a deterministic provenance policy on `intakeExtraction`, not an extraction model: reuse the existing `UNTRUSTED_SOURCE_TAG` signal to flag intake records, and add a `quarantine`-style entity status mirroring the existing preference lifecycle (unconfirmed → confirmed/retired). Conceptually adjacent to the review-queue idea already observed on `t_041c571f` (llm-wiki-compiler quarantines low-confidence/provenance-violating generated pages); this task is the entity-intake-specific instance of it.


## t_a3c4b13b (board priority 4) - [upstream:gbrain] Per-credential enforced write-prefix fence (bound-slug-prefixes) refusing cross-prefix writes at the server

**Source**: https://github.com/garrytan/gbrain/releases/tag/v0.42.72.0
**Repo**: garrytan/gbrain (18439★)
**Released**: v0.42.72.0 (2026-08-01T23:06:18Z)

## What
Bind a credential/client to a set of folder-prefix write boundaries so the server REFUSES any write op that names a page outside those prefixes — a per-credential, server-enforced, write-only fence. Ops that write by something other than a page slug (entity/fact extraction, ontology propose, source add/remove, ingest, put-page auto-fact-extraction) are refused outright to bound credentials rather than left unfenced. Bindings are rescopable in place with existing tokens picking up the change on the next request (no secret rotation).

## Why useful for OSB
Lets multiple agents/people share one source while each is confined to its own write territory, preventing accidental or cross-agent overwrites without splitting the vault or rotating credentials. Complements OSB's existing read/ingest scope filters by adding a hard, credential-level write authorization boundary that OSB currently lacks.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: OSB has scope-based read/ingest isolation only, not a per-credential write-prefix fence. Owner-scope read/ingest filtering: src/mcp/brain/query-tools.ts:182, src/mcp/brain/context-tools.ts:360, src/mcp/brain/ingest-tools.ts:129, src/mcp/tools.ts:236, src/mcp/server.ts:123, src/cli/search/verbs/query.ts:129, src/core/search/types.ts:329. Agent-ownership recall narrowing: src/core/graph/agent-scope.ts:2-43, src/core/scope-key.ts:25,100, src/core/search/pipeline/pool-filters.ts:130, src/core/search/result-filters.ts:270,307. No symbol found for credential-bound write-prefix enforcement or server-side refusal of writes outside a bound prefix.

## Notes
Distinct mechanism, not a weaker version of existing OSB isolation. OSB's models are request/scope-axis filters (owner, agent-scope) applied on READ and INGEST; gbrain's is a WRITE-only boundary keyed to the credential and enforced by server refusal at every page-naming op. Different axis (folder prefix vs owner/agent identity) and different enforcement point (write-refusal vs read/ingest narrowing), so this is a capability gap rather than an improvement to an existing feature. Per upstream, this is a write boundary, not a privacy boundary — reads stay source-granular; scope any OSB implementation the same way to avoid implying read isolation.


## t_c0fce0b9 (board priority 3) - [upstream:iwe] Template-mode note creation with typed variables, pre-write schema validation, and idempotent if_exists:skip

**Source**: https://github.com/iwe-org/iwe/releases/tag/iwe-v0.17.0
**Repo**: iwe-org/iwe (1,086★)
**Released**: iwe-v0.17.0 (2026-07-29T01:26:08Z)

## What
Extend Open Second Brain's note-write primitive with a second creation mode alongside today's verbatim CONTENT path: a TEMPLATE mode that names a stored template and fills it with variables — `--var NAME=VALUE` (verbatim string), `--vars-yaml`/`--vars-json` for a whole typed variable set so templates can branch on booleans and loop over lists — plus `--set FIELD=VALUE` frontmatter fields written above the rendered body. Add a `--strict` flag that validates the resulting document against the Brain schema before writing, and an `if_exists: "skip"` option that makes a repeated create a safe no-op (existence checked against the file on disk). Mirror the same shape into the `brain_create_note` MCP tool so an agent writes exactly the document it intended.

## Why useful for OSB
Agents and users get repeatable, schema-correct note creation: structured note types (decisions, sources, MOCs) render from one canonical template with typed inputs instead of hand-assembled markdown, `--strict` catches malformed frontmatter before it lands in the vault, and `if_exists: "skip"` lets automations and cron flows call create idempotently without pre-checking or catching the loud "exists" error.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**:
  - CONTENT-only, no template/variables: `CreateNoteInput` has only `path`/`frontmatter`/`content` in `src/core/brain/notes/create-note.ts`.
  - No idempotent skip — loud refusal on clobber: `CreateNoteErrorCode` includes `"exists"`, writer called with `overwrite: false` + `existsErrorKind: "note"` at `src/core/brain/notes/create-note.ts:25,134-135`.
  - No note-body template engine: existing "templates" are config/export/cron only — `src/core/brain/config-template.ts`, `src/core/brain/templates.ts`, `renderCronTemplate` in `src/cli/search/verbs/indexing.ts`.
  - No `--strict` pre-write schema gate: schema vocabulary exists via `cmdBrainSchema` (`src/cli/brain.ts:283-284`, `src/cli/command-manifest.ts:185-189`) but is not wired into `createNote`.
  - Building blocks present: `writeFrontmatterAtomic` and frontmatter split/parse in `src/core/vault.ts` parallel iwe's `split_raw_frontmatter`/`prepend_frontmatter` additions.

## Notes
Scope naturally into three layers that can ship independently: (1) `if_exists: "skip"` idempotent create — smallest, but note it deliberately relaxes the current "refuse loudly, never a silent skip" contract, so it must be opt-in and leave the default refusing; (2) `--strict` pre-write schema validation reusing the existing Brain schema vocabulary; (3) the template engine with typed `--vars-yaml`/`--vars-json` variables, the largest piece. All three should land in both the CLI and the `brain_create_note` MCP tool to keep parity.


## t_ac1c4176 (board priority 3) - [upstream:gbrain] Content-derived date anchor for temporal ranking when a note's mtime/created_at is not content-meaningful

**Source**: https://github.com/garrytan/gbrain/pull/2341
**Repo**: garrytan/gbrain (18439★)
**PR**: #2341 feat(extract): --infer-dates anchors timeline from a page's content date when its body has none (merged-date: unknown — not fetchable, non-interactive session)

## What
Adds an ingest-time concept of a *content date*: when a note carries no explicit date, the extractor infers one from the note's own content — a frontmatter `created`/`published`/`date` field or a date token in the body — and uses it as the temporal anchor for sorting/ranking instead of the crawl/mtime timestamp. In Open Second Brain terms, this is a new content-meaningful date column promoted from frontmatter/body, feeding temporal recall.

## Why useful for OSB
Open Second Brain notes are routinely back-dated — imported logs, meeting notes, historical references — yet carry today's `mtime`/`created_at`, and mtime drifts across synced machines, so a note written today about a 6-month-old event ranks as "recent." A content-derived anchor makes temporal recall correct for exactly these notes and lets the existing query-side `temporal-intent` (`since:`/`until:`/named periods) rank against when the content is *about*, not when the file was touched.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: `src/core/search/schema.ts:102` (`mtime INTEGER`), `schema.ts:104` (`created_at TEXT`) — both filesystem/crawl timestamps, no content-date column; `src/core/search/indexer.ts:295` (`file.stat.mtimeMs` fastpath, `created_at` set at index time, no body/frontmatter date extraction); `src/core/search/chunker.ts` `extractFrontmatter` and `src/core/vault.ts` `parseFrontmatterTextWithNotices` (frontmatter parsed and indexed as a block but date-ish fields not promoted); `src/core/search/temporal-intent.ts` (query-side `since:`/`until:`/named-period detection ranks off `mtime`/`created_at` only). No "content date" / "body date" / "infer date" concept found in `src/core` — confirmed absent.

## Notes
- Query and ingest are separable: the query side (`temporal-intent.ts`) already exists; the gap is a stable ingest-side anchor for it to rank against. A new nullable `content_date` column (fall back to `mtime` when unset) keeps existing ranking behavior intact for notes with no inferrable date.
- Date extraction must stay language-agnostic per repo convention (`pref-language-agnostic-search`): prefer explicit frontmatter fields (`created`/`published`/`date`) and structural ISO-like tokens over natural-language date phrases; avoid hardcoded month-name word lists across locales.
- Edge cases: multiple candidate dates in one body (need a precedence rule — frontmatter over body, earliest/latest), ambiguous formats (DD/MM vs MM/DD), and future dates. Consider recording provenance (which source the anchor came from) so mis-anchoring is auditable.


## t_39ec3fef (board priority 3) - [upstream:gbrain] Token-budget embedding batch packing to respect provider per-request input-token caps

**Source**: https://github.com/garrytan/gbrain/pull/3651
**Repo**: garrytan/gbrain (18,439★)
**PR**: #3651 declare Gemini embedding batch-token budget (2026-07-31)

## What
Add a per-request token budget to embedding batching so batches are packed up to an accumulated-token limit rather than a fixed chunk count. The batcher would sum each text's token estimate and close a batch once the next chunk would exceed the configured provider input-token cap, falling back to the count cap for cheap endpoints that only limit by chunk count.

## Why useful for OSB
OSB's embedding batches are count-only (`batchSize` 32), so a worst-case batch of 32 × ~800-token chunks is ~25,600 input tokens in one request — enough to blow a token-capped provider's per-request limit. A token budget lets OSB target Gemini and similar token-capped embedding endpoints without 429/413 errors while keeping dense batches for count-limited providers.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**:
  - Count-only batching: `src/core/search/embeddings/openai-compat.ts:269-271` (`chunkArray(texts, this.config.batchSize)`), sent per-request at `openai-compat.ts:286,340` (`embedBatchWithRetry`).
  - Default `batchSize: 32` at `src/core/search/index.ts:148`; validated as `embedding_batch_size` (min 1) at `src/core/search/index.ts:322`. No `embedding_batch_tokens`-style budget exists.
  - Chunks already token-sized: `src/core/search/chunker.ts` (`maxTokens` default 800), so ~800 tokens/chunk × 32 = worst-case ~25,600 input tokens/request.
  - Token-cap 429/413 responses hit hard-quota handling `QUOTA_ERROR_TOKENS` at `src/core/search/embeddings/openai-compat.ts:79-97`, not transient size handling.
  - No Gemini-specific provider — Gemini embeddings route through the generic `openai-compat` path.

## Notes
- Reuse the chunker's existing token-estimation logic (`src/core/search/chunker.ts`) so batch-token accounting matches how chunks were sized; avoid a divergent tokenizer.
- Budget should be additive to the count cap (whichever fills first closes the batch), preserving current dense batching for count-limited endpoints.
- Consider distinguishing token-cap size errors (413 / token-limit 429) from true quota exhaustion in `QUOTA_ERROR_TOKENS` handling so an oversized batch can be split and retried rather than treated as a hard quota stop.
- Interacts with `embedding_concurrency` semaphore slots (one batch per slot) — token budgeting changes batch count but not the concurrency model.


## t_76b89833 (board priority 2) - [upstream:EverOS] Optional embedding/rerank with capability tiers and deferred vector backfill at ingest

**Source**: https://github.com/EverMind-AI/EverOS/releases/tag/v1.2.1
**Repo**: EverMind-AI/EverOS (6,886★)
**Released**: v1.2.1 (2026-07-29T17:21:27Z)

## What
Make embedding and rerank soft runtime dependencies so Open Second Brain boots with only an LLM configured and degrades into capability tiers: LLM-only → keyword search + writes + cascade sync; +embedding → vector/hybrid search + reflection + skill extraction; +rerank → agentic search. Rows ingested without an embedding provider are stored with NULL vectors and filled in retroactively by a dedicated backfill CLI (vectors → clusters → skills), instead of aborting startup or failing the write.

## Why useful for OSB
Today ingestion fails loud when no embedding provider is wired (`NullProvider.embed()` throws), so an operator with only an LLM cannot write to the vault at all. Tiered degradation plus deferred backfill would let agents keep capturing knowledge while embeddings are unavailable or unconfigured, then enrich those rows once a provider appears — removing embedding as a hard boot/ingest gate.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: `src/core/search/embeddings/null-provider.ts` (`embed()` throws `SearchError("EMBEDDING_DISABLED")` — fails loud, cannot persist NULL-vector rows at ingest); `src/core/search/index.ts:331-343` (`embedding_provider` = `openai-compat | zeroentropy | local | disabled`, `disabled` → NullProvider, no tier model); `src/core/search/indexer.ts:175` and `indexer.ts:594` (binary semantic on/off + offline lexical fallback at SEARCH time, not a tiered capability model nor a write-now-embed-later ingest path); `src/cli/search.ts` / `src/cli/search/verbs/indexing.ts` (`o2b search reindex --embeddings` re-embeds already-vectored chunks on model change, not deferred NULL-vector backfill); `src/cli/brain.ts:295-298` (`brain semantics-backfill` / `brain authored-at-backfill` backfill metadata fields, not deferred embedding vectors). No tiered capability model or NULL-vector-await-backfill concept found.

## Notes
- Adapting to OSB implies: a tier resolver keyed on which providers are configured; a schema allowing NULL vectors (parallel to EverOS's LanceDB schema v2); a NULL-vector variant of NullProvider (or a distinct "deferred" mode) that defers rather than throws; a new `cascade backfill` CLI with vectors → clusters → skills phases; and an "unbackfilled rows" startup banner.
- The existing content-hash manifest in the reindex path can likely be reused to drive the vector-backfill phase.
- Consider mapping EverOS's `ProviderNotConfiguredError → HTTP 422 CAPABILITY_UNAVAILABLE` onto OSB's `SearchError` codes for read-time capability gating.


## t_77efc212 (board priority 2) - [upstream:hindsight] Named shared observation scope for explicitly sharing extracted observations across contexts

**Source**: https://github.com/vectorize-io/hindsight/releases/tag/v0.8.3
**Repo**: vectorize-io/hindsight (15638★)
**Released**: v0.8.3 (2026-06-18T09:36:01Z)

## What
Upstream adds a `shared` keyword to the `observation_scopes` taxonomy used during consolidation, so an extracted observation can be explicitly marked as shareable across contexts/sessions rather than being confined to private/local-only scoping. For OSB this maps onto the continuity-record envelope: today records carry `private`/`redacted` flags, but there is no positive, named scope that says "this observation is intended to be shared/promoted beyond its origin context."

## Why useful for OSB
A first-class `shared` scope gives extraction and read-side gating a clear, intentional signal for cross-context promotion instead of inferring it from the absence of `private`. That sharpens recall (consumers can opt into shared observations deliberately) and makes the privacy model symmetric — explicit private vs. explicit shared rather than private vs. default.

## Status in OSB
- **Verdict**: unverified
- **Codegraph hints**: unverified — codegraph MCP unavailable in this run; textual search found docs/observability.md:32 (continuity envelope fields `private`/`redacted`), docs/observability.md:77 (read-side consumers drop `private` by default, keep only on explicit request), and docs/architecture.md:208 (an always-load scope naming decision), but no explicit shared observation scope model was found.

## Notes
The current OSB model appears to express scope negatively (drop `private` unless requested) rather than via an explicit shared/promotable scope. Before implementing, confirm against the actual scope enum / continuity-record schema whether a `shared` value already exists under a different name (e.g. an "always-load" scope per architecture.md:208) — if so this may be present_parity rather than a net-new addition.


## t_50033859 (board priority 1) - [upstream:plur] Add HTTP pack install/preview for Brain schema packs (fetch a pack from a URL)

**Source**: https://github.com/plur-ai/plur/releases/tag/v0.16.0
**Repo**: plur-ai/plur (154★)
**Released**: v0.16.0 (2026-07-28T19:57:14Z)

## What
Upstream `plur packs install <url>` / `plur packs preview <url>` (#746) fetch a pack over HTTP: preview inspects the remote pack before applying, install pulls it down and registers it. This turns packs from a purely local artifact into a shareable, distributable unit addressable by URL.

## Why useful for OSB
OSB already has a pack concept — Brain **schema** packs (token/type/alias/prefix/link-type bundles) surfaced via `schema_inspect(view: packs | active_pack)`. Today those packs are local/schema-driven only: authored or shipped in-repo, with no way to pull a community-authored or team-shared schema pack by URL. A `preview <url>` + `install <url>` path would let the community distribute domain schema packs (e.g. a research-vault taxonomy, a legal-notes ontology) the same way plur distributes memory packs — a natural fit for OSB's "bring your own vault shape" story. Preview-before-apply also matches OSB's cautious, user-owns-the-data posture: inspect exactly what tokens/types a remote pack would mutate before it touches the schema.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: Pack tooling exists but is local-only — no HTTP fetch-and-install. `src/mcp/brain/pack-tools.ts` (Brain schema pack tools, local/schema-driven); pack views exposed via `schema_inspect(view: packs)` / `schema_inspect(view: active_pack)`. Grep for a URL/HTTP pack-install path returned no hits — the only network-adjacent code found is `src/core/install/opencode-plugin-asset.ts` (in-repo plugin packaging) and `src/core/search/embeddings/local-provider.ts` (local embeddings), neither of which fetches-and-installs a pack. The "install/preview from URL" capability is absent.

## Notes
- Scope this to OSB's schema packs, not a general memory backend — the two projects' "pack" refer to different artifacts.
- Ship `preview` before `install`, and require it: show the exact schema mutations (new/renamed tokens, types, aliases, link-types) a remote pack would apply, so nothing mutates the vault schema sight-unseen.
- Local-first guardrails: pin/verify the fetched pack (checksum or signature), sandbox it to schema-only changes (no arbitrary code execution on install), and keep it fully opt-in. A remote URL is an external-input trust boundary — treat a fetched pack as untrusted until previewed (ties into the quarantine-lane idea on t_444349f2).


## t_b654e25d (board priority 2) - [upstream:contextlattice] Split verification ledger — independent VERIFIER-witnessed result distinct from the acting agent's outcome claim, with matched-control causal gain

**Source**: https://github.com/sheawinkler/contextlattice/releases/tag/v3.20.0
**Repo**: sheawinkler/contextlattice (61★)
**Released**: v3.20.0 (2026-07-18T07:02:33Z)

## What
Add a two-record verification ledger where the acting agent posts an outcome CLAIM and a *separate* verifier posts an independently-witnessed RESULT (own verifier-id, verifier-kind, evidence-digest sha256, verification-passed bool), joined to the claim by exact project/agent/session/sample identity. Causal-gain claims require a leakage-free matched control (identical task/assignment/model/runner/harness/reconstruction/exact model-visible token count/tokenizer); without a control only observed verified yield is reported. Persist fsync-backed and restart-safe; 503 on persistence failure rather than acknowledging a memory-only claim.

## Why useful for OSB
OSB's outcome loop is single-actor: the same agent that did the work posts the OUTCOME ROW and the calibration record by the same sample id (deriveOutcome, recordTokenImpactOutcome). Nothing witnesses that claim independently, so a self-serving or buggy agent can inflate its own token-savings/utility with no adversarial check. A distinct verifier record + matched-control gating would give OSB trustworthy, non-self-reported utility accounting.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: single-actor outcome path exists — src/core/brain/context-pack-outcome.ts:322 (deriveOutcome -> TokenImpactOutcome), src/core/brain/token-impact.ts:218 (recordTokenImpactOutcome, both keyed by the acting agent's sample). Trust primitives that could seed a verifier but do NOT record an independently-witnessed pass: src/core/brain/trust/compute-verification-delta.ts:58 (computeVerificationDelta, dream-phase claims-vs-disk, no separate verifier actor), src/core/search/evidence-verification.ts:67 (buildEvidenceVerification, retrieval IDF/recall coverage), src/core/brain/trust/self-approval-guardrail.ts:41 (will/preference promote|quarantine, not utility). No verifier-id / evidence-digest / verification-passed record and no matched-control causal-gain semantics found.

## Notes
Related but distinct: src/core/brain/reconcile-outcomes.ts is dream-phase contradiction reconcile, not verification. Scope the new record to sit alongside the existing token-impact ledger, keyed by the same sample id.


## t_ccb05134 (board priority 2) - [upstream:contextlattice] Skill efficacy receipt chain — outcome-verified lifecycle, discriminating-term ranking floor, SHA-256 identity collapse

**Source**: https://github.com/sheawinkler/ContextLattice/releases/tag/v4.0.6
**Repo**: sheawinkler/contextlattice (61★)
**Released**: v4.0.6 (2026-07-31T08:48:50Z)

## What
Add an efficacy receipt chain to Open Second Brain's skills catalog: skills advance through four lifecycle stages (searched → selected → invoked → independently-verified-outcome), where search/attachment alone earns no efficacy credit and only an independently-verified outcome closes the chain. Harden ranking with a deterministic discriminating-term coverage floor so generic query words can no longer dominate skill selection, and collapse byte-identical SKILL.md files to a single SHA-256 identity while retaining every source path as provenance. An efficacy-review pass emits only bounded candidates (inactive-retain, note, revision, retirement, abstention) and never edits, activates, or executes a skill.

## Why useful for OSB
Open Second Brain today scores skills deterministically per turn but keeps no record of whether an attached skill was actually selected, invoked, or helped — so brain_skill_proposals can only reason about relevance, not proven usefulness. Outcome-verified receipts let proposals rank and retire skills on evidence, the discriminating-term floor stops broad boilerplate queries from surfacing weak matches, and SHA-256 collapse deduplicates identical skills across roots without losing provenance. The bounded, read-only review pass fits OSB's existing observe-don't-mutate posture for the skill surface.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: No efficacy/receipt/lifecycle tracking exists — grep for skill usage/outcome/efficacy/receipt/verified-outcome/invoked-skill/skill-rank/discriminating found only unrelated "discriminator" union fields (write-batch, decisions, session-lifecycle). Current skill surface: discovery `src/core/surface/skills.ts` (`discoverSkills`/`readSkillFile`/`skillRoots`); per-turn relevance `src/core/surface/skill-attach.ts` (`buildSkillAttachment`); MCP tools `src/mcp/skill-tools.ts` (`list_skills`/`get_skill`/`skills_attach`/`brain_skill_proposals`) + `src/mcp/registry-guard.ts:131,136`; config `src/core/config.ts:600-612` (`resolveSkillsDir`) and default-OFF gates `src/core/config.ts:638-652` (`resolveSkillAutoAttach`/`resolveSkillsAttachTriggers`). Ranking is deterministic relevance only, with no discriminating-term floor and no SHA-256 identity/provenance collapse.

## Notes
Scope aligns with OSB conventions: the review pass stays read-only (proposals only, never mutating/activating skills), matching the default-OFF auto-attach gates. Per OSB's language-agnostic-search preference, the discriminating-term coverage floor must derive discrimination from corpus document-frequency/IDF over skill text, not any hardcoded natural-language stop-word list.

# Project context

Open Second Brain - TypeScript on the Bun runtime; a CLI (`o2b`) plus an MCP server over an Obsidian-compatible Markdown vault. Around 900 modules under `src/`, ~8100 tests under `tests/`.

Recent commits on main:
7e6a5672 refactor: module boundaries and the fallbacks behind them (v1.42.0) (#153)
5ac866eb feat: signals that survive (v1.41.0) (#152)
0963ef0a feat: no dead ends - every diagnosis names its exit (v1.40.0) (#151)
f91a698b feat: context integrity gates (v1.39.0) (#150)
c31a2574 feat: semantic-health baseline watermark (v1.38.0) (#148)
b0c37977 feat: retrieval quality and context delivery (v1.37.0) (#146)
842d690f feat: knowledge intake and consolidation (v1.36.0) (#145)
95dc8577 feat: trusted recall and memory write surface (v1.35.0) (#144)
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (not just inline arrays) (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
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

Related files (verified anchors are inside each task body above):
- src/core/brain/intake/extract-intake.ts, src/core/brain/untrusted-source.ts, src/core/brain/preference.ts
- src/mcp/server.ts, src/mcp/tools.ts, src/mcp/brain/*.ts, src/core/scope-key.ts, src/core/graph/agent-scope.ts
- src/core/brain/notes/create-note.ts, src/core/vault.ts
- src/core/search/schema.ts, src/core/search/indexer.ts, src/core/search/chunker.ts, src/core/search/temporal-intent.ts
- src/core/search/embeddings/{openai-compat,null-provider,local-provider,contract,signature}.ts
- src/core/brain/continuity/read-model.ts, src/core/brain/continuity/emit.ts
- src/mcp/brain/pack-tools.ts, src/core/brain/portability/{bundle,okf}.ts
- src/core/brain/context-pack-outcome.ts, src/core/brain/token-impact.ts, src/core/brain/trust/*.ts
- src/core/surface/skills.ts, src/core/surface/skill-attach.ts, src/mcp/skill-tools.ts

Conventions:
- The kernel calls no model. Every decision in the deterministic path is a rule or a score table, never an LLM call.
- No natural-language word lists, in any language, anywhere in gating, classification, ranking or extraction. Structural signals, explicit frontmatter fields, or corpus document-frequency instead.
- A new flag or configuration key must be byte-identical in behaviour when absent.
- Findings and diagnoses resolve a REGISTERED diagnostic code through a single advisory rail; never a sentence assembled at the call site.
- Absence and inability-to-examine are different answers and must never be collapsed into one.
- No silent fallback, no stub, no placeholder. If something failed, the failure is named at the surface the caller can see.
- Tests never touch the real vault or the network; they build temp vaults.

Constraints:
- Do not change existing public CLI or MCP surfaces in a breaking way; additive only.
- No new runtime dependency without a strong argument; an embedding transformer or a network fetch is exactly the kind of dependency that needs one.
- The ten units land as separate atomic commits on one branch, implemented largely in parallel by separate agents, so the substrate they share must be decided up front rather than discovered during merge.
- Some units are explicitly scoped down by their own task body (for example the verification ledger's matched-control causal-gain semantics). Respect those carve-outs.

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
