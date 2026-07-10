# Implementation Plan - Ingestion & Import Robustness

TDD throughout: write the failing test first, watch it fail, then the minimal
code to pass. Keep `bun run validate` at zero warnings after every card.

---

## Card t_ba1fa5f6 - Incremental per-item checkpointing

**Files**
- New: `src/core/brain/ingest/checkpoint.ts`
- Modified: `src/core/brain/ingest/batch-plan.ts`, `src/core/brain/ingest/ingest.ts`,
  `src/mcp/brain/ingest-tools.ts`, `src/cli/brain/verbs/batch-plan.ts`
- Tests: `tests/core/brain/ingest/checkpoint.test.ts`,
  extend `tests/core/brain/ingest/batch-plan*.test.ts`, ingest + MCP tests.

**Acceptance**
- `recordCompleted` unions items across calls, writes atomically, and is a
  byte-identity no-op on a re-record of the same set.
- A corrupt checkpoint / unknown `schema_version` throws (no silent reset).
- `planBatches(..., { resume: true })` on a folder whose checkpoint records K of
  the N new/modified items returns a plan covering exactly the remaining N-K
  items and reports `resumedCompleted = K`; the `planId` is identical to the
  pre-interruption plan id.
- `OSB_INGEST_NO_CHECKPOINT=1` makes record/read inert (plan resumes nothing).
- `ingestSource(..., { planId })` records the ingested source into that plan's
  checkpoint on success; without `planId` no checkpoint is written.

**Depends on:** content-manifest (shipped).

---

## Card t_ac9d2588 - mem0 / generic-JSON importers

**Files**
- New: `src/core/brain/agent-backend/mem0.ts`, `src/core/brain/agent-backend/generic.ts`
- Modified: `src/core/brain/agent-backend/types.ts`,
  `src/core/brain/agent-backend/claude.ts`,
  `src/core/brain/agent-backend/registry.ts`,
  `src/core/brain/import-claude-memory.ts`,
  `src/cli/brain/verbs/import-claude-memory.ts`
- Tests: `tests/core/brain/agent-backend/mem0.test.ts`, `.../generic.test.ts`,
  claude byte-identity regression, orchestrator multi-entry test, CLI `--from` test.

**Acceptance**
- The `claude` backend's import output is byte-identical to the pre-change path
  for the existing orchestrator fixtures (regression pinned).
- `import --from mem0 --memory <mem0-export.json> --dry-run` plans one preference
  per mem0 record (array and `{results:[...]}` shapes both parse); non-mapping
  records skip with a clear reason.
- `import --from generic --memory <dump.json> --dry-run` plans one preference per
  `{name, description, body}` object.
- `getMemoryBackend("nope")` / `--from nope` fails loudly listing registered ids.
- Two entries in one JSON file that slugify to the same pref id: one applies, the
  other lands in `skipped` with the duplicate reason (existing guard holds).

**Depends on:** `MemorySourceBackend` seam (shipped) - widened here.

---

## Card t_845fe240 - Staleness fast-path (`--if-stale`)

**Files**
- New: `src/core/brain/staleness.ts`
- Modified: `src/cli/brain/verbs/clusters.ts`
- Tests: `tests/core/brain/staleness.test.ts`, `tests/cli/brain-clusters-if-stale.test.ts`.

**Acceptance**
- `evaluateStaleness` returns `fresh: false` when outputs is empty; `fresh: true`
  iff every output mtime >= every input mtime.
- `clusters run --if-stale` with cluster notes newer than every vault page
  no-ops: exit 0, no store open, a `communities` metric tagged `skipped: "fresh"`
  is appended, and no cluster note is rewritten.
- After touching a vault page so an input is newer than the outputs,
  `clusters run --if-stale` recomputes as normal.
- `clusters run` without `--if-stale` is unchanged.

**Depends on:** clusters materialize path (shipped).

---

## Card t_2e2e959f - Source distillation

**Files**
- New: `src/core/brain/distill/distill-source.ts`, `src/cli/brain/verbs/distill.ts`,
  MCP tool `brain_distill_source`
- Modified: `src/core/brain/paths.ts`, CLI + MCP registration
- Tests: `tests/core/brain/distill/distill-source.test.ts`,
  `tests/cli/brain-distill.test.ts`, `tests/mcp/distill-tool.test.ts`.

**Acceptance**
- `distillSource` with two claims (one carrying a block id) writes a
  `brain-distillation` page with two atomic-claim bullets; the block-bearing
  claim renders `[[<source>#^<block>]]`; the `source_hash` equals sha256 of the
  source bytes; a `## Sources` section links the source.
- Empty claims list, or a claim with empty text, is rejected (no page written).
- Re-running with identical input is a byte-identity no-op; re-running with a
  changed claim rewrites the same page in place (idempotent on source identity).
- `o2b brain distill` (CLI) and `brain_distill_source` (MCP) drive the same core
  and return the summary page path.

**Depends on:** `parseWikilinkRich`, `provenance` (shipped).

---

## Sequencing

1. Card t_ba1fa5f6 (checkpoint core -> batch-plan/ingest wiring -> MCP/CLI).
2. Card t_ac9d2588 (seam widen + claude regression -> mem0/generic -> CLI `--from`).
3. Card t_845fe240 (staleness primitive -> clusters `--if-stale`).
4. Card t_2e2e959f (distill core -> paths -> CLI/MCP).
5. Docs + version bump (`1.27.0`, minor) in the same branch/PR.

Each card is committed as its own logical unit with a conventional-commit message.
