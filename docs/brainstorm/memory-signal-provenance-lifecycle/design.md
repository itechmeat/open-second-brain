# Design — memory-signal provenance and lifecycle integrity

Branch: `feat/memory-signal-provenance-lifecycle`
Slug: `memory-signal-provenance-lifecycle`

Cards (13), grouped by axis:

- **Axis A — provenance / event-time**
  - A1 `t_c5184fd8` (p4) — content-hash skip-unchanged manifest
  - A2 `t_7526e8d3` (p4) — per-row event-time on batch remember/import
- **Axis B — ingest parallelism**
  - A3 `t_9eeb8ca2` (p2) — batch-plan step (child of A1)
- **Axis C — write idempotency & lifecycle**
  - C1 `t_213f356b` (p3) — idempotent writes via client idempotency keys
  - C2 `t_2c6cf3e2` (p3) — dry-run extraction preview
  - C3 `t_92317f91` (p3) — bounded verbatim last-N-turns buffer
  - C4 `t_1a3a9eba` (p3) — batch checkpoint save for whole sessions
  - C5 `t_a82b674e` (p3) — caller-settable per-memory expiration date
  - C6 `t_edde2198` (p3) — delete and search by exact source file
- **Axis D — intellectual-honesty detection**
  - D1 `t_4678a91a` (p4) — signed source-diversity grounding score
  - D2 `t_11e3db8b` (p3) — note-position contradiction detection
  - D3 `t_74d29363` (p2) — declared-thesis register monitor (child of D2)
- **Axis E — runtime lifecycle**
  - E1 `t_1c894c19` (p4) — session-bracketing memory wrapper for Aider

## Problem

o2b's memory layer is strong on deterministic curation and recall precision but
weak on five integrity gaps that this release closes in one coherent scope:

1. **Re-ingest is mtime-driven, not content-driven.** `sourceIdentityHash`
   computes SHA-256 for source *identity* (one source path → one summary page)
   but there is no timestamp-independent "this source is byte-identical, skip the
   LLM pass" signal, so a `git checkout` / NFS touch / checkout-based restore
   forces full re-ingest of every source. (A1)
2. **Backfilled signals are mis-stamped with the import moment.** OSB has the
   bi-temporal *concept* on the read-side (`readBiTemporalSlots()` parses
   `valid_from`/`valid_until`/`recorded_at`; `reconcile-domains.ts` prefers
   `recorded_at if present else created_at`) but the WRITE side exposes only
   `created_at`/`date` on `WriteSignalInput`, and session-import stamps the
   import wall-clock even though `SessionTurn.timestamp` already carries the
   original turn's ISO-8601. Recency reasoning and bi-temporal reconciliation
   are therefore fed corrupt timestamps on backfill. (A2)
3. **Writes are not idempotent under retry, and dedupe is implicit.** Multi-
   runtime feedback writes are file-appending Markdown (`appendBrainNote`/
   `appendLogEvent`), so a retried/double-delivered tool call appends a
   duplicate; and the slug allocator (`allocateSlug` in `paths.ts`) disambiguates
   collisions with a `-2`/`-3` suffix rather than recognizing the same logical
   content, so a retried `writeSignal`/`writePreference` creates a distinct
   duplicate file rather than a no-op. There is no explicit client idempotency
   key and no payload-mismatch rejection. (C1)
4. **Extraction is write-committing with no safe preview, and there is no
   surgical cleanup of a contaminated source.** `pre_compact_extract` / ingest
   are fail-fast and mutate `Brain/` immediately — there is no faithful dry-run
   path (C2). Conversely there is no `delete_by_source` command to remove every
   derived entry for a polluting source file including index artifacts (C6).
   Compaction also loses the exact recent wording (C3). And there is no caller
   time-box on a memory (C5) nor a whole-session atomic checkpoint (C4).
5. **Disagreement and self-contradiction are preserved but unquantified and
   prose-blind.** The truth ledger marks a slot CONTESTED (binary,
   `resolution: ask_user`) when independent sources disagree within a window,
   but cannot say WHICH side carries more independent support, nor distinguish
   "agreed by 1 source" from "agreed by 10" — no signed, source-diversity-
   weighted grounding score (D1). Detection stops at confirmed preferences and
   fact claim-slots; the operator's own contradictory *positions* held across
   note prose are never surfaced (D2), and there is no declared-thesis register
   to evaluate incoming notes against standing positions (D3). Finally, the
   Aider runtime has no session write-back loop at all (E1).

This release closes all five gaps with deterministic, additive, byte-identical-
when-off capabilities that REUSE existing hashing, frontmatter, claim-ledger, and
lifecycle machinery.

## Scope

All 13 cards ship in this release, driven one at a time on the shared branch.
Four p4 anchors lead: A1, A2, D1, E1. The p3 cards cohere the lifecycle and
write-integrity layer; the two p2 capstones (A3 batch-plan, D3 thesis monitor)
land last as they depend on their parents.

## Out of scope

- **Any LLM inside kernel logic.** Every score, detector, planner, and lifecycle
  rule is deterministic (hashing, token overlap, date math, counting). An agent
  drives extraction/ingest; o2b owns the deterministic half.
- **Mutating the append-only claim ledger.** D1's grounding score is a derived
  projection over `ClaimEvent`s; truth history is never rewritten — exactly the
  discipline `conflicts.ts` already follows (`computeTruthStateWithConflicts`
  returns a projection, never mutates events).
- **Auto-resolution of any detected contradiction.** D1, D2, D3 all emit
  `ask_user`-style findings; the operator resolves, never the kernel.
- **Auto-deletion of original user notes.** C6 deletes only *derived* entries;
  original notes are removed only when an explicit flag requests it. Dry-run
  reports blast radius first.
- **A global dry-run wrapper.** C2 mirrors the existing per-surface
  `opts.dryRun` idiom already in `import.ts`; it does not introduce a
  process-wide preview switch that would risk a leaky abstraction across
  dream/retire triggers.
- **Migrating existing Markdown.** Every new frontmatter field is additive and
  optional; existing signals/preferences stay byte-identical (absent by default).
- **A new daemon or hosted service.** E1's Aider bracketing is a CLI wrapper
  process around the Aider binary (MCP/hooks are unavailable for Aider); C3's
  verbatim buffer is a bounded continuity-store artifact, not a running server.
- **The onboarding card `t_84500f39`** (off-theme) and the meta-blocked
  `t_2c8448bb` (blocked by umbrella `t_9935bd26`) — explicitly excluded from
  this release's scope selection.

## Chosen approach

**Variant 3 — topological hybrid: shared seams only at composition edges.**

Extract shared infrastructure ONLY where a hard dependency mandates it — A1 ships
the content-hash manifest as a real module because A3 consumes it, C1 ships the
key→content-hash idempotency ledger as a real module because C4 consumes it — and
keep every other card a self-contained vertical. Drive in a topological order
that serializes every shared-file collision and honors all three parent→child
edges (A1→A3, C1→C4, D2→D3). Dry-run (C2) stays a per-surface parameter mirroring
the existing `import.ts` `opts.dryRun` idiom, never a global wrapper.

This captures exactly the reuse that is real and validated by an immediate
consumer, without either front-loading a speculative full substrate (Variant 1 —
which couples the p4 anchors to p2 capstones through APIs designed before their
only consumers exist) or refusing to extract even the two mandated modules
(Variant 2 — a false economy, since the hard edges force reuse regardless and
implicit reuse produces exactly the dual-hash / dual-idempotency drift this
release exists to eliminate).

### Drive order: A1 → C1 → A2 → D2 → D1 → E1 → C2 → C3 → C5 → C6 → A3 → C4 → D3

Resolves all five shared-file collisions and all three composition edges:

- **A1 → A3** (`ingest.ts` + the manifest module): A1 lands the manifest; A3
  consumes `classifyPaths`/`cache-hash`. Hard dependency, serialized.
- **A2 → C2** (`import.ts`): A2 settles the `emit` path's event-time (prefers
  `SessionTurn.timestamp`), then C2 gates the same `emit` path with a dry-run
  short-circuit. Disjoint concerns in the same file, sequenced.
- **C1 → C4** (idempotency ledger): C1 lands the ledger module; C4's checkpoint
  reuses the key→content-hash substrate for session-id+hash idempotency. Hard
  dependency.
- **D2 → D3** (`contradiction.ts`): D2 adds note-position detection; D3 builds
  the thesis register + incoming-note monitor on top. Hard dependency.
- **D1** owns `truth/{fold,conflicts}.ts` alone — it adds a pure projection
  (`computeGroundingScore`) alongside `computeTruthState`, never mutating the
  fold. No other card touches the truth family.
- **E1** is fully isolated (install adapter + a new wrapper script); no shared
  file with any other card. Driven in the p4 group.

The four p4 anchors (A1, A2, D1, E1) all land before the p3 cohering layer, so
the quick wins never wait on the capstones. The two p2 capstones (A3, D3) land
last, as they depend on their parents and gate branch completion.

## Design decisions

### Shared module 1 — content-hash manifest (lands in A1, consumed by A3)

- New module `src/core/brain/ingest/content-manifest.ts`:
  - `hashFile(absPath)` / `hashTree(dir)` → SHA-256 hex (reuses the same
    `createHash("sha256")` primitive as `sourceIdentityHash`, but over file
    *bytes*, not source-path identity strings). A content hash is intentionally a
    different artifact from the identity hash: identity dedups "is this the same
    logical source"; the content manifest answers "are its bytes unchanged since
    the last ingest".
  - `classifyPaths(vault, paths, manifest)` → `{ new, modified, unchanged,
    missing }` by comparing live hashes against the manifest.
  - `updateManifest(vault, paths)` records post-ingest hashes.
  - Manifest lives at `<vault>/.open-second-brain/ingest-manifest.json` (a
    machine artifact, NOT under `Brain/` — it is not curated memory; consistent
    with the existing `<vault>/.open-second-brain/` install-artifact location the
    Aider sidecar uses). Atomic write; a no-op rerun (all unchanged) rewrites
    nothing.
- `ingest.ts` calls `classifyPaths` before the extraction pass and skips the LLM
  for `unchanged` sources (still idempotently rewrites the summary page only if
  its bytes would change).

### Shared module 2 — idempotency-key ledger (lands in C1, consumed by C4)

- New module `src/core/brain/idempotency-ledger.ts`:
  - `rememberKey(vault, { key, contentHash })` → `inserted | duplicate_match |
    payload_mismatch`. Keyed by client-supplied key → content hash, stored under
    `<vault>/Brain/logs/idempotency/` (month-sharded JSONL, mirroring the
    continuity store's append/list model). Same key + same hash → deduped
    (no-op); same key + different hash → `payload_mismatch` (explicit throw,
    never silent overwrite).
  - `lookupKey(vault, key)` → `{ contentHash } | null` (read for audit/C6).
- `writeSignal` / `writePreference` / `appendApplyEvidence` gain an OPTIONAL
  `idempotency_key?: string` parameter (additive — absent by default, existing
  writes byte-identical). When present, the writer computes the content hash of
  the would-be payload and consults the ledger before writing.
- `brain_feedback` (`feedback-tools.ts`) forwards an optional `idempotency_key`
  argument to the underlying writers.

### A1 — content-hash skip-unchanged manifest (t_c5184fd8)
See shared module 1 above. The manifest is distinct from identity dedup.

### A2 — per-row event-time on batch remember/import (t_7526e8d3)
- `src/core/brain/signal.ts` `WriteSignalInput`: add optional `valid_from?`,
  `recorded_at?` (additive). These flow into the same frontmatter keys
  `readBiTemporalSlots()` already parses, so the read-side needs no change.
  Absent by default → existing signals byte-identical.
- `src/core/brain/sessions/import.ts` `emit`: prefer `SessionTurn.timestamp`
  (when present and parseable) for `created_at`/`recorded_at`, falling back to
  `now` only when absent or unparseable. Guard against future-dated turn
  timestamps during backfill (clamp or skip — deterministic, documented).
- `brain_feedback` / batch import path forwards an optional per-row `event_time`.

### A3 — batch-plan step (t_9eeb8ca2)
- New module `src/core/brain/ingest/batch-plan.ts`: `planBatches(vault,
  sourceDir, { maxBatchBytes, maxBatchFiles })` → discovers ingestible files,
  calls A1's `classifyPaths` to skip `unchanged`, then splits the remainder into
  size+count-bounded batches (deterministic: sort by path, fill greedily to the
  byte cap then the count cap). Returns the batch list for the caller (agent/
  CLI) to dispatch as parallel subagents.
- CLI/MCP reader surfaces the plan. No parallel execution inside the kernel —
  the caller dispatches; o2b only plans (deterministic, no LLM).

### C1 — idempotent writes via client idempotency keys (t_213f356b)
See shared module 2 above. Payload-mismatch is an explicit error.

### C2 — dry-run extraction preview (t_2c6cf3e2)
- Add an optional `dryRun?: boolean` parameter to `extractPreCompactRecords`
  (and the other extraction entry points) mirroring the EXISTING `opts.dryRun`
  pattern in `import.ts`. When true, the function returns the candidate records
  it *would* extract WITHOUT calling `appendContinuityRecord` (no vault mutation,
  no log event, no dream/retire trigger). The returned records are the exact
  objects the real path would append, so preview faithfully predicts real
  extraction.
- `import.ts` already has `opts.dryRun`; C2 generalizes the same short-circuit
  to `pre-compact-extract.ts`. No global wrapper.

### C3 — bounded verbatim last-N-turns buffer (t_92317f91)
- New module `src/core/brain/recent-turns.ts`: a bounded verbatim ring buffer of
  the last N turns (hard cap, default e.g. 20), persisted via the continuity
  store as a new `ContinuityRecordKind` (`recent_turn`, additive — legacy records
  read as v1). `appendRecentTurn(vault, turn)` evicts oldest beyond N; reads are
  bounded. Ephemeral scaffolding, NOT curated memory — clearly separated (its own
  kind, its own reader).
- Optional post-compaction re-surface (opt-in flag) appends the buffer to the
  post-compaction context so the agent can recover "what did the user literally
  say 2-3 turns ago". Default off → byte-identical.

### C4 — batch checkpoint save for whole sessions (t_1a3a9eba)
- New module/MCP tool `brain_session_checkpoint` (or extend `synthesis-tools.ts`)
  that saves a whole session's signals + learning + summary in ONE round-trip.
  Idempotency is session-id + content-hash, reusing C1's idempotency ledger
  (`rememberKey`). If some writes need review (payload mismatch / validation
  failure), the checkpoint returns a `{ status: "ok" | "mixed", partial: [...] }`
  result — never silently drops items.

### C5 — caller-settable per-memory expiration date (t_a82b674e)
- `WritePreferenceInput` / `WriteSignalInput`: add optional ISO
  `expiration_date?` (additive — absent by default, existing records byte-
  identical). Flow into frontmatter.
- Read path (search/list): default silently drops anything past its
  `expiration_date`; an opt-in `showExpired` flag re-includes them for audit.
  Orthogonal to dream's heuristic retirement — an expired-by-date memory is
  filtered, not moved to `Brain/retired/` (audit trail preserved).

### C6 — delete and search by exact source file (t_edde2198)
- Search: add exact `source_file` filter (matches the `[[source-ref]]` /
  `session_ref` / ingest source-link frontmatter).
- Delete: a new `delete_by_source` command that is **dry-run by default** — it
  reports the blast radius (which derived signals/preferences/index entries/
  summary pages trace back to the source) WITHOUT deleting. An explicit
  `--confirm` deletes the derived entries (and index artifacts); original user
  notes are removed ONLY with an explicit `--include-originals` flag. Writes are
  auditable (continuity record of the cleanup).

### D1 — signed source-diversity grounding score (t_4678a91a)
- New module `src/core/brain/truth/grounding.ts`:
  `computeGroundingScore(slot, events)` → `{ score: number (-1.0..+1.0),
  confidence: "high"|"medium"|"low", band: "strongly_supported"|"mixed"|
  "contested"|"contradicted", supportingSources: number,
  contradictingSources: number }`. Computed as a pure projection over the
  `ClaimEvent`s that feed the slot (the same events `computeTruthState` folds),
  so history is never mutated — exactly the `conflicts.ts` discipline.
  - Source-DIVERSITY weighting: confirming vs contradicting evidence is counted
    across INDEPENDENT sources (distinct `source` + `agent`), not raw mention
    count. N mentions in one document count far below N mentions across N
    independent sources (document a weight ceiling; relationship strength
    weights the contribution).
  - Signed: + confirming, − contradicting, magnitude = balance; the separate
    confidence/sufficiency dimension captures how much evidence backs the
    direction (distinct from the signed score).
  - Deterministic: counting + weighting, no LLM.
- Surfaced alongside `computeTruthStateWithConflicts` output; replaces nothing
  (CONTESTED flag stays; the score quantifies it).

### D2 — note-position contradiction detection (t_11e3db8b)
- Extend `src/core/brain/health/contradiction.ts`: add a
  `detectNoteContradictions(notes, opts)` that pairs same-subject permanent notes
  asserting opposite stances. Reuses the existing language-agnostic
  token-overlap (`similarity.ts` `findSimilarPairs`/`tokenise`) + sign machinery,
  but derives position-sign from note PROSE rather than `evidenced_by` signals.
  Emits `ask_user` findings (quote the relevant span from each note); never
  auto-resolves.

### D3 — declared-thesis register with new-note monitor (t_74d29363)
- New module `src/core/brain/health/thesis.ts`: a declared-thesis register
  (operator-recorded positions: statement, supporting evidence, counter-evidence,
  last-updated, falsification "what would make me wrong"). Stored as a dedicated
  frontmatter kind under `Brain/theses/`.
- A monitor evaluates each newly-ingested note against active theses, flagging
  support/contradiction (builds on D2's note-position base). Reuses
  `obligations.ts` cadence machinery for the "not updated in N days" staleness
  check and the thesis-graveyard pass. Suppresses mere added-complexity per the
  article. Alerts when incoming evidence matches a thesis's documented
  falsification scenario.

### E1 — session-bracketing memory wrapper for Aider (t_1c894c19)
- New CLI wrapper `scripts/o2b-aider` (or `o2b aider wrap`) that brackets an
  Aider session: at start it runs the load-half (re-render the static context
  sidecar via the Aider adapter's template path, mirroring Hermes'
  `prefetch()`), execs the Aider binary with the injected `read:` context, and at
  session end runs the write-back half (capture the session and persist it into
  the Brain, mirroring Hermes' `sync_turn()`/`on_session_end()`). Implemented as
  a wrapper process because Aider has no native MCP (the mechanically hard part
  Hindsight solved).
- The static sidecar adapter (`src/core/install/adapters/aider.ts`) is an
  install-time template renderer (writes `<vault>/.open-second-brain/aider-context.md`
  from `templates/install/aider-context.md.tmpl`); it has no runtime capture
  logic today. The wrapper owns both the load-half (re-render sidecar) and the
  write-back half; the adapter stays as the fallback for users who do not run
  through the wrapper. Lifecycle shape mirrors
  `plugins/hermes/provider.py` `prefetch`/`sync_turn`/`on_session_end`.

## File changes (summary; per-card detail in plan.md)

- `src/core/brain/ingest/content-manifest.ts` — NEW (A1, consumed by A3).
- `src/core/brain/ingest/ingest.ts` — classify-before-extract (A1).
- `src/core/brain/ingest/batch-plan.ts` — NEW (A3).
- `src/core/brain/signal.ts` — `WriteSignalInput` `valid_from`/`recorded_at`/
  `expiration_date`/`idempotency_key` (A2, C5, C1).
- `src/core/brain/sessions/import.ts` — emit turn-time (A2) + dry-run (C2).
- `src/core/brain/pre-compact-extract.ts` — `dryRun` parameter (C2).
- `src/core/brain/idempotency-ledger.ts` — NEW (C1, consumed by C4).
- `src/core/brain/preference.ts` — `expiration_date`/`idempotency_key` (C5, C1).
- `src/core/brain/apply-evidence.ts` — `idempotency_key` (C1).
- `src/core/brain/recent-turns.ts` — NEW (C3) + continuity kind.
- `src/core/brain/truth/grounding.ts` — NEW (D1).
- `src/core/brain/truth/{fold,conflicts}.ts` — projection surface (D1).
- `src/core/brain/health/contradiction.ts` — note-position detection (D2).
- `src/core/brain/health/thesis.ts` — NEW (D3).
- `src/core/brain/{search,...}` — `source_file` filter + expiration filter (C6,
  C5).
- `src/mcp/brain/feedback-tools.ts` — `idempotency_key`/`event_time` forwarding
  (A2, C1).
- `src/mcp/brain/synthesis-tools.ts` — batch checkpoint (C4).
- `src/core/install/adapters/aider.ts` + `scripts/o2b-aider` — wrapper (E1).
- `src/core/brain/continuity/types.ts` — `recent_turn` kind (C3).
- Tests under `tests/core/brain/` and `tests/mcp/` per card (TDD).
- `CHANGELOG.md`, relevant docs — document the new surfaces.

## Risks

- **Byte-identity regression (A2/C5/C1).** Any new `WriteSignalInput`/
  `WritePreferenceInput` field that fires by default rewrites every file and
  breaks the determinism + no-op-rerun contract. Mitigation: all new fields are
  optional and absent by default; a dedicated bit-identity test asserts a write
  with the field absent == a write on the old code path.
- **Idempotency-ledger correctness (C1/C4).** A buggy ledger could itself drop
  legitimate writes or false-positive on mismatch. Mitigation: same-key-same-hash
  = deduped no-op; same-key-different-hash = explicit throw; ledger is append-only
  and auditable; C4's checkpoint never silently drops (mixed result reported).
- **Dry-run faithfulness (C2).** A preview that diverges from real extraction is
  worse than no preview. Mitigation: dry-run returns the EXACT records the real
  path would append, short-circuiting ONLY the `appendContinuityRecord` call; a
  parity test asserts dry-run candidates == real-run records for the same input.
- **Grounding-score determinism / no-ledger-mutation (D1).** A score that
  accidentally mutates the append-only ledger, or that is order-sensitive,
  breaks the truth contract. Mitigation: pure projection over the same events
  `computeTruthState` folds; order-insensitive (sort internally like the fold);
  never writes history.
- **Shared-file conflict (import.ts for A2+C2; contradiction.ts for D2+D3;
  ingest.ts for A1+A3).** Mitigation: drive order serializes each pair (A2 then
  C2; D2 then D3; A1 then A3); each worker pulls before starting and builds on
  prior commits.
- **Verbatim hoarding drift (C3).** A buffer that grows unbounded or leaks into
  curated memory violates o2b's deterministic-curation philosophy. Mitigation:
  hard cap on N; its own continuity kind and reader, clearly separated from
  curated memory; post-compaction re-surface is opt-in and default-off.
- **Aider wrapper portability (E1).** A wrapper process that breaks on a future
  Aider release or a non-POSIX shell. Mitigation: keep the static sidecar as the
  documented fallback; the wrapper is opt-in and degrades to the sidecar.
- **Source-cleanup blast radius (C6).** Deleting derived entries for a source
  could remove more than intended. Mitigation: dry-run-by-default reports the
  exact blast radius first; `--confirm` required to delete; originals protected
  unless `--include-originals`.
