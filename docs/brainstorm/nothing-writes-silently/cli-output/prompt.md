You are brainstorming architectural variants for the following release wave. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release wave for Open Second Brain bundling eight units under the theme "nothing writes silently, nothing degrades silently". Every unit's scope below has already been corrected by a reconnaissance pass against the live source at main (v1.51.0); treat these corrected scopes as ground truth, not the original tracker cards.

## Unit A (t_39b9b633, do first): measured pending-vector count in `o2b search check`
The current recommendation branch in `buildRecommendations` (src/core/search/indexer.ts:1600-1647) fires on a provider-reachable + vec-loaded proxy with no term for existing vectors, so a fully-embedded healthy vault is told to "compute the first vectors" - a live false statement. Replace the proxy with a measured count: a new `countChunksWithoutEmbeddings(db)` (SELECT COUNT(*) anti-join beside the existing findChunksWithoutEmbeddings at store/chunks.ts:214) read through the existing `withReadonlyIndex` seam (store/embedding-abi.ts:65). Absent/unreadable index surfaces as "unrecorded", never zero. Fully-embedded vault gets no recommendation; pending > 0 names the count and points at the shipped `o2b search vector-backfill` dry-run verb for pricing. No auto-spend, off the query hot path.

## Unit B (t_589f04fb): blank-overwrite refusal + unreadable-read raise in the note update path
Two layers at one seam. (1) `readExistingNote` (write-batch.ts:519) currently discards `parseFrontmatter`'s unreadable-file notice, so an existing-but-unreadable note is treated as empty and update/append destroys frontmatter and body while reporting success - raise a typed `WriteBatchError("target_unreadable")` instead. (2) A pure shared guard `refuseBlankOverwrite({existingBody, nextBody, allowEmpty})` wired at `projectUpdateNote` only (covers brain_update_note and brain_write_batch's update_note op - the only two callers). New `allow_empty` boolean on those two schemas for deliberate clears. Creates of genuinely-new empty notes untouched. Guard placement in fs-atomic/host-memory-write/inline is refused (wrong layers; documented in the guard docblock). The ~40 other parseFrontmatter->rewrite sites are measured and deferred, named in the design doc.

## Unit C (t_34f4e3ab): server-derived origin_channel stamp on structured Brain records
Channel derived once per process at the entry point (MCP server / CLI dispatcher / import verbs), threaded as an option, NEVER a tool or CLI argument (25 MCP schemas already take `agent` verbatim - unverifiable; a caller-named channel would be a lie with a schema). Population bounded to four record families that already carry structured metadata: log events (appendLogEvent), signals (writeSignal - as a sibling of the existing source_type, with a documented mapping), continuity records (appendContinuityRecord), caller-named notes (the one resolveNoteTarget envelope). Backfill of existing records refused. The uncovered remainder (68 direct-fs census sites, fully-derived writers) asserted as a measured boundary in tests/core/architecture/write-site-census.test.ts.

## Unit D (t_6285e06f): derived maintenance-debt block on brain status
No stored counter (no transaction, no chokepoint; a counter would need a STATE_SURFACES row and 68-site instrumentation - refused). Derive from existing JSONL log shards after `last_dream_at` in `computeBrainStatus` (which already imports the shard readers). Field named for what it measures: `log_events_since_dream` - caller-named note writes emit no log event and the docblock says so (that sentence is the honesty deliverable). Wet-only clear is free (dry-run dream emits no dream log event - pin with a test). Ride on `second_brain_status` + `osb://status`; `brain_context` gets at most a cheap bounded overdue flag from the newest shard. `open_conflicts` descoped (needs a semantic-health run); `pending_triggers` only if the trigger store answers with a cheap count.

## Unit E (t_5b27eb0f): link candidates on note-producing envelopes + write accounting
No change to LlmStepFields/NEEDS_LLM_STEP_KEYS (the spine docblock forbids it; only 3 of 6 consumers produce wikilinked notes). `link_candidates` added to the three note-producing consumer types (rollup, diarization, design-note) the same way tier/produces already ride RollupEnvelope. Manifest built zero-embed from listVaultBasenames / note-title-resolver (fail-closed, lists candidates rather than guessing). Not smuggled into schema_hints (that channel is constraints, not data). Write accounting: lanes committing multiple artifacts from one envelope report attempted/written/failed + first real error, never bare success. Open design knob: durable dead-letter under .open-second-brain/ (needs a STATE_SURFACES row) vs in-response accounting only.

## Unit F (t_2e58d10f): import read-back census + sessions-import resume
Adapters (zep/letta/mnemosyne) stay dropped. Deliverable 1: post-import read-back census - after an import completes, re-read what landed and report claimed/found/missing with missing keys NAMED (a bare count is the misleading no-op this unit removes); shared helper over existing keys (dedup hashes for sessions, content-manifest hashes for ingest). Deliverable 2: extend the existing plan-scoped ingest checkpoint substrate (ingest/checkpoint.ts - atomic, vault-identity-asserted, schema-version-refusing) to the sessions import lane, which today has dedup-only re-do-and-discard; checkpoint keyed on (file, turn boundary). CHANGELOG must say resume exists for ingest and is being extended, not introduced.

## Unit G (t_808c91b0, first cut line): embedder-identity record-vs-data audit + free restamp
The attach-time raise mostly exists (resolveEmbeddingAbi throws under `fail`; `warn` default is deliberate - rebuild-loop argument at types.ts:2061 stands, do NOT flip it). Genuinely new: nothing compares the recorded index_state dimension against the ACTUAL stored embeddings width - a pure SQL audit (DISTINCT dimension vs meta vs vec0 declared width), reported as a third state "record contradicts data", landing in IndexCheckReport beside unit A (same buildRecommendations surface - sequence after A, do not parallelize). Plus a restamp verb for vec_version-only drift (a pure ABI token; no re-embed, no provider call), dry-run by default, CLI-only (operator repair; EMBEDDING_ABI_FIX_COMMAND is already a CLI string). Any re-embed verification is deferred or sits behind the planVectorBackfill apply/cost gate with three distinct outcomes (verified match / verified mismatch / cannot verify).

## Unit H (t_92c26f69): per-page visibility:private - form to be decided
The card is unbuildable as written (visibility: frontmatter dimension already exists in graph/visibility.ts as caller-liftable view scoping - any caller passes visibility:["private"] and reads the page; gatedOwnerScopeView is inert unless owner_scope_delivery:fail, gates only Brain artifacts, fails open on unresolvable refs). Real enforcement map: applyVisibilityScope has exactly one call site (search pool-filters); brain_file_context, context_pack, query, backlinks, unlinked_mentions, audit, sources, and the whole knowledge lane are unfiltered; the index itself stores private page content in chunks; listVaultPages has no frontmatter predicate. Two honest forms:
(A) deny-by-default: one predicate isRemotelyReadable in graph/visibility.ts honoring a reserved `private` token independent of owner-scope config, trusted-local bypass keyed on transport (stdio vs HTTP), never on a caller string; wired at three chokepoints (listVaultPages predicate, pool-filters, the indexer so private content never enters chunks); a new architecture census test enumerating every note-returning surface as covered/excluded-with-reason; the "no closed enum" docblock amended in writing. Corpus/indexRevision moves - named cost.
(B) honesty-only: ship the enumeration census + a doctor/search-check finding stating "visibility: private is a caller-supplied view filter, not a boundary; N surfaces do not honor it". Small, true, deferrable to (A) later.
The wave doc must pick A or B. Refuse the card's own design (riding gatedOwnerScopeView) unconditionally.

Also part of the wave (not a design question): tracker card t_5080cc53 (wikilink stub materialization) is closed as already-shipped (scaffold-stub landed end to end; the one unbuilt clause - auto-materialize on capture - is a silent write the shipped design refused in writing).

# Project context

Open Second Brain - TypeScript, Bun runtime. CLI (`o2b`) + MCP server over a file-based Obsidian-compatible vault with a SQLite (sqlite-vec) search index.
Recent commits:
6d3e8b23 feat: what earns its keep (v1.51.0) (#177)
86544b9b fix(hermes): the bridge child inherits a PATH that can find Bun (v1.50.3) (#176)
ba1a9678 fix(hermes): preserve context-pack recall (v1.50.2) (#172)
4ba335d4 ci: adopt Bun 1.4.0 - pin the toolchain and rebuild the bundle it gates (#175)
1e8792cb fix: a provider the host cannot read is not an unconfigured one (v1.50.1) (#171)

Related files: src/core/search/{indexer,vector-backfill}.ts, src/core/search/store/{chunks,embedding-abi,vectors}.ts, src/core/brain/{write-batch,log,signal,status,llm-step}.ts, src/core/brain/ingest/checkpoint.ts, src/core/brain/sessions/import.ts, src/core/graph/visibility.ts, src/core/write-binding/index.ts, tests/core/architecture/write-site-census.test.ts.

Conventions:
- Fail loud: refusals name their reason; partial writes report how far they got; no silent fallbacks, no stubs.
- OSB never calls an LLM; model work goes through needs-llm-step envelopes; the calling agent owns generation.
- Anything contacting an embedding provider sits behind an explicit apply gate, dry-run by default.
- Architecture censuses are standing tests (write-site, state-surface, verdict-vocabulary); new durable state needs a STATE_SURFACES row; MCP tools need previewBudget + closed schemas + parity pins; CLI verbs need dispatch + help text + command-manifest rows.
- English-only strings; no natural-language hardcoding for other languages.

Constraints:
- No new caller-supplied field may carry provenance or privilege (server-derived only).
- Derived quantities are named for what they actually measure.
- Units A and G share buildRecommendations - they must land sequentially.
- One PR, one CHANGELOG version for the whole wave.
- No new external dependencies. Do not change existing public API semantics except where a unit explicitly says so.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant (how the eight units compose: shared mechanisms, unit H form, dead-letter knob, sequencing).
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
