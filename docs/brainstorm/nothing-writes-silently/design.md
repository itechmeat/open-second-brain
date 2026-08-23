# Nothing writes silently - integrity and degradation honesty wave

**Status:** accepted
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Eight tracker cards converge on one defect class: Open Second Brain can lose or degrade data without saying so. A note update can blank a page it failed to read; a fully-embedded vault is told to "compute the first vectors"; an interrupted sessions import re-does everything and reports nothing; a failed envelope write can exist only in a response the caller dropped; a `visibility: private` flag reads as privacy and is not. Reconnaissance against main (v1.51.0) corrected or refuted every card's premise before this design; the corrected scopes in `docs/brainstorm/nothing-writes-silently/cli-output/prompt.md` and the recon report are ground truth, not the cards.

## Scope

Eight units, one PR, one CHANGELOG version (chosen approach: consultant Variant 2, "shared reconciliation vocabulary"):

- **Unit A** (`t_39b9b633`): measured pending-vector count replacing the false proxy branch in `buildRecommendations`; `countChunksWithoutEmbeddings(db)` COUNT(*) anti-join read through `withReadonlyIndex`; absent index surfaces as unrecorded, never zero; a fully-embedded vault gets no recommendation.
- **Unit B** (`t_589f04fb`): `readExistingNote` raises typed `WriteBatchError("target_unreadable")` instead of treating an unreadable note as empty; pure `refuseBlankOverwrite` guard at the single `projectUpdateNote` seam; `allow_empty` boolean on `brain_update_note` and `brain_write_batch`'s `update_note` op.
- **Unit C** (`t_34f4e3ab`): server-derived `origin_channel` (resolved once per process at the entry point, threaded as an option, never an argument) stamped on four record families: log events, signals (sibling of `source_type`), continuity records, caller-named notes. Uncovered remainder asserted in the write-site census.
- **Unit D** (`t_6285e06f`): derived `maintenance_debt` block in `computeBrainStatus` from existing JSONL log shards after `last_dream_at`; field named `log_events_since_dream` for what it measures; rides `second_brain_status` + `osb://status`; `brain_context` gets only a cheap newest-shard overdue flag.
- **Unit E** (`t_5b27eb0f`): `link_candidates` on the three note-producing envelope consumer types (rollup, diarization, design-note) built zero-embed from the basename walker / note-title resolver; write accounting in the shared reconciliation vocabulary; durable dead-letter under `<vault>/.open-second-brain/` with its STATE_SURFACES row.
- **Unit F** (`t_2e58d10f`): post-import read-back census (claimed/found/missing with missing keys named) over existing dedup/content hashes, in the shared reconciliation vocabulary; sessions-import resume extending the existing `ingest/checkpoint.ts` substrate.
- **Unit G** (`t_808c91b0`): record-vs-data embedder audit (recorded `index_state` dimension vs actual stored width vs vec0 declared width) as a third state "record contradicts data" in `IndexCheckReport`; `vec_version`-only restamp CLI verb, dry-run by default, no provider contact.
- **Unit H** (`t_92c26f69`, form B): a standing architecture census enumerating every note-returning surface as visibility-covered or excluded-with-reason, plus a `search check` / doctor finding stating that `visibility: private` is a caller-supplied view filter, not a boundary, naming the uncovered surface count.
- **Shared substrate** (new, first): one pure reconciliation report module (`attempted/found/missing`-shaped, missing keys always named) consumed by units E, F, and G's third state, pinned by the verdict-vocabulary census.

## Out of scope

- `t_5080cc53` (wikilink stub materialization): REFUSED - already shipped end to end as `scaffold-stub` (core + `brain_scaffold_stub` + CLI verb + repair-lane + tests). The one unbuilt clause (auto-materialize on capture) is a silent write the shipped design declined in writing (`repair-lane.ts:110-115`).
- Import adapters (zep/letta/mnemosyne) - external formats with no fixtures.
- A stored writes counter (no transaction, no chokepoint; refused - derive only).
- Any change to `LlmStepFields` / `NEEDS_LLM_STEP_KEYS` (the spine docblock forbids it; only 3 of 6 consumers produce wikilinked notes).
- Flipping `integrity.embedding_abi` default to `fail` (the rebuild-loop argument at `types.ts:2061` stands).
- Re-embed verification for model/dimension drift (deferred; if ever shipped it sits behind the `planVectorBackfill` apply/cost gate).
- Unit H form A (deny-by-default enforcement at walker/search/indexer chokepoints): deferred to a dedicated wave. The indexRevision move would invalidate every index in the same release that ships new index-health signals, and the three-chokepoint change is wave-sized by itself. The Unit H census is exactly the coverage map form A needs.
- The ~40 other `parseFrontmatter` -> rewrite sites (labels, tombstone, backfills, ...): measured and deferred; unit B fixes the write-batch seam only.
- Backfilling `origin_channel` onto existing records: rewriting history to add provenance is the opposite of provenance.

## Chosen approach

Consultant Variant 2 with two orchestrator amendments:

1. **Unit H card disposition**: form B ships the truth, not the card's ask. The tracker card is not closed as done at release; it receives the redesign verdict (form A spec, census as coverage map) and stays parked for a dedicated enforcement wave - mirroring the t_916f9953 refusal handling.
2. **Dead-letter boundary**: the durable dead-letter covers only lanes that commit multiple artifacts from one validated envelope payload (rollup fold, extract-signals batch); single-artifact lanes keep in-response accounting (their one failure IS the response). This bounds the STATE_SURFACES row to where a dropped response could actually hide a partial write.

## Design decisions

- **Server-derived beats caller-asserted, uniformly.** No new caller-supplied field may carry provenance or privilege (25 MCP schemas already take `agent` verbatim - the census recount this wave found 25, up from the documented 22). Unit C derives the channel at the process entry point; unit H's future bypass would key on transport, never a string. Cited by both units.
- **Derived quantities are named for what they measure.** `log_events_since_dream`, not `writes_since_dream` - caller-named note writes emit no log event, and the docblock says so. A false label on a true number is the dishonesty this wave removes.
- **One reconciliation vocabulary, not three dialects.** E's accounting, F's census, and G's third state share one pure report shape, pinned by the verdict-vocabulary census, so "missing" cannot drift into three spellings.
- **Units A and G land sequentially** - both edit `buildRecommendations` / `IndexCheckReport`.
- **Unit B refuses the wrong layers explicitly**: no guard in `fs-atomic` (writes bytes, not notes; 212 call sites), `host-memory-write` (append-only, already rejects empty), or `inline*` (parser / line-preserving insert). The guard docblock records why.
- **Wet-only debt clear is free**: dry-run dream emits no `dream` log event, so `last_dream_at` cannot move on a preview - pinned by a test rather than implemented as a mechanism.

## File changes

New: `src/core/reconciliation-report.ts` (core root - its consumers span the search layer (G) and the brain layer (E, F)), `src/core/brain/notes/blank-overwrite-guard.ts`, `src/core/search/store/` count query beside `findChunksWithoutEmbeddings`, sessions checkpoint extension, dead-letter store module, restamp CLI verb file, `tests/core/architecture/visibility-surface-census.test.ts`.
Modified: `write-batch.ts`, `log.ts`, `signal.ts`, `continuity/store.ts`, `notes/create-note.ts` (envelope option only), `status.ts`, `indexer.ts` (`buildRecommendations`, `IndexCheckReport`), `serialize.ts`, `search/verbs/check.ts` output, `rollup-ladder.ts` / `diarization.ts` / `design-note.ts` (consumer envelope types), `sessions/import.ts`, `mcp` schemas for `allow_empty`, `command-manifest.ts` + help text (restamp verb), `state/surfaces.ts` (+1 or +2 rows), write-site census (boundary assertion), verdict-vocabulary census (reconciliation vocabulary), docs.

## Risks and open questions

- The stale-recommendation pin tests that assert today's (wrong) "compute the first vectors" behavior will move - that movement is the fix, not a regression; expect and rename them.
- Signals gain a frontmatter key (`origin_channel`) - fixtures, `schema_inspect` vocabulary, and the frontmatter-key allowlist all move together or the wave fails its own parity gates.
- The sessions checkpoint may fold under the existing ingest-checkpoints STATE_SURFACES row or need its own - verify the existing row's key-shape coverage rather than assuming (recon flagged this explicitly).
- Unit H's census must enumerate the knowledge lane honestly; a census that quietly omits a surface reproduces the defect it documents.
