# Design - Ingestion & Import Robustness

## Problem

Open Second Brain's ingestion/import pipeline has four concrete gaps, all in
the same subsystem:

1. **No within-pass resumability.** A large folder ingest is planned by
   `planBatches` and dispatched batch-by-batch; the content-hash manifest only
   records a source once its full `ingestSource` write lands. An interruption
   mid-plan leaves no durable ledger of *which planned items already completed*
   beyond what the manifest happens to have flushed - a resumed plan re-derives
   its work list from scratch, and the caller has no plan-scoped progress signal.
2. **Only the `claude` memory backend is importable.** The `MemorySourceBackend`
   registry exposes exactly one adapter, so a user migrating off mem0 (a popular
   agent-memory store) or holding a generic memory-store JSON dump has no path
   into Brain preferences.
3. **No cheap freshness gate on deterministic refresh.** `clusters run`
   re-materializes `Brain/clusters/` from the whole vault on every invocation.
   An agent that wants "refresh-on-demand at the start of graph work" must pay a
   full recompute even when nothing changed.
4. **No command turns a source into citeable atomic claims.** The block-id
   wikilink parser, source sha256 provenance, and session-summary lineage all
   exist, but nothing composes them into a distillation of a source into
   discrete, block-traceable claims.

## Scope

- `t_ba1fa5f6` Incremental per-item checkpointing (resumable batch ingest).
- `t_ac9d2588` mem0 / generic-JSON importers on the `MemorySourceBackend` seam.
- `t_845fe240` Staleness fast-path (`--if-stale`) for `clusters run`.
- `t_2e2e959f` Source distillation into atomic claims with block-level provenance.

## Out of scope

- Granola connector (`t_df66855f`) and ZeroEntropy provider (`t_8d49f059`) -
  distinct subsystems (connector family / embedding-provider family).
- Onboarding checklist (`t_84500f39`), LoCoMo eval (`t_8dabe2b0`) - unrelated themes.
- Applying the staleness gate to the `dream` learning pass: `dream` is not a
  clean input-mtime->output-mtime materialization (it reads log events and
  signals and already carries extensive content-hash no-op idempotency). Forcing
  an mtime gate onto it would be a misfit, not a completion. The gate is built
  as a reusable primitive; only the deterministic materialize path (`clusters
  run`) is wired in this release.
- Any model call in the deterministic core (unchanged invariant: the kernel
  calls no LLM; agents supply extractions/claims).

## Chosen approach

Variant 1 (compose on existing seams). See `variants.md`.

### Card 1 - Incremental per-item checkpointing

New module `src/core/brain/ingest/checkpoint.ts`, modeled on
`content-manifest.ts`:

- `IngestCheckpoint = { schema_version: 1, plan_id, source_dir, completed: string[], updated_at }`.
- `computePlanId(sourceDir, discoveredPaths)` - short SHA-256 hex over the
  canonical `sourceDir` and the sorted full discovered path set, so the id is
  stable across resume even as the remaining set shrinks.
- `checkpointPath(vault, planId)` -> `<vault>/.open-second-brain/ingest-checkpoints/<plan_id>.json`
  (a machine artifact, not curated memory - mirrors the manifest location).
- `readCheckpoint`, `recordCompleted` (union-as-you-go, atomic, byte-identity
  no-op skip), `clearCheckpoint`. A corrupt file or unknown `schema_version` is a
  hard error, never a silent reset (mirrors `readManifest`).
- Opt-out env `OSB_INGEST_NO_CHECKPOINT` (truthy) makes record/read inert -
  the deterministic-test escape hatch mirroring upstream's
  `GRAPHIFY_NO_INCREMENTAL_CACHE`.

Wiring:
- `planBatches` gains `opts.resume?: boolean`. When resuming it computes the
  stable `planId` from the full discovered set, reads the checkpoint, and
  excludes already-completed paths *before* content-hash classification - so a
  resumed plan never re-hashes completed items (the fast-path that keeps a
  large-vault resume near-free). The content manifest stays authoritative for
  everything the checkpoint does not cover. `BatchPlan` gains `planId` and
  `resumedCompleted` (count excluded via the checkpoint).
- `ingestSource` gains `opts.planId?: string`. On a successful ingest of a
  vault-file source, when a `planId` is set and checkpointing is enabled, it
  records the source path into that plan's checkpoint. The content manifest stays
  the authoritative final state; the checkpoint is plan-scoped progress.
- MCP `brain_ingest_batch_plan` gains `resume` (bool) and returns `plan_id` +
  `resumed_completed`; when a resumed plan comes back empty (fully drained) it
  clears the checkpoint (authoritative-final cleanup). `brain_ingest_source`
  gains an optional `plan_id`.
- CLI `brain batch-plan` gains `--resume` and prints the `plan_id`.

### Card 2 - mem0 / generic-JSON importers

The current seam is one-file-one-entry (`readdirSync` `*.md`, one
`parseMemoryFile(text)` -> one entry). mem0 and generic exports are one JSON
file holding many records, so the seam is generalized (not worked around):

- `MemorySourceBackend` gains `discoverMemoryFiles(dir): string[]` (default:
  sorted `*.md`, excluding `MEMORY.md`) and `parseMemoryEntries(text):
  MemorySourceParse[]` (0..N). The `claude` backend implements
  `discoverMemoryFiles` as today's `*.md` walk and `parseMemoryEntries` as a
  single-element wrap of `parseClaudeMemoryFile` - byte-identical output,
  regression-pinned.
- `import-claude-memory.ts` iterates `discoverMemoryFiles` then flattens
  `parseMemoryEntries`; the manifest/dedup key becomes `basename` for
  single-entry files and `basename#<slug>` for multi-entry files, so one JSON
  file mapping to many preferences is tracked per entry without collisions.
- New backends:
  - `agent-backend/mem0.ts` (id `mem0`): parses a mem0 export - a top-level
    array, or `{results|memories: [...]}`. Each record maps `memory|text|data` ->
    body, `id|name` -> name, `metadata.description` (or a truncated body) ->
    description. Structure-only; no natural-language gating.
  - `agent-backend/generic.ts` (id `generic`): a documented neutral schema - an
    array of `{ name, description, body }` objects (the catch-all dump format).
- Registry entries added; `--from <id>` / `--backend <id>` selector added to the
  `import-claude-memory` CLI verb (overrides the `memory_backend` config key);
  unknown id fails loudly with the registered list (existing `getMemoryBackend`).

### Card 3 - Staleness fast-path

New `src/core/brain/staleness.ts`:
- `newestMtimeMs(paths)` / `oldestMtimeMs(paths)` and
  `evaluateStaleness({inputs, outputs}): { fresh, newest_input_ms, oldest_output_ms }`.
  Fresh iff outputs is non-empty AND every output's mtime >= every input's mtime.

`clusters run` gains `--if-stale`: inputs = `listVaultPages(vault)`, outputs =
`Brain/clusters/*.md`. When fresh it prints a freshness-skip line, appends a
`communities` metric tagged `skipped: "fresh"`, and returns 0 without opening the
store or recomputing. Otherwise it runs as today.

### Card 4 - Source distillation

New `src/core/brain/distill/distill-source.ts`:
- `distillSource(vault, { sourcePath, claims, agent, now })` where `claims` is a
  non-empty list of `{ text, block? }`. Provider-agnostic: the agent supplies the
  atomic claims and the block ids; the core runs no model.
- Validates each claim has non-empty text; block ids are validated structurally
  via `parseWikilinkRich` (no vocabulary gating).
- Writes `Brain/distillations/dist-<slug>-<hash>.md`: frontmatter
  (`kind: brain-distillation`, `source_path`, `source_hash`, `provenance`,
  `created_at`/`updated_at`, `tags`), body = a `## Claims` section (one bullet per
  claim, each carrying `[[<source>#^<block>]]` when a block is given) plus the
  shared `## Sources` provenance section. Idempotent on the source identity hash;
  a byte-identical re-run is a no-op (mirrors `ingestSource`).
- New `BRAIN_DISTILLATIONS_REL` + `distillationPagePath(vault, slug)` in `paths.ts`.
- CLI verb `o2b brain distill` and MCP tool `brain_distill_source`.

## Design decisions

- **Content manifest stays authoritative; the checkpoint is plan-scoped
  progress.** Avoids two competing sources of truth for "is this source done."
- **`planId` keys on the full discovered set, not the remaining set**, so it is
  stable across resume.
- **The `claude` backend must stay byte-identical** through the seam widening -
  enforced by a regression test, matching the existing contract in
  `agent-backend/claude.ts`.
- **Staleness is not applied to `dream`** (justified under Out of scope).
- **Distillation composes existing primitives** (`parseWikilinkRich`,
  `provenance`) rather than re-deriving them.
- **All new machine artifacts live under `.open-second-brain/`**, all new curated
  pages under `Brain/`, consistent with existing layout.

## File changes

New:
- `src/core/brain/ingest/checkpoint.ts`
- `src/core/brain/agent-backend/mem0.ts`, `.../generic.ts`
- `src/core/brain/staleness.ts`
- `src/core/brain/distill/distill-source.ts`
- `src/cli/brain/verbs/distill.ts`
- `src/mcp/brain/distill-tools.ts` (or fold `brain_distill_source` into an existing group)
- tests mirroring each new module + CLI + MCP surface.

Modified:
- `src/core/brain/agent-backend/types.ts` (seam widening)
- `src/core/brain/agent-backend/claude.ts` (implement new methods, byte-identical)
- `src/core/brain/agent-backend/registry.ts` (register mem0, generic)
- `src/core/brain/import-claude-memory.ts` (collection-aware iteration + keys)
- `src/cli/brain/verbs/import-claude-memory.ts` (`--from`/`--backend`)
- `src/core/brain/ingest/batch-plan.ts` (`resume`, `planId`)
- `src/core/brain/ingest/ingest.ts` (`planId` completion recording)
- `src/mcp/brain/ingest-tools.ts` (`resume`, `plan_id`, `brain_ingest_source` `plan_id`)
- `src/cli/brain/verbs/batch-plan.ts` (`--resume`)
- `src/cli/brain/verbs/clusters.ts` (`--if-stale`)
- `src/core/brain/paths.ts` (distillations path)
- CLI/MCP registration for the new `distill` verb/tool.
- `CHANGELOG.md`, `package.json` (version bump), version mirrors via `sync-version.ts`.

## Risks

- **Seam widening regressions** on the `claude` import path - mitigated by a
  byte-identity regression test and by keeping `parseMemoryEntries` a thin wrap.
- **Manifest key change** for multi-entry files could collide - mitigated by the
  `basename#<slug>` scheme and the existing duplicate-prefId guard.
- **mtime coarseness** on fast filesystems could mark just-written outputs
  "fresh" against a same-second input change - mitigated by `>=` semantics that
  err toward recompute only when an input is strictly newer, and the gate is
  opt-in (`--if-stale`), never the default.
- **Distillation page proliferation** - mitigated by idempotency on the source
  identity hash (one source -> one page, rewritten in place).
