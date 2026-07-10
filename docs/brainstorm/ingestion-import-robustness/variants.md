# Variants - Ingestion & Import Robustness

Scope: one coherent release hardening and extending Open Second Brain's
ingestion/import pipeline across four drivable leaf cards:

- `t_ba1fa5f6` (p4) Incremental per-item checkpointing for a resumable batch ingest.
- `t_ac9d2588` (p4) mem0 / generic-JSON memory-store importers on the `MemorySourceBackend` seam.
- `t_845fe240` (p3) Staleness fast-path (`--if-stale`) so a deterministic refresh no-ops when outputs are newer than inputs.
- `t_2e2e959f` (p3) Source distillation into citeable atomic claims with block-level provenance.

All four live in the same subsystem: `ingest/`, `agent-backend/`, the
freshness/materialize paths, and the provenance primitives. Excluded from scope
(distinct subsystems): `t_df66855f` Granola (connector family), `t_8d49f059`
ZeroEntropy (embedding-provider family), `t_84500f39` onboarding and
`t_8dabe2b0` LoCoMo (unrelated single-theme p4 cards).

---

## Variant 1 - Compose on existing seams (in-place extension)

**Approach.** Deliver each card by extending the seam the codebase already
exposes, adding at most one new module per capability and never a new
orchestration layer.

- Checkpointing: a standalone `ingest/checkpoint.ts` (mirrors `content-manifest.ts`
  file/format conventions); `planBatches` gains an optional `resume`, `ingestSource`
  gains an optional `planId` that records completion union-as-you-go as a side
  effect of the write it already performs. Content manifest stays authoritative.
- Importers: generalize `MemorySourceBackend` from one-file-one-entry to
  discover-files + parse-entries (0..N), keeping the `claude` backend
  byte-identical; add `mem0` and `generic` backend modules and register them;
  add a `--from` CLI selector.
- Staleness: a shared `staleness.ts` mtime gate; wire `--if-stale` into
  `clusters run` (the deterministic materialize path anchored by the card).
- Distillation: a `distill/` core that composes `parseWikilinkRich` (block ids),
  `provenance` (source sha256, Sources section), and the source-page idempotency
  idiom; add a CLI verb and an MCP tool.

**Trade-offs.** Matches every established repo pattern (registry seam, atomic
machine artifacts under `.open-second-brain/`, provider-agnostic model-free
core, idempotent page writes). Smallest blast radius, cleanest TDD, each card
independently testable. The `MemorySourceBackend` widening is the only shared
contract change and is covered by a claude-backend byte-identity regression.

**Complexity:** medium. **Risk:** low.

## Variant 2 - Unified ingestion-runner subsystem

**Approach.** Introduce a new `IngestionRunner` abstraction that owns a pass:
checkpoint state, staleness gating, source-backend plugins, and a distill stage
all become steps of one runner object the CLI/MCP drive.

**Trade-offs.** One conceptual surface for "run an ingestion pass"; future
sources/stages plug in uniformly. But it forces a large rewrite of `ingest.ts`,
`batch-plan.ts`, and the clusters/dream paths onto an abstraction none of them
needs today; couples four independent cards into one big-bang change; inflates
the diff and the review surface; and fights the codebase's deliberate
"one narrow module per capability, no speculative coupling" ethos (stated
verbatim in `agent-backend/types.ts`). High regression risk against the existing
no-op idempotency guarantees.

**Complexity:** large. **Risk:** high.

## Variant 3 - Staged independent mini-layers

**Approach.** Ship each card as a fully independent slice with its own module
graph and zero shared helpers, sequenced on the branch but not cross-composed
(e.g. distillation builds its own block-parse and provenance helpers rather than
reusing `parseWikilinkRich` / `provenance.ts`; staleness inlines its own mtime
logic in the clusters verb).

**Trade-offs.** Maximum isolation between cards, so a problem in one cannot touch
another. But it duplicates logic the repo already has (block parsing, provenance
rendering, mtime helpers), violating DRY, and leaves the release feeling like
four unrelated patches rather than one coherent subsystem hardening. Higher
long-term maintenance cost and more code to test for the same behavior.

**Complexity:** medium. **Risk:** medium (duplication-driven drift).

---

## Recommended: Variant 1

Variant 1 is the only option that honors the codebase's explicit design
principles - narrow modules on existing seams, model-free deterministic core,
atomic machine artifacts, idempotent writes - while keeping each card
independently test-driven. Variant 2's runner is speculative coupling the code
comments already warn against; Variant 3 re-implements primitives the repo
already ships. Variant 1 delivers the full scope (no half-fixes) at the lowest
regression risk against the existing no-op/idempotency contracts.
